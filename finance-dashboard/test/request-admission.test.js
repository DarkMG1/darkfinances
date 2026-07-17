'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const { SerialQueue } = require('../lib/serial-queue');
const { OperationJournal } = require('../lib/operation-journal');
const { AdmissionOverloadedError, AdmissionUnavailableError } = require('../lib/errors');
const { loadAdmissionLimitsConfig, validateConfig } = require('../lib/admission-limits-config');
const {
  classifyReadRoute,
  classifyMutationRoute,
  actualCacheKeyForRead,
} = require('../lib/admission-route-policy');
const { deriveRequestPrincipal } = require('../lib/request-principal');
const { RequestAdmissionController } = require('../lib/request-admission');
const {
  shouldBypassMutationAdmission,
  withMutationAdmission,
  withReadAdmission,
} = require('../lib/request-admission-runtime');
const { apiErrorBody } = require('../lib/request-envelope');

function createDeferred() {
  let resolve;
  const promise = new Promise((res) => { resolve = res; });
  return { promise, resolve };
}

function tinyConfig(overrides = {}) {
  return validateConfig({
    ...loadAdmissionLimitsConfig({}),
    mutationGlobalPending: 4,
    mutationGlobalRunning: 1,
    mutationPrincipalPending: 2,
    mutationPrincipalRunning: 1,
    readGlobalPending: 4,
    readGlobalRunning: 1,
    readPrincipalPending: 2,
    readPrincipalRunning: 1,
    maxPendingDepth: 4,
    maxPrincipalEntries: 8,
    controlReserve: 1,
    maxWaitMs: 5_000,
    maxPendingAgeMs: 60_000,
    defaultEndpointWeight: 1,
    maxEndpointWeight: 4,
    endpointWeights: Object.create(null),
    ...overrides,
  });
}

function mockReq(overrides = {}) {
  return {
    method: 'GET',
    path: '/api/v1/accounts',
    query: {},
    session: { authenticated: true },
    sessionID: 'sess-test-1',
    complete: false,
    get(name) {
      const headers = overrides.headers || {};
      return headers[name] ?? null;
    },
    on() {},
    off() {},
    ...overrides,
  };
}

test('serial queue rejects work beyond maxPending without growing pending counter', async () => {
  const queue = new SerialQueue('bounded', { maxPending: 1 });
  const gate = createDeferred();
  const first = queue.run(() => gate.promise);
  assert.equal(queue.pending, 1);
  await assert.rejects(queue.run(async () => 'never'), /pending capacity exceeded/);
  assert.equal(queue.pending, 1);
  assert.equal(queue.rejectedOverCapacity, 1);
  gate.resolve('done');
  await first;
  await queue.tail;
  assert.equal(queue.size, 0);
});

test('config validation rejects malformed and unsafe limit env values', () => {
  assert.throws(
    () => loadAdmissionLimitsConfig({ FINANCE_ADMISSION_MUTATION_GLOBAL_PENDING: '0' }),
    /positive integer/,
  );
  assert.throws(
    () => loadAdmissionLimitsConfig({
      FINANCE_ADMISSION_MUTATION_GLOBAL_PENDING: '8',
      FINANCE_ADMISSION_MUTATION_GLOBAL_RUNNING: '16',
    }),
    /running cannot exceed global pending/,
  );
  assert.throws(
    () => loadAdmissionLimitsConfig({ FINANCE_ADMISSION_ENDPOINT_WEIGHTS: 'bad' }),
    /endpoint:weight/,
  );
});

test('principal derives from session or token rather than spoofable client metadata', () => {
  const sessionReq = mockReq({ sessionID: 'abc123' });
  assert.equal(deriveRequestPrincipal(sessionReq), 'session:abc123');
  const tokenReq = mockReq({
    session: {},
    get(name) {
      if (name === 'X-Finance-Token') return 'secret-token';
      return null;
    },
  });
  assert.equal(
    deriveRequestPrincipal(tokenReq, { apiToken: 'secret-token' }),
    'token:api',
  );
  assert.equal(
    deriveRequestPrincipal(mockReq({ get: () => '1.2.3.4', ip: '1.2.3.4', session: {} }), { apiToken: 'x' }),
    'anonymous',
  );
});

