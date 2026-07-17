'use strict';

const { AdmissionOverloadedError, AdmissionUnavailableError } = require('./errors');
const { loadAdmissionLimitsConfig } = require('./admission-limits-config');

function createDeferred() {
  let resolve;
  let reject;
  const promise = new Promise((res, rej) => {
    resolve = res;
    reject = rej;
  });
  return { promise, resolve, reject };
}

function laneLimits(config, lane) {
  if (lane === 'mutation') {
    return {
      globalPending: config.mutationGlobalPending,
      globalRunning: config.mutationGlobalRunning,
      principalPending: config.mutationPrincipalPending,
      principalRunning: config.mutationPrincipalRunning,
    };
  }
  return {
    globalPending: config.readGlobalPending,
    globalRunning: config.readGlobalRunning,
    principalPending: config.readPrincipalPending,
    principalRunning: config.readPrincipalRunning,
  };
}

class RequestAdmissionController {
  constructor(config = loadAdmissionLimitsConfig(), { now = () => Date.now() } = {}) {
    this.config = config;
    this.now = now;
    this.closed = false;
    this.lanes = {
      mutation: this._createLaneState(),
      read: this._createLaneState(),
    };
    this.stats = {
      overloadRejections: 0,
      waitTimeouts: 0,
      waitAborts: 0,
      pendingAgeTimeouts: 0,
      idempotencyBypasses: 0,
      cacheHitBypasses: 0,
      controlBypasses: 0,
    };
  }

  _createLaneState() {
    return {
      globalPending: 0,
      globalRunning: 0,
      principals: new Map(),
      waiters: [],
    };
  }

  _principalBucket(laneState, principal) {
    let bucket = laneState.principals.get(principal);
    if (!bucket) {
      if (laneState.principals.size >= this.config.maxPrincipalEntries) {
        const oldest = laneState.principals.keys().next().value;
        if (oldest != null) laneState.principals.delete(oldest);
      }
      bucket = { pending: 0, running: 0 };
      laneState.principals.set(principal, bucket);
    }
    return bucket;
  }

  endpointWeight(endpoint) {
    const normalized = String(endpoint || '').toLowerCase();
    return this.config.endpointWeights[normalized] ?? this.config.defaultEndpointWeight;
  }

  _effectiveGlobalPendingLimit(limits, control) {
    if (control) return limits.globalPending;
    return Math.max(limits.globalRunning, limits.globalPending - this.config.controlReserve);
  }

  _canStartNow(laneState, limits, principal, weight, control) {
    const bucket = this._principalBucket(laneState, principal);
    const globalPendingLimit = this._effectiveGlobalPendingLimit(limits, control);
    if (laneState.globalPending + weight > globalPendingLimit) return false;
    if (laneState.globalRunning + weight > limits.globalRunning) return false;
    if (bucket.pending + weight > limits.principalPending) return false;
    if (bucket.running + weight > limits.principalRunning) return false;
    if (laneState.waiters.length + laneState.globalPending + weight > this.config.maxPendingDepth) return false;
    return true;
  }

  _reserve(laneState, principal, weight) {
    const bucket = this._principalBucket(laneState, principal);
    laneState.globalPending += weight;
    bucket.pending += weight;
  }

  _promoteToRunning(laneState, principal, weight) {
    const bucket = this._principalBucket(laneState, principal);
    laneState.globalPending -= weight;
    laneState.globalRunning += weight;
    bucket.pending -= weight;
    bucket.running += weight;
  }

  _releasePending(laneState, principal, weight) {
    const bucket = laneState.principals.get(principal);
    if (!bucket) return;
    laneState.globalPending -= weight;
    bucket.pending -= weight;
    if (bucket.pending === 0 && bucket.running === 0) {
      laneState.principals.delete(principal);
    }
  }

  _releaseRunning(laneState, principal, weight) {
    const bucket = laneState.principals.get(principal);
    if (!bucket) return;
    laneState.globalRunning -= weight;
    bucket.running -= weight;
    if (bucket.pending === 0 && bucket.running === 0) {
      laneState.principals.delete(principal);
    }
  }

  _drainLane(lane) {
    const laneState = this.lanes[lane];
    const limits = laneLimits(this.config, lane);
    for (let i = 0; i < laneState.waiters.length;) {
      const waiter = laneState.waiters[i];
      if (!this._canStartNow(laneState, limits, waiter.principal, waiter.weight, waiter.control)) {
        i += 1;
        continue;
      }
      laneState.waiters.splice(i, 1);
      this._promoteToRunning(laneState, waiter.principal, waiter.weight);
      waiter.startedAt = this.now();
      waiter.resolve({
        lane,
        principal: waiter.principal,
        weight: waiter.weight,
        endpoint: waiter.endpoint,
        control: waiter.control,
        startedAt: waiter.startedAt,
        release: () => this.release(waiter.ticket),
        ticket: waiter.ticket,
      });
    }
  }

  _overloadError(retryAfterSeconds = 1) {
    this.stats.overloadRejections += 1;
    return new AdmissionOverloadedError(
      'Request admission limit reached; retry with the same Idempotency-Key for mutations',
      { retryAfterSeconds },
    );
  }

