'use strict';

const { AppError } = require('./errors');
const { createClientAbortSignal } = require('./client-abort-signal');
const { deriveRequestPrincipal } = require('./request-principal');
const {
  classifyMutationRoute,
  classifyReadRoute,
} = require('./admission-route-policy');
const { getRequestAdmissionController, TRAFFIC } = require('./request-admission');
const { IDEMPOTENCY_KEY_RE } = require('./operation-journal');

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

async function withVersionedMutationAdmission(req, res, operationJournal, mutationQueue, fn, {
  isDemo,
  admission = getRequestAdmissionController(),
} = {}) {
  if (isDemo(req)) return fn();

  const key = assertIdempotencyKeyHeader(req);
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
        const { AdmissionUnavailableError } = require('./errors');
        throw new AdmissionUnavailableError('Client aborted before mutation started', {
          lane: 'mutation',
          endpoint: route.endpoint,
        });
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
        const { AdmissionUnavailableError } = require('./errors');
        throw new AdmissionUnavailableError('Client aborted before mutation started', {
          lane: 'mutation',
          endpoint: route.endpoint,
        });
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
          return hit;
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
  runMutationQueue,
  withLegacyMutationAdmission,
  withMutationAdmission,
  withOperationStatusAdmission,
  withReadAdmission,
  withVersionedMutationAdmission,
};
