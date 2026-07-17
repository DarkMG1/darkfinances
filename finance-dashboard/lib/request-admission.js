'use strict';

const { AdmissionOverloadedError, AdmissionUnavailableError } = require('./errors');
const { loadAdmissionLimitsConfig } = require('./admission-limits-config');

const TRAFFIC = Object.freeze({
  ORDINARY: 'ordinary',
  CONTROL: 'control',
  RECOVERY: 'recovery',
  CHEAP: 'cheap',
});

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
      classReserve: {
        [TRAFFIC.CONTROL]: config.controlReserve,
        [TRAFFIC.RECOVERY]: config.recoveryReserve,
      },
      ordinaryCap: config.mutationGlobalPending - config.controlReserve - config.recoveryReserve,
    };
  }
  if (lane === 'lightweight') {
    return {
      globalPending: config.lightweightGlobalPending,
      globalRunning: config.lightweightGlobalRunning,
      principalPending: config.lightweightPrincipalPending,
      principalRunning: config.lightweightPrincipalRunning,
      classReserve: {},
      ordinaryCap: config.lightweightGlobalPending,
    };
  }
  return {
    globalPending: config.readGlobalPending,
    globalRunning: config.readGlobalRunning,
    principalPending: config.readPrincipalPending,
    principalRunning: config.readPrincipalRunning,
    classReserve: {
      [TRAFFIC.CONTROL]: config.controlReserve,
      [TRAFFIC.CHEAP]: config.cheapReserve,
    },
    ordinaryCap: config.readGlobalPending - config.controlReserve - config.cheapReserve,
  };
}