  async acquire({
    lane,
    principal,
    endpoint,
    weight = 1,
    control = false,
    bypass = false,
    signal = null,
    maxWaitMs = this.config.maxWaitMs,
  }) {
    if (bypass || control) {
      if (control) this.stats.controlBypasses += 1;
      return {
        bypass: true,
        lane,
        principal,
        weight,
        endpoint,
        control,
        release() {},
      };
    }
    if (this.closed) {
      throw new AdmissionUnavailableError('Request admission is closed');
    }
    if (lane === 'none') {
      return {
        bypass: true,
        lane,
        principal,
        weight,
        endpoint,
        control,
        release() {},
      };
    }

    const laneState = this.lanes[lane];
    const limits = laneLimits(this.config, lane);
    const effectiveWeight = Math.max(1, Math.min(this.config.maxEndpointWeight, weight));

    if (this._canStartNow(laneState, limits, principal, effectiveWeight, control)) {
      this._reserve(laneState, principal, effectiveWeight);
      this._promoteToRunning(laneState, principal, effectiveWeight);
      const ticket = {
        lane,
        principal,
        weight: effectiveWeight,
        endpoint,
        control,
        startedAt: this.now(),
      };
      return {
        ...ticket,
        ticket,
        release: () => this.release(ticket),
      };
    }

    if (laneState.waiters.length + laneState.globalPending + effectiveWeight > this.config.maxPendingDepth) {
      throw this._overloadError();
    }

    const deferred = createDeferred();
    const enqueuedAt = this.now();
    const ticket = {
      lane,
      principal,
      weight: effectiveWeight,
      endpoint,
      control,
      enqueuedAt,
    };
    const waiter = {
      ...ticket,
      ticket,
      resolve: deferred.resolve,
      reject: deferred.reject,
    };

    let aborted = false;
    const onAbort = () => {
      if (aborted) return;
      aborted = true;
      const index = laneState.waiters.indexOf(waiter);
      if (index >= 0) {
        laneState.waiters.splice(index, 1);
        this._releasePending(laneState, principal, effectiveWeight);
        this.stats.waitAborts += 1;
        deferred.reject(new AdmissionUnavailableError('Client aborted before admission started'));
      }
    };
    if (signal) {
      if (signal.aborted) onAbort();
      else signal.addEventListener('abort', onAbort, { once: true });
    }

    this._reserve(laneState, principal, effectiveWeight);
    laneState.waiters.push(waiter);

    const waitTimer = setTimeout(() => {
      if (aborted) return;
      const index = laneState.waiters.indexOf(waiter);
      if (index >= 0) {
        laneState.waiters.splice(index, 1);
        this._releasePending(laneState, principal, effectiveWeight);
        this.stats.waitTimeouts += 1;
        deferred.reject(this._overloadError(Math.max(1, Math.ceil(maxWaitMs / 1000))));
      }
    }, maxWaitMs);
    waitTimer.unref?.();

    const ageTimer = setInterval(() => {
      if (aborted) return;
      const index = laneState.waiters.indexOf(waiter);
      if (index < 0) {
        clearInterval(ageTimer);
        return;
      }
      if (this.now() - enqueuedAt >= this.config.maxPendingAgeMs) {
        laneState.waiters.splice(index, 1);
        this._releasePending(laneState, principal, effectiveWeight);
        this.stats.pendingAgeTimeouts += 1;
        clearInterval(ageTimer);
        clearTimeout(waitTimer);
        deferred.reject(this._overloadError());
      }
    }, Math.min(250, this.config.maxPendingAgeMs));
    ageTimer.unref?.();

    try {
      const admitted = await deferred.promise;
      clearTimeout(waitTimer);
      clearInterval(ageTimer);
      return admitted;
    } catch (error) {
      clearTimeout(waitTimer);
      clearInterval(ageTimer);
      throw error;
    } finally {
      if (signal) signal.removeEventListener('abort', onAbort);
    }
  }

  release(ticket) {
    if (!ticket || ticket.bypass) return;
    const laneState = this.lanes[ticket.lane];
    this._releaseRunning(laneState, ticket.principal, ticket.weight);
    this._drainLane(ticket.lane);
  }

  closeAdmission() {
    this.closed = true;
    for (const lane of Object.keys(this.lanes)) {
      const laneState = this.lanes[lane];
      const waiters = laneState.waiters.splice(0, laneState.waiters.length);
      for (const waiter of waiters) {
        this._releasePending(laneState, waiter.principal, waiter.weight);
        waiter.reject(new AdmissionUnavailableError('Request admission is closed'));
      }
    }
  }

  noteIdempotencyBypass() {
    this.stats.idempotencyBypasses += 1;
  }

  noteCacheHitBypass() {
    this.stats.cacheHitBypasses += 1;
  }

  getHealth() {
    const laneSummary = {};
    for (const [lane, state] of Object.entries(this.lanes)) {
      laneSummary[lane] = {
        globalPending: state.globalPending,
        globalRunning: state.globalRunning,
        waiters: state.waiters.length,
        principalsTracked: state.principals.size,
      };
    }
    return {
      closed: this.closed,
      maxPendingDepth: this.config.maxPendingDepth,
      controlReserve: this.config.controlReserve,
      lanes: laneSummary,
      stats: { ...this.stats },
    };
  }
}

let defaultController = null;

function getRequestAdmissionController() {
  if (!defaultController) defaultController = new RequestAdmissionController();
  return defaultController;
}

function setRequestAdmissionController(next) {
  defaultController = next;
}

function resetRequestAdmissionController(config) {
  defaultController = new RequestAdmissionController(config);
  return defaultController;
}

module.exports = {
  RequestAdmissionController,
  getRequestAdmissionController,
  resetRequestAdmissionController,
  setRequestAdmissionController,
};