test('read route policy distinguishes control, local, cacheable, and direct Actual reads', () => {
  assert.equal(classifyReadRoute(mockReq({ path: '/api/v1/ping' })).policy, 'control');
  assert.equal(classifyReadRoute(mockReq({ path: '/api/v1/operations/op-key-12345678' })).policy, 'control');
  assert.equal(classifyReadRoute(mockReq({ path: '/api/v1/rules' })).policy, 'local');
  assert.equal(classifyReadRoute(mockReq({ path: '/api/v1/reimb-links' })).policy, 'local-sidecar');
  const accounts = classifyReadRoute(mockReq({ path: '/api/v1/accounts' }));
  assert.equal(accounts.policy, 'actual-cached');
  assert.equal(accounts.cacheKey, 'accounts');
  assert.equal(
    actualCacheKeyForRead(mockReq({ path: '/api/v1/transactions', query: { start: '2026-01-01', end: '2026-07-17' } })),
    'txns-all-2026-01-01-2026-07-17-all-none-all-x',
  );
  assert.equal(classifyReadRoute(mockReq({ path: '/api/v1/reconciliation' })).policy, 'actual-direct');
});

test('mutation admission saturates global limits with immediate overload', async () => {
  const admission = new RequestAdmissionController(tinyConfig({
    mutationGlobalPending: 1,
    mutationGlobalRunning: 1,
    readGlobalPending: 1,
    readGlobalRunning: 1,
    mutationPrincipalPending: 4,
    controlReserve: 0,
    maxPendingDepth: 1,
  }));
  const first = await admission.acquire({
    lane: 'mutation',
    principal: 'token:api',
    endpoint: 'post /budgets',
    weight: 1,
  });
  await assert.rejects(
    admission.acquire({
      lane: 'mutation',
      principal: 'session:other',
      endpoint: 'post /budgets',
      weight: 1,
    }),
    AdmissionOverloadedError,
  );
  first.release();
  assert.equal(admission.getHealth().lanes.mutation.waiters, 0);
});

test('fair release rejects additional waiters once hard pending depth is reached', async () => {
  const admission = new RequestAdmissionController(tinyConfig({
    readGlobalPending: 1,
    readGlobalRunning: 1,
    mutationGlobalPending: 1,
    mutationGlobalRunning: 1,
    controlReserve: 0,
    maxPendingDepth: 1,
  }));
  await admission.acquire({
    lane: 'read',
    principal: 'token:api',
    endpoint: 'get /accounts',
    weight: 1,
  });
  await assert.rejects(
    admission.acquire({
      lane: 'read',
      principal: 'session:flood',
      endpoint: 'get /accounts',
      weight: 1,
    }),
    AdmissionOverloadedError,
  );
});

test('abort removes queued work before start and wait timeout releases capacity', async () => {
  const admission = new RequestAdmissionController(tinyConfig({
    maxWaitMs: 15,
    mutationGlobalPending: 2,
    readGlobalPending: 2,
    maxPendingDepth: 3,
  }));
  const running = await admission.acquire({
    lane: 'mutation',
    principal: 'token:api',
    endpoint: 'post /refresh',
    weight: 1,
  });
  const controller = new AbortController();
  const aborted = admission.acquire({
    lane: 'mutation',
    principal: 'token:api',
    endpoint: 'post /refresh',
    weight: 1,
    signal: controller.signal,
  });
  controller.abort();
  await assert.rejects(aborted, AdmissionUnavailableError);
  assert.equal(admission.getHealth().stats.waitAborts, 1);
  running.release();
});

test('control reserve keeps ping responsive while non-control reads are saturated', async () => {
  const admission = new RequestAdmissionController(tinyConfig({
    readGlobalPending: 2,
    readGlobalRunning: 1,
    mutationGlobalPending: 2,
    controlReserve: 1,
    maxPendingDepth: 2,
  }));
  const running = await admission.acquire({
    lane: 'read',
    principal: 'session:blocker',
    endpoint: 'get /accounts',
    weight: 1,
  });
  await admission.acquire({
    lane: 'read',
    principal: 'token:api',
    endpoint: 'get /ping',
    weight: 1,
    control: true,
  });
  running.release();
});

