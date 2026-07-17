'use strict';

const { deriveRequestPrincipal } = require('./request-principal');
const {
  classifyMutationRoute,
  classifyReadRoute,
} = require('./admission-route-policy');
const { getRequestAdmissionController } = require('./request-admission');

function createClientAbortSignal(req) {
  const controller = new AbortController();
  const onClose = () => {
    if (!req.complete) controller.abort();
  };
  req.on('close', onClose);
  return {
    signal: controller.signal,
    dispose() {
      req.off('close', onClose);
    },
  };
}

function shouldBypassMutationAdmission(req, operationJournal, admission, { isDemo }) {
  if (isDemo(req)) return true;
  const key = req.get('Idempotency-Key');
  if (!key) return false;
  const existing = operationJournal.get(key);
  if (existing) {
    admission.noteIdempotencyBypass();
    return true;
  }
  return false;
}

async function withMutationAdmission(req, operationJournal, fn, { isDemo, admission = getRequestAdmissionController() } = {}) {
  const bypass = shouldBypassMutationAdmission(req, operationJournal, admission, { isDemo });
  const route = classifyMutationRoute(req);
  const principal = deriveRequestPrincipal(req);
  const weight = admission.endpointWeight(route.endpoint);
  const abort = createClientAbortSignal(req);
  try {
    const ticket = await admission.acquire({
      lane: 'mutation',
      principal,
      endpoint: route.endpoint,
      weight,
      bypass,
      signal: abort.signal,
    });
    try {
      return await fn();
    } finally {
      ticket.release();
    }
  } finally {
    abort.dispose();
  }
}

async function withReadAdmission(req, actualCoordinator, fn, {
  admission = getRequestAdmissionController(),
  routeSpec = classifyReadRoute(req),
} = {}) {
  if (routeSpec.lane === 'none') return fn();

  let bypass = false;
  if (routeSpec.policy === 'actual-cached' && routeSpec.cacheKey) {
    const hit = actualCoordinator.readCacheEntry(routeSpec.cacheKey);
    if (hit !== undefined) {
      admission.noteCacheHitBypass();
      return hit;
    }
  }

  const principal = deriveRequestPrincipal(req);
  const endpointWeight = admission.endpointWeight(routeSpec.endpoint);
  const totalWeight = Math.max(1, routeSpec.weight || 1) * endpointWeight;
  const abort = createClientAbortSignal(req);
  try {
    const ticket = await admission.acquire({
      lane: routeSpec.lane === 'control' ? 'read' : routeSpec.lane,
      principal,
      endpoint: routeSpec.endpoint,
      weight: totalWeight,
      control: routeSpec.policy === 'control',
      bypass,
      signal: abort.signal,
    });
    try {
      if (abort.signal.aborted) {
        const { AdmissionUnavailableError } = require('./errors');
        throw new AdmissionUnavailableError('Client aborted before read started');
      }
      return await fn();
    } finally {
      ticket.release();
    }
  } finally {
    abort.dispose();
  }
}

async function withOperationStatusAdmission(req, fn, { admission = getRequestAdmissionController() } = {}) {
  const principal = deriveRequestPrincipal(req);
  const routeSpec = classifyReadRoute(req);
  const abort = createClientAbortSignal(req);
  try {
    const ticket = await admission.acquire({
      lane: 'read',
      principal,
      endpoint: routeSpec.endpoint,
      weight: 1,
      control: true,
      signal: abort.signal,
    });
    try {
      return await fn();
    } finally {
      ticket.release();
    }
  } finally {
    abort.dispose();
  }
}

module.exports = {
  createClientAbortSignal,
  shouldBypassMutationAdmission,
  withMutationAdmission,
  withOperationStatusAdmission,
  withReadAdmission,
};
