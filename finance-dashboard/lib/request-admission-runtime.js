'use strict';

const { AdmissionUnavailableError, AppError } = require('./errors');
const { createClientAbortSignal } = require('./client-abort-signal');
const { deriveRequestPrincipal } = require('./request-principal');
const {
  classifyMutationRoute,
  classifyReadRoute,
} = require('./admission-route-policy');
const { getRequestAdmissionController, TRAFFIC } = require('./request-admission');
const { IDEMPOTENCY_KEY_RE } = require('./operation-journal');

const PRE_BODY_MUTATION_ADMISSION = Symbol('pre-body-mutation-admission');

function assertIdempotencyKeyHeader(req) {
  const key = req.get('Idempotency-Key');
  if (!IDEMPOTENCY_KEY_RE.test(key || '')) {
    throw new AppError('A valid Idempotency-Key header is required', {
      code: 'IDEMPOTENCY_KEY_REQUIRED',
      status: 400,
      expose: true,
    });
  }
  return key;
}

async function runMutationQueue(mutationQueue, fn) {
  return mutationQueue.run(fn);
}

function mutationAbortError(endpoint) {
  return new AdmissionUnavailableError('Client aborted before mutation started', {
    lane: 'mutation',
    endpoint,
  });
}

function attachPreparedMutationAdmission(req, res, {
  abort,
  endpoint,
  idempotencyKey = null,
  ticket,
  versioned,
}) {
  const state = {
    abort,
    claimed: false,
    endpoint,
    idempotencyKey,
    released: false,
    ticket,
    versioned,
  };
  const onResponseDone = () => {
    if (!state.claimed) state.release();
  };
  state.release = () => {
    if (state.released) return;
    state.released = true;
    if (typeof res?.off === 'function') {
      res.off('finish', onResponseDone);
      res.off('close', onResponseDone);
    }
    ticket.release();
    abort.dispose();
    if (req[PRE_BODY_MUTATION_ADMISSION] === state) {
      delete req[PRE_BODY_MUTATION_ADMISSION];
    }
  };
  req[PRE_BODY_MUTATION_ADMISSION] = state;
  if (typeof res?.on === 'function') {
    res.on('finish', onResponseDone);
    res.on('close', onResponseDone);
  }
  return state;
}

function claimPreparedMutationAdmission(req, { versioned, idempotencyKey = null }) {
  const state = req[PRE_BODY_MUTATION_ADMISSION];
  if (!state) return null;
  if (state.versioned !== versioned || (versioned && state.idempotencyKey !== idempotencyKey)) {
    throw new Error('Prepared mutation admission does not match the executing request');
  }
  if (state.claimed) throw new Error('Prepared mutation admission was already claimed');
  state.claimed = true;
  return state;
}

async function runPreparedMutationAdmission(state, mutationQueue, fn) {
  try {
    await Promise.resolve();
    if (state.abort.signal.aborted) throw mutationAbortError(state.endpoint);
    return await runMutationQueue(mutationQueue, fn);
  } finally {
    state.release();
  }
}

async function prepareMutationBodyAdmission(req, res, operationJournal, {
  isDemo,
  isVersioned = false,
  admission = getRequestAdmissionController(),
} = {}) {
  if (isDemo(req)) return null;
  if (req[PRE_BODY_MUTATION_ADMISSION]) return req[PRE_BODY_MUTATION_ADMISSION];

  const idempotencyKey = isVersioned ? assertIdempotencyKeyHeader(req) : null;
  const route = classifyMutationRoute(req);
  const principal = deriveRequestPrincipal(req);
  const weight = admission.endpointWeight(route.endpoint);
  const abort = createClientAbortSignal(req, res);
  let ticket;
  try {
    if (isVersioned) {
      ({ ticket } = await admission.acquireMutationWithJournalPeek({
        principal,
        endpoint: route.endpoint,
        weight,
        peekJournal: () => operationJournal.get(idempotencyKey),
        signal: abort.signal,
      }));
    } else {
      ticket = await admission.acquire({
        lane: 'mutation',
        principal,
        endpoint: route.endpoint,
        weight,
        trafficClass: TRAFFIC.ORDINARY,
        signal: abort.signal,
      });
    }
    if (abort.signal.aborted) {
      ticket.release();
      throw mutationAbortError(route.endpoint);
    }
    return attachPreparedMutationAdmission(req, res, {
      abort,
      endpoint: route.endpoint,
      idempotencyKey,
      ticket,
      versioned: isVersioned,
    });
  } catch (error) {
    abort.dispose();
    throw error;
  }
}

async function withVersionedMutationAdmission(req, res, operationJournal, mutationQueue, fn, {
  isDemo,
  admission = getRequestAdmissionController(),
} = {}) {
  if (isDemo(req)) return fn();

  const key = assertIdempotencyKeyHeader(req);
  const prepared = claimPreparedMutationAdmission(req, {
    versioned: true,
    idempotencyKey: key,
  });
  if (prepared) return runPreparedMutationAdmission(prepared, mutationQueue, fn);

  const route = classifyMutationRoute(req);
  const principal = deriveRequestPrincipal(req);
  const weight = admission.endpointWeight(route.endpoint);
  const abort = createClientAbortSignal(req, res);

  try {
    const { ticket } = await admission.acquireMutationWithJournalPeek({
      principal,
      endpoint: route.endpoint,
      weight,
      peekJournal: () => operationJournal.get(key),
      signal: abort.signal,
    });
    try {
      await Promise.resolve();
      if (abort.signal.aborted) {
        throw mutationAbortError(route.endpoint);
      }
      return await runMutationQueue(mutationQueue, fn);
    } finally {
      ticket.release();
    }
  } finally {
    abort.dispose();
  }
}