function emptyClassCounters() {
  return {
    [TRAFFIC.ORDINARY]: 0,
    [TRAFFIC.CONTROL]: 0,
    [TRAFFIC.RECOVERY]: 0,
    [TRAFFIC.CHEAP]: 0,
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
      lightweight: this._createLaneState(),
    };
    this.stats = {
      overloadRejections: 0,
      principalMapRejections: 0,
      waitTimeouts: 0,
      waitAborts: 0,
      pendingAgeTimeouts: 0,
      recoveryPeeks: 0,
      recoveryReplays: 0,
      cacheHitAdmissions: 0,
      controlAdmissions: 0,
      cheapAdmissions: 0,
      lightweightAdmissions: 0,
      idempotentReleases: 0,
    };
  }

  _createLaneState() {
    return {
      globalPending: 0,
      globalRunning: 0,
      classPending: emptyClassCounters(),
      classRunning: emptyClassCounters(),
      principals: new Map(),
      waitersByPrincipal: new Map(),
      rrPrincipals: [],
      rrCursor: 0,
      waiterCount: 0,
    };
  }

  _bucketIsActive(bucket) {
    return bucket.pending > 0 || bucket.running > 0;
  }

  _touchPrincipalBucket(laneState, principal) {
    let bucket = laneState.principals.get(principal);
    if (bucket) {
      bucket.lastAccess = this.now();
      laneState.principals.delete(principal);
      laneState.principals.set(principal, bucket);
      return bucket;
    }
    if (laneState.principals.size >= this.config.maxPrincipalEntries) {
      let evictKey = null;
      let evictAccess = Infinity;
      for (const [key, candidate] of laneState.principals) {
        if (this._bucketIsActive(candidate)) continue;
        if (candidate.lastAccess < evictAccess) {
          evictAccess = candidate.lastAccess;
          evictKey = key;
        }
      }
      if (evictKey == null) {
        this.stats.principalMapRejections += 1;
        throw this._overloadError();
      }
      laneState.principals.delete(evictKey);
    }
    bucket = { pending: 0, running: 0, lastAccess: this.now() };
    laneState.principals.set(principal, bucket);
    return bucket;
  }

  _getBucket(laneState, principal) {
    return laneState.principals.get(principal) || null;
  }

  _deleteIdleBucketIfEmpty(laneState, principal) {
    const bucket = laneState.principals.get(principal);
    if (!bucket || this._bucketIsActive(bucket)) return;
    laneState.principals.delete(principal);
  }

  endpointWeight(endpoint) {
    const normalized = String(endpoint || '').toLowerCase();
    return this.config.endpointWeights[normalized] ?? this.config.defaultEndpointWeight;
  }

  _classLimit(limits, trafficClass) {
    if (trafficClass === TRAFFIC.ORDINARY) return limits.ordinaryCap;
    return limits.classReserve[trafficClass] ?? limits.globalPending;
  }

  _classUsage(laneState, trafficClass, running) {
    return running ? laneState.classRunning[trafficClass] : laneState.classPending[trafficClass];
  }

  _canAddRunning(laneState, limits, trafficClass, weight) {
    if (trafficClass === TRAFFIC.ORDINARY) {
      return laneState.classRunning[TRAFFIC.ORDINARY] + weight <= limits.globalRunning;
    }
    const reserve = limits.classReserve[trafficClass];
    if (reserve != null && reserve > 0) {
      return laneState.classRunning[trafficClass] + weight <= reserve;
    }
    return laneState.globalRunning + weight <= limits.globalRunning;
  }

  _canAdmitClass(laneState, limits, trafficClass, weight) {
    const classLimit = this._classLimit(limits, trafficClass);
    const classTotal = this._classUsage(laneState, trafficClass, false)
      + this._classUsage(laneState, trafficClass, true);
    return classTotal + weight <= classLimit;
  }

  _canPromoteWaiter(laneState, limits, waiter) {
    const { principal, weight, trafficClass } = waiter;
    if (!this._canAddRunning(laneState, limits, trafficClass, weight)) return false;
    if (trafficClass === TRAFFIC.ORDINARY) {
      const bucket = this._getBucket(laneState, principal);
      if (bucket && bucket.running + weight > limits.principalRunning) return false;
    }
    return true;
  }

  _canStartNow(laneState, limits, principal, weight, trafficClass) {
    if (laneState.globalPending + weight > limits.globalPending) return false;
    if (!this._canAddRunning(laneState, limits, trafficClass, weight)) return false;
    if (!this._canAdmitClass(laneState, limits, trafficClass, weight)) return false;
    const bucket = this._getBucket(laneState, principal);
    if (trafficClass === TRAFFIC.ORDINARY) {
      if (bucket) {
        if (bucket.pending + weight > limits.principalPending) return false;
        if (bucket.running + weight > limits.principalRunning) return false;
      } else if (weight > limits.principalPending || weight > limits.principalRunning) {
        return false;
      }
    } else if (bucket) {
      if (bucket.pending + weight > limits.principalPending) return false;
    } else if (weight > limits.principalPending) {
      return false;
    }
    if (laneState.globalPending + laneState.globalRunning + weight > this.config.maxPendingDepth) return false;
    return true;
  }

  _reserve(laneState, principal, weight, trafficClass) {
    const bucket = this._touchPrincipalBucket(laneState, principal);
    laneState.globalPending += weight;
    laneState.classPending[trafficClass] += weight;
    bucket.pending += weight;
  }

  _promoteToRunning(laneState, principal, weight, trafficClass) {
    laneState.globalPending -= weight;
    laneState.globalRunning += weight;
    laneState.classPending[trafficClass] -= weight;
    laneState.classRunning[trafficClass] += weight;
    const bucket = laneState.principals.get(principal);
    if (bucket) {
      bucket.pending -= weight;
      bucket.running += weight;
      bucket.lastAccess = this.now();
    }
  }

  _releasePending(laneState, principal, weight, trafficClass) {
    laneState.globalPending = Math.max(0, laneState.globalPending - weight);
    laneState.classPending[trafficClass] = Math.max(0, laneState.classPending[trafficClass] - weight);
    const bucket = laneState.principals.get(principal);
    if (bucket) {
      bucket.pending = Math.max(0, bucket.pending - weight);
      bucket.lastAccess = this.now();
    }
  }

  _releaseRunning(laneState, principal, weight, trafficClass) {
    laneState.globalRunning = Math.max(0, laneState.globalRunning - weight);
    laneState.classRunning[trafficClass] = Math.max(0, laneState.classRunning[trafficClass] - weight);
    const bucket = laneState.principals.get(principal);
    if (bucket) {
      bucket.running = Math.max(0, bucket.running - weight);
      bucket.lastAccess = this.now();
    }
  }

  _makeTicket(lane, principal, weight, endpoint, trafficClass) {
    const ticket = {
      lane,
      principal,
      weight,
      endpoint,
      trafficClass,
      startedAt: this.now(),
      released: false,
    };
    ticket.release = () => this.release(ticket);
    return ticket;
  }

  _resolveWaiter(waiter, laneState) {
    this._promoteToRunning(laneState, waiter.principal, waiter.weight, waiter.trafficClass);
    const ticket = this._makeTicket(
      waiter.lane,
      waiter.principal,
      waiter.weight,
      waiter.endpoint,
      waiter.trafficClass,
    );
    waiter.resolve({
      ...ticket,
      ticket,
    });
  }

  _removeWaiter(laneState, waiter) {
    const queue = laneState.waitersByPrincipal.get(waiter.principal);
    if (!queue) return false;
    const index = queue.indexOf(waiter);
    if (index < 0) return false;
    queue.splice(index, 1);
    laneState.waiterCount -= 1;
    if (queue.length === 0) {
      laneState.waitersByPrincipal.delete(waiter.principal);
      const rrIndex = laneState.rrPrincipals.indexOf(waiter.principal);
      if (rrIndex >= 0) {
        laneState.rrPrincipals.splice(rrIndex, 1);
        if (laneState.rrCursor >= laneState.rrPrincipals.length) {
          laneState.rrCursor = 0;
        }
      }
    }
    return true;
  }

  _enqueueWaiter(laneState, waiter) {
    let queue = laneState.waitersByPrincipal.get(waiter.principal);
    if (!queue) {
      queue = [];
      laneState.waitersByPrincipal.set(waiter.principal, queue);
      laneState.rrPrincipals.push(waiter.principal);
    }
    queue.push(waiter);
    laneState.waiterCount += 1;
  }

  _drainLaneForClass(lane, limits, trafficClass) {
    const laneState = this.lanes[lane];
    for (const [principal, queue] of laneState.waitersByPrincipal) {
      if (!queue.length || queue[0].trafficClass !== trafficClass) continue;
      const waiter = queue[0];
      if (!this._canPromoteWaiter(laneState, limits, waiter)) {
        continue;
      }
      this._removeWaiter(laneState, waiter);
      this._resolveWaiter(waiter, laneState);
      return true;
    }
    return false;
  }

  _drainLaneRoundRobin(lane, limits) {
    const laneState = this.lanes[lane];
    if (laneState.waiterCount === 0 || laneState.rrPrincipals.length === 0) return;

    let scanned = 0;
    const maxScans = laneState.rrPrincipals.length;
    while (laneState.waiterCount > 0 && scanned < maxScans) {
      if (laneState.rrPrincipals.length === 0) break;
      const idx = laneState.rrCursor % laneState.rrPrincipals.length;
      const principal = laneState.rrPrincipals[idx];
      laneState.rrCursor = (idx + 1) % laneState.rrPrincipals.length;
      scanned += 1;

      const queue = laneState.waitersByPrincipal.get(principal);
      if (!queue || queue.length === 0) continue;
      const waiter = queue[0];
      if (!this._canPromoteWaiter(laneState, limits, waiter)) {
        continue;
      }
      this._removeWaiter(laneState, waiter);
      this._resolveWaiter(waiter, laneState);
      scanned = 0;
    }
  }

  _drainLane(lane) {
    const laneState = this.lanes[lane];
    const limits = laneLimits(this.config, lane);
    if (laneState.waiterCount === 0) return;

    const reservedClasses = [TRAFFIC.CONTROL, TRAFFIC.RECOVERY, TRAFFIC.CHEAP];
    let progressed = true;
    while (progressed && laneState.waiterCount > 0) {
      progressed = false;
      for (const trafficClass of reservedClasses) {
        while (this._drainLaneForClass(lane, limits, trafficClass)) {
          progressed = true;
        }
      }
      const before = laneState.waiterCount;
      this._drainLaneRoundRobin(lane, limits);
      if (laneState.waiterCount < before) progressed = true;
    }
  }

  _overloadError(retryAfterSeconds = 1) {
    this.stats.overloadRejections += 1;
    return new AdmissionOverloadedError(
      'Request admission limit reached; retry with the same Idempotency-Key for mutations',
      { retryAfterSeconds },
    );
  }

  _convertTrafficClass(ticket, nextClass) {
    if (ticket.trafficClass === nextClass) return;
    const laneState = this.lanes[ticket.lane];
    const weight = ticket.weight;
    const from = ticket.trafficClass;
    laneState.classRunning[from] = Math.max(0, laneState.classRunning[from] - weight);
    laneState.classRunning[nextClass] += weight;
    ticket.trafficClass = nextClass;
  }

  async acquire({
    lane,
    principal,
    endpoint,
    weight = 1,
    trafficClass = TRAFFIC.ORDINARY,
    signal = null,
    maxWaitMs = this.config.maxWaitMs,
  }) {
    if (this.closed) throw new AdmissionUnavailableError('Request admission is closed');
    if (lane === 'none') {
      return { bypass: true, lane, principal, weight, endpoint, trafficClass, release() {} };
    }

    const laneState = this.lanes[lane];
    if (!laneState) throw new Error(`Unknown admission lane: ${lane}`);
    const limits = laneLimits(this.config, lane);
    const effectiveWeight = Math.max(1, Math.min(this.config.maxEndpointWeight, weight));

    if (trafficClass === TRAFFIC.CONTROL) this.stats.controlAdmissions += 1;
    if (trafficClass === TRAFFIC.CHEAP) this.stats.cheapAdmissions += 1;
    if (lane === 'lightweight') this.stats.lightweightAdmissions += 1;

    if (this._canStartNow(laneState, limits, principal, effectiveWeight, trafficClass)) {
      this._reserve(laneState, principal, effectiveWeight, trafficClass);
      this._promoteToRunning(laneState, principal, effectiveWeight, trafficClass);
      return this._makeTicket(lane, principal, effectiveWeight, endpoint, trafficClass);
    }

    if (!this._canAdmitClass(laneState, limits, trafficClass, effectiveWeight)) {
      throw this._overloadError();
    }

    if (laneState.globalPending + laneState.globalRunning + effectiveWeight > this.config.maxPendingDepth) {
      throw this._overloadError();
    }

    const deferred = createDeferred();
    const enqueuedAt = this.now();
    const ticketRef = {
      lane,
      principal,
      weight: effectiveWeight,
      endpoint,
      trafficClass,
      enqueuedAt,
    };
    const waiter = {
      ...ticketRef,
      ticket: ticketRef,
      resolve: deferred.resolve,
      reject: deferred.reject,
    };

    let aborted = false;
    let waitTimer;
    let ageTimer;
    const cleanupTimers = () => {
      if (waitTimer) clearTimeout(waitTimer);
      if (ageTimer) clearInterval(ageTimer);
      waitTimer = null;
      ageTimer = null;
    };
    const onAbort = () => {
      if (aborted) return;
      aborted = true;
      cleanupTimers();
      if (this._removeWaiter(laneState, waiter)) {
        this._releasePending(laneState, principal, effectiveWeight, trafficClass);
        this.stats.waitAborts += 1;
        deferred.reject(new AdmissionUnavailableError('Client aborted before admission started'));
      }
    };

    if (signal) {
      if (signal.aborted) onAbort();
      else signal.addEventListener('abort', onAbort, { once: true });
    }

    try {
      this._reserve(laneState, principal, effectiveWeight, trafficClass);
      this._enqueueWaiter(laneState, waiter);

      waitTimer = setTimeout(() => {
        if (aborted) return;
        if (!this._removeWaiter(laneState, waiter)) return;
        cleanupTimers();
        this._releasePending(laneState, principal, effectiveWeight, trafficClass);
        this.stats.waitTimeouts += 1;
        deferred.reject(this._overloadError(Math.max(1, Math.ceil(maxWaitMs / 1000))));
      }, maxWaitMs);
      waitTimer.unref?.();

      ageTimer = setInterval(() => {
        if (aborted) return;
        if (this.now() - enqueuedAt < this.config.maxPendingAgeMs) return;
        if (!this._removeWaiter(laneState, waiter)) {
          cleanupTimers();
          return;
        }
        cleanupTimers();
        this._releasePending(laneState, principal, effectiveWeight, trafficClass);
        this.stats.pendingAgeTimeouts += 1;
        deferred.reject(this._overloadError());
      }, Math.min(250, this.config.maxPendingAgeMs));
      ageTimer.unref?.();

      const admitted = await deferred.promise;
      cleanupTimers();
      return admitted;
    } catch (error) {
      cleanupTimers();
      throw error;
    } finally {
      if (signal) signal.removeEventListener('abort', onAbort);
    }
  }

  async acquireMutationWithJournalPeek({
    principal,
    endpoint,
    weight = 1,
    peekJournal,
    signal = null,
    maxWaitMs = this.config.maxWaitMs,
  }) {
    this.stats.recoveryPeeks += 1;
    const ticket = await this.acquire({
      lane: 'mutation',
      principal,
      endpoint,
      weight,
      trafficClass: TRAFFIC.RECOVERY,
      signal,
      maxWaitMs,
    });

    let existing = null;
    try {
      existing = peekJournal();
    } catch (error) {
      ticket.release();
      throw error;
    }

    if (existing) {
      this.stats.recoveryReplays += 1;
      return { ticket, mode: 'recovery', existing };
    }

    const laneState = this.lanes.mutation;
    const limits = laneLimits(this.config, 'mutation');
    if (!this._canAdmitClass(laneState, limits, TRAFFIC.ORDINARY, ticket.weight)) {
      ticket.release();
      throw this._overloadError();
    }
    this._convertTrafficClass(ticket, TRAFFIC.ORDINARY);
    return { ticket, mode: 'ordinary', existing: null };
  }

  release(ticket) {
    if (!ticket || ticket.bypass || ticket.released) {
      if (ticket?.released) this.stats.idempotentReleases += 1;
      return;
    }
    ticket.released = true;
    const laneState = this.lanes[ticket.lane];
    if (!laneState) return;
    this._releaseRunning(laneState, ticket.principal, ticket.weight, ticket.trafficClass);
    this._drainLane(ticket.lane);
  }

  closeAdmission() {
    this.closed = true;
    for (const lane of Object.keys(this.lanes)) {
      const laneState = this.lanes[lane];
      for (const [principal, queue] of laneState.waitersByPrincipal) {
        while (queue.length > 0) {
          const waiter = queue.shift();
          laneState.waiterCount -= 1;
          this._releasePending(laneState, waiter.principal, waiter.weight, waiter.trafficClass);
          waiter.reject(new AdmissionUnavailableError('Request admission is closed'));
        }
        laneState.waitersByPrincipal.delete(principal);
      }
      laneState.rrPrincipals = [];
      laneState.rrCursor = 0;
    }
  }

  getHealth() {
    const laneSummary = {};
    for (const [lane, state] of Object.entries(this.lanes)) {
      laneSummary[lane] = {
        globalPending: state.globalPending,
        globalRunning: state.globalRunning,
        classPending: { ...state.classPending },
        classRunning: { ...state.classRunning },
        waiters: state.waiterCount,
        principalsTracked: state.principals.size,
      };
    }
    return {
      closed: this.closed,
      maxPendingDepth: this.config.maxPendingDepth,
      maxPrincipalEntries: this.config.maxPrincipalEntries,
      controlReserve: this.config.controlReserve,
      recoveryReserve: this.config.recoveryReserve,
      cheapReserve: this.config.cheapReserve,
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
  TRAFFIC,
  getRequestAdmissionController,
  resetRequestAdmissionController,
  setRequestAdmissionController,
};