test('idempotency journal peek bypasses mutation admission for replay and nonterminal keys', async () => {
  const journal = new OperationJournal();
  const key = 'idem-key-12345678';
  journal.start(key, { method: 'POST', path: '/budgets', body: { month: '2026-07', amount: 1 } });
  const admission = {
    noteIdempotencyBypass() { this.bypassed = true; },
  };
  const req = mockReq({
    method: 'POST',
    path: '/api/v1/budgets',
    headers: { 'Idempotency-Key': key },
  });
  assert.equal(shouldBypassMutationAdmission(req, journal, admission, { isDemo: () => false }), true);
  assert.equal(admission.bypassed, true);
});

test('overload envelope uses request id metadata and requires idempotency key reuse', () => {
  const req = { requestId: 'req-123' };
  const body = apiErrorBody(new AdmissionOverloadedError('busy', { retryAfterSeconds: 2 }), req);
  assert.equal(body.status, 429);
  assert.equal(body.body.code, 'ADMISSION_OVERLOADED');
  assert.equal(body.body.requestId, 'req-123');
  assert.equal(body.body.requiresIdempotencyKeyReuse, true);
  assert.equal(body.body.admission.retryAfterSeconds, 2);
});

test('closeAdmission rejects new work with 503 semantics and clears waiters', async () => {
  const admission = new RequestAdmissionController(tinyConfig());
  const running = await admission.acquire({
    lane: 'mutation',
    principal: 'token:api',
    endpoint: classifyMutationRoute(mockReq({ method: 'POST', path: '/api/v1/refresh' })).endpoint,
    weight: 1,
  });
  const waiting = admission.acquire({
    lane: 'mutation',
    principal: 'session:queued',
    endpoint: 'post /refresh',
    weight: 1,
  });
  admission.closeAdmission();
  await assert.rejects(waiting, AdmissionUnavailableError);
  await assert.rejects(
    admission.acquire({
      lane: 'mutation',
      principal: 'token:api',
      endpoint: 'post /refresh',
      weight: 1,
    }),
    AdmissionUnavailableError,
  );
  running.release();
  assert.equal(admission.getHealth().closed, true);
});

test('health diagnostics are aggregate-only without principal or key data', () => {
  const admission = new RequestAdmissionController(tinyConfig());
  const health = admission.getHealth();
  const serialized = JSON.stringify(health);
  assert.equal(typeof health.lanes.read.globalRunning, 'number');
  assert.equal(serialized.includes('secret-user'), false);
  assert.equal(serialized.includes('session:'), false);
  assert.equal(serialized.includes('token:'), false);
  assert.equal(Object.prototype.hasOwnProperty.call(health, 'principals'), false);
});

test('cache hit bypass avoids expensive-read capacity', async () => {
  const admission = new RequestAdmissionController(tinyConfig());
  const coordinator = {
    readCacheEntry(key) {
      return key === 'accounts' ? [{ id: 'a1' }] : undefined;
    },
  };
  const req = mockReq({ path: '/api/v1/accounts' });
  let invoked = false;
  const value = await withReadAdmission(req, coordinator, async () => {
    invoked = true;
    return [{ id: 'live' }];
  }, { admission });
  assert.deepEqual(value, [{ id: 'a1' }]);
  assert.equal(invoked, false);
  assert.equal(admission.getHealth().stats.cacheHitBypasses, 1);
});

test('withMutationAdmission executes under admitted slot and releases after handler', async () => {
  const admission = new RequestAdmissionController(tinyConfig());
  const journal = new OperationJournal();
  const req = mockReq({
    method: 'POST',
    path: '/api/v1/budgets',
    headers: { 'Idempotency-Key': 'fresh-key-12345678' },
  });
  let ran = false;
  await withMutationAdmission(req, journal, async () => {
    ran = true;
    assert.equal(admission.getHealth().lanes.mutation.globalRunning, 1);
  }, { isDemo: () => false, admission });
  assert.equal(ran, true);
  assert.equal(admission.getHealth().lanes.mutation.globalRunning, 0);
});