async function withLegacyMutationAdmission(req, res, mutationQueue, fn, {
  isDemo,
  admission = getRequestAdmissionController(),
} = {}) {
  if (isDemo(req)) return fn();

  const prepared = claimPreparedMutationAdmission(req, { versioned: false });
  if (prepared) return runPreparedMutationAdmission(prepared, mutationQueue, fn);

  const route = classifyMutationRoute(req);
  const principal = deriveRequestPrincipal(req);
  const weight = admission.endpointWeight(route.endpoint);
  const abort = createClientAbortSignal(req, res);

  try {
    const ticket = await admission.acquire({
      lane: 'mutation',
      principal,
      endpoint: route.endpoint,
      weight,
      trafficClass: TRAFFIC.ORDINARY,
      signal: abort.signal,
    });
    try {
      await Promise.resolve();
      if (abort.signal.aborted) {
        throw mutationAbortError(route.endpoint);
      }
      return await runMutationQueue(mutationQueue, fn);
    } finally {
      ticket.release();
    }
  } finally {
    abort.dispose();
  }
}

async function withMutationAdmission(req, res, operationJournal, mutationQueue, fn, {
  isDemo,
  isVersioned = false,
  admission = getRequestAdmissionController(),
} = {}) {
  if (isVersioned) {
    return withVersionedMutationAdmission(req, res, operationJournal, mutationQueue, fn, { isDemo, admission });
  }
  return withLegacyMutationAdmission(req, res, mutationQueue, fn, { isDemo, admission });
}

async function withReadAdmission(req, res, actualCoordinator, fn, {
  admission = getRequestAdmissionController(),
  onCacheHit = null,
  routeSpec = classifyReadRoute(req),
  signal: externalSignal = null,
} = {}) {
  if (routeSpec.lane === 'none') return fn();

  const principal = deriveRequestPrincipal(req);
  const endpointWeight = admission.endpointWeight(routeSpec.endpoint);
  const totalWeight = Math.max(1, routeSpec.weight || 1) * endpointWeight;
  const abort = externalSignal
    ? { signal: externalSignal, dispose() {} }
    : createClientAbortSignal(req, res);

  let trafficClass = TRAFFIC.ORDINARY;
  let lane = routeSpec.lane;
  if (routeSpec.policy === 'control') trafficClass = TRAFFIC.CONTROL;
  if (routeSpec.policy === 'lightweight-disk') {
    lane = 'lightweight';
    trafficClass = TRAFFIC.ORDINARY;
  }

  if (routeSpec.policy === 'actual-cached' && routeSpec.cacheKey) {
    const hit = actualCoordinator.readCacheEntry(routeSpec.cacheKey);
    if (hit !== undefined) {
      admission.stats.cacheHitAdmissions += 1;
      try {
        const ticket = await admission.acquire({
          lane: 'read',
          principal,
          endpoint: routeSpec.endpoint,
          weight: 1,
          trafficClass: TRAFFIC.CHEAP,
          signal: abort.signal,
        });
        try {
          return onCacheHit ? await onCacheHit(hit) : hit;
        } finally {
          ticket.release();
        }
      } finally {
        abort.dispose();
      }
    }
  }

  try {
    const ticket = await admission.acquire({
      lane,
      principal,
      endpoint: routeSpec.endpoint,
      weight: totalWeight,
      trafficClass,
      signal: abort.signal,
    });
    try {
      if (abort.signal.aborted) {
        const { AdmissionUnavailableError } = require('./errors');
        throw new AdmissionUnavailableError('Client aborted before read started', {
          lane,
          endpoint: routeSpec.endpoint,
          trafficClass,
        });
      }
      return await fn();
    } finally {
      ticket.release();
    }
  } finally {
    abort.dispose();
  }
}

async function withOperationStatusAdmission(req, res, mutationQueue, fn, {
  admission = getRequestAdmissionController(),
} = {}) {
  const principal = deriveRequestPrincipal(req);
  const routeSpec = classifyReadRoute(req);
  const abort = createClientAbortSignal(req, res);
  try {
    const ticket = await admission.acquire({
      lane: 'read',
      principal,
      endpoint: routeSpec.endpoint,
      weight: 1,
      trafficClass: TRAFFIC.CONTROL,
      signal: abort.signal,
    });
    try {
      return await runMutationQueue(mutationQueue, fn);
    } finally {
      ticket.release();
    }
  } finally {
    abort.dispose();
  }
}

module.exports = {
  assertIdempotencyKeyHeader,
  createClientAbortSignal,
  prepareMutationBodyAdmission,
  runMutationQueue,
  withLegacyMutationAdmission,
  withMutationAdmission,
  withOperationStatusAdmission,
  withReadAdmission,
  withVersionedMutationAdmission,
};
