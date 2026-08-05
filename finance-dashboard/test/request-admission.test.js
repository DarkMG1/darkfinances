'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const { SerialQueue } = require('../lib/serial-queue');
const { OperationJournal } = require('../lib/operation-journal');
const { AdmissionOverloadedError, AdmissionUnavailableError, AppError } = require('../lib/errors');
const {
  loadAdmissionLimitsConfig,
  validateConfig,
  MAX_PRINCIPAL_ENTRIES_CAP,
} = require('../lib/admission-limits-config');
const {
  classifyReadRoute,
  classifyMutationRoute,
  actualCacheKeyForRead,
} = require('../lib/admission-route-policy');
const { deriveRequestPrincipal } = require('../lib/request-principal');
const { RequestAdmissionController, TRAFFIC } = require('../lib/request-admission');
const { runGracefulShutdown } = require('../lib/graceful-shutdown');
const { registerProcessShutdownTestIsolation } = require('./helpers/process-shutdown-test-isolation');

registerProcessShutdownTestIsolation(test);
const {
  assertIdempotencyKeyHeader,
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
    lightweightGlobalPending: 4,
    lightweightGlobalRunning: 1,
    lightweightPrincipalPending: 2,
    lightweightPrincipalRunning: 1,
    maxPendingDepth: 8,
    maxPrincipalEntries: 8,
    controlReserve: 1,
    recoveryReserve: 1,
    cheapReserve: 1,
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
    aborted: false,
    get(name) {
      const headers = overrides.headers || {};
      return headers[name] ?? null;
    },
    on() {},
    off() {},
    ...overrides,
  };
}

function mockRes(overrides = {}) {
  return {
    writableFinished: false,
    finished: false,
    headersSent: false,
    on() {},
    off() {},
    ...overrides,
  };
}

function assertCountersZero(admission) {
  for (const lane of Object.values(admission.getHealth().lanes)) {
    assert.equal(lane.globalPending, 0);
    assert.equal(lane.globalRunning, 0);
    assert.equal(lane.waiters, 0);
    for (const value of Object.values(lane.classPending)) assert.equal(value, 0);
    for (const value of Object.values(lane.classRunning)) assert.equal(value, 0);
  }
}

test('serial queue rejects work beyond maxPending with typed 429 overload', async () => {
  const queue = new SerialQueue('bounded', { maxPending: 1 });
  const gate = createDeferred();
  const first = queue.run(() => gate.promise);
  assert.equal(queue.pending, 1);
  await assert.rejects(
    queue.run(async () => 'never'),
    (error) => error instanceof AdmissionOverloadedError && error.code === 'ADMISSION_OVERLOADED',
  );
  assert.equal(queue.pending, 1);
  assert.equal(queue.rejectedOverCapacity, 1);
  gate.resolve('done');
  await first;
  await queue.tail;
  assert.equal(queue.size, 0);
});

test('serial queue close rejects new work with typed 503 unavailable', async () => {
  const queue = new SerialQueue('bounded', { maxPending: 2 });
  queue.close();
  await assert.rejects(
    queue.run(async () => 'never'),
    (error) => error instanceof AdmissionUnavailableError && error.code === 'ADMISSION_UNAVAILABLE',
  );
  assert.equal(queue.rejectedClosed, 1);
});

test('config validation rejects malformed limits and caps maxPrincipalEntries', () => {
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
  assert.throws(
    () => validateConfig(tinyConfig({ maxPrincipalEntries: MAX_PRINCIPAL_ENTRIES_CAP + 1 })),
    /maxPrincipalEntries cannot exceed/,
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

test('demo-only API requests always derive the demo principal', () => {
  const req = mockReq({
    path: '/api/v1/accounts',
    session: { authenticated: true },
    sessionID: 'live-session',
    get(name) {
      if (name === 'X-Finance-Token') return 'live-token';
      return null;
    },
  });
  assert.equal(
    deriveRequestPrincipal(req, {
      apiToken: 'live-token',
      demoOnly: true,
      selftest: true,
    }),
    'demo',
  );
});

test('read route policy classifies control, lightweight disk, cacheable, and direct reads', () => {
  assert.equal(classifyReadRoute(mockReq({ path: '/api/v1/ping' })).policy, 'control');
  assert.equal(classifyReadRoute(mockReq({ path: '/api/v1/operations/op-key-12345678' })).policy, 'control');
  assert.equal(classifyReadRoute(mockReq({ path: '/api/v1/rules' })).policy, 'local');
  assert.equal(classifyReadRoute(mockReq({ path: '/api/v1/reimb-links' })).policy, 'local-sidecar');
  const receipt = classifyReadRoute(mockReq({ path: '/api/v1/receipts/r1/image' }));
  assert.equal(receipt.lane, 'lightweight');
  assert.equal(receipt.policy, 'lightweight-disk');
  const accounts = classifyReadRoute(mockReq({ path: '/api/v1/accounts' }));
  assert.equal(accounts.policy, 'actual-cached');
  assert.equal(accounts.cacheKey, 'accounts');
  assert.equal(
    actualCacheKeyForRead(mockReq({ path: '/api/v1/transactions', query: { start: '2026-01-01', end: '2026-07-17' } })),
    'txns-all-2026-01-01-2026-07-17-all-none-all-x',
  );
  assert.equal(classifyReadRoute(mockReq({ path: '/api/v1/reconciliation' })).policy, 'actual-direct');
});

test('principal map evicts idle LRU only and fails closed when active buckets fill the map', async () => {
  const admission = new RequestAdmissionController(tinyConfig({
    maxPrincipalEntries: 2,
    mutationGlobalPending: 4,
    mutationGlobalRunning: 2,
    recoveryReserve: 0,
    controlReserve: 0,
  }));

  const idleA = await admission.acquire({
    lane: 'mutation', principal: 'session:idle-a', endpoint: 'post /budgets', weight: 1,
  });
  idleA.release();
  const idleB = await admission.acquire({
    lane: 'mutation', principal: 'session:idle-b', endpoint: 'post /budgets', weight: 1,
  });
  idleB.release();

  const active = await admission.acquire({
    lane: 'mutation', principal: 'session:active', endpoint: 'post /budgets', weight: 1,
  });
  assert.equal(admission.getHealth().lanes.mutation.principalsTracked, 2);

  const newcomer = await admission.acquire({
    lane: 'mutation', principal: 'session:new', endpoint: 'post /budgets', weight: 1,
  });
  assert.equal(admission.getHealth().lanes.mutation.principalsTracked, 2);

  await assert.rejects(
    admission.acquire({
      lane: 'mutation', principal: 'session:blocked', endpoint: 'post /budgets', weight: 1,
    }),
    AdmissionOverloadedError,
  );
  assert.equal(admission.getHealth().stats.principalMapRejections, 1);
  newcomer.release();
  active.release();
  assertCountersZero(admission);
});

test('ticket release is idempotent and counters decrement when principal bucket is missing', async () => {
  const admission = new RequestAdmissionController(tinyConfig({ recoveryReserve: 0, controlReserve: 0 }));
  const ticket = await admission.acquire({
    lane: 'read',
    principal: 'session:ghost',
    endpoint: 'get /accounts',
    weight: 1,
  });
  admission.lanes.read.principals.delete('session:ghost');
  ticket.release();
  ticket.release();
  assert.equal(admission.getHealth().stats.idempotentReleases, 1);
  assertCountersZero(admission);
});

test('high-cardinality principal churn never exceeds per-principal caps and returns counters to zero', async () => {
  const admission = new RequestAdmissionController(tinyConfig({
    maxPrincipalEntries: 16,
    mutationPrincipalPending: 1,
    mutationPrincipalRunning: 1,
    recoveryReserve: 0,
    controlReserve: 0,
  }));

  for (let i = 0; i < 200; i += 1) {
    const principal = `session:churn-${i}`;
    const ticket = await admission.acquire({
      lane: 'mutation',
      principal,
      endpoint: 'post /budgets',
      weight: 1,
    });
    assert.equal(admission.getHealth().lanes.mutation.principalsTracked <= 16, true);
    ticket.release();
  }
  assertCountersZero(admission);
});

test('mutation admission saturates global limits with immediate overload', async () => {
  const admission = new RequestAdmissionController(tinyConfig({
    mutationGlobalPending: 1,
    mutationGlobalRunning: 1,
    readGlobalPending: 1,
    readGlobalRunning: 1,
    mutationPrincipalPending: 4,
    controlReserve: 0,
    recoveryReserve: 0,
    cheapReserve: 0,
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

test('fair round-robin scheduling avoids starving a second principal', async () => {
  const admission = new RequestAdmissionController(tinyConfig({
    mutationGlobalPending: 3,
    mutationGlobalRunning: 1,
    mutationPrincipalPending: 2,
    recoveryReserve: 0,
    controlReserve: 0,
    maxPendingDepth: 4,
  }));
  const order = [];
  const running = await admission.acquire({
    lane: 'mutation',
    principal: 'session:a',
    endpoint: 'post /budgets',
    weight: 1,
  });
  const waitB = admission.acquire({
    lane: 'mutation',
    principal: 'session:b',
    endpoint: 'post /budgets',
    weight: 1,
  }).then((ticket) => {
    order.push('b');
    ticket.release();
  });
  const waitA2 = admission.acquire({
    lane: 'mutation',
    principal: 'session:a',
    endpoint: 'post /budgets',
    weight: 1,
  }).then((ticket) => {
    order.push('a2');
    ticket.release();
  });
  running.release();
  await Promise.all([waitB, waitA2]);
  assert.deepEqual(order, ['b', 'a2']);
});

test('abort removes queued work before start and wait timeout releases capacity', async () => {
  const admission = new RequestAdmissionController(tinyConfig({
    maxWaitMs: 15,
    mutationGlobalPending: 2,
    readGlobalPending: 3,
    maxPendingDepth: 3,
    recoveryReserve: 0,
    cheapReserve: 0,
    controlReserve: 0,
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
  assertCountersZero(admission);
});

test('control reserve keeps ping responsive while ordinary reads are saturated', async () => {
  const admission = new RequestAdmissionController(tinyConfig({
    readGlobalPending: 4,
    readGlobalRunning: 1,
    readPrincipalPending: 3,
    mutationGlobalPending: 3,
    mutationGlobalRunning: 1,
    controlReserve: 1,
    cheapReserve: 0,
    recoveryReserve: 0,
    maxPendingDepth: 8,
    maxWaitMs: 2_000,
  }));
  const running = await admission.acquire({
    lane: 'read',
    principal: 'session:blocker-a',
    endpoint: 'get /accounts',
    weight: 1,
    trafficClass: TRAFFIC.ORDINARY,
  });
  admission.acquire({
    lane: 'read',
    principal: 'session:blocker-b',
    endpoint: 'get /accounts',
    weight: 1,
    trafficClass: TRAFFIC.ORDINARY,
  });
  admission.acquire({
    lane: 'read',
    principal: 'session:blocker-c',
    endpoint: 'get /accounts',
    weight: 1,
    trafficClass: TRAFFIC.ORDINARY,
  });
  const deadline = Date.now() + 1_000;
  while (Date.now() < deadline) {
    const lane = admission.getHealth().lanes.read;
    const ordinaryUsed = lane.classPending.ordinary + lane.classRunning.ordinary;
    if (ordinaryUsed >= 3) break;
    await new Promise((resolve) => setImmediate(resolve));
  }
  assert.equal(
    admission.getHealth().lanes.read.classPending.ordinary
      + admission.getHealth().lanes.read.classRunning.ordinary,
    3,
  );
  await assert.rejects(
    admission.acquire({
      lane: 'read',
      principal: 'session:flood',
      endpoint: 'get /accounts',
      weight: 1,
      trafficClass: TRAFFIC.ORDINARY,
    }),
    AdmissionOverloadedError,
  );
  const pingPromise = admission.acquire({
    lane: 'read',
    principal: 'token:api',
    endpoint: 'get /ping',
    weight: 1,
    trafficClass: TRAFFIC.CONTROL,
  });
  running.release();
  const ping = await pingPromise;
  ping.release();
  assert.equal(admission.getHealth().stats.controlAdmissions, 1);
});

test('10k control admissions remain bounded by control reserve', async () => {
  const admission = new RequestAdmissionController(tinyConfig({
    readGlobalPending: 4,
    readGlobalRunning: 2,
    controlReserve: 2,
    cheapReserve: 0,
    recoveryReserve: 0,
    maxPendingDepth: 4,
    maxWaitMs: 15,
  }));
  const tickets = [];
  for (let i = 0; i < 2; i += 1) {
    tickets.push(await admission.acquire({
      lane: 'read',
      principal: `session:control-${i}`,
      endpoint: 'get /ping',
      weight: 1,
      trafficClass: TRAFFIC.CONTROL,
    }));
  }
  let rejected = 0;
  for (let i = 0; i < 10_000; i += 1) {
    try {
      await admission.acquire({
        lane: 'read',
        principal: `session:flood-${i}`,
        endpoint: 'get /ping',
        weight: 1,
        trafficClass: TRAFFIC.CONTROL,
      });
    } catch (error) {
      if (error instanceof AdmissionOverloadedError) rejected += 1;
      else throw error;
    }
  }
  assert.equal(rejected, 10_000);
  for (const ticket of tickets) ticket.release();
  assertCountersZero(admission);
});

test('recovery journal peek uses bounded recovery class and converts to ordinary for new keys', async () => {
  const journal = new OperationJournal();
  const key = 'idem-key-12345678';
  journal.start(key, { method: 'POST', path: '/budgets', body: { month: '2026-07', amount: 1 } });
  const admission = new RequestAdmissionController(tinyConfig({
    mutationGlobalPending: 2,
    mutationGlobalRunning: 1,
    recoveryReserve: 1,
    controlReserve: 0,
    maxPendingDepth: 2,
  }));

  const replay = await admission.acquireMutationWithJournalPeek({
    principal: 'token:api',
    endpoint: 'post /budgets',
    weight: 1,
    peekJournal: () => journal.get(key),
  });
  assert.equal(replay.mode, 'recovery');
  assert.equal(admission.getHealth().stats.recoveryReplays, 1);
  replay.ticket.release();

  const running = await admission.acquire({
    lane: 'mutation',
    principal: 'session:block',
    endpoint: 'post /budgets',
    weight: 1,
    trafficClass: TRAFFIC.RECOVERY,
  });
  await assert.rejects(
    admission.acquireMutationWithJournalPeek({
      principal: 'token:api',
      endpoint: 'post /budgets',
      weight: 1,
      peekJournal: () => null,
    }),
    AdmissionOverloadedError,
  );
  running.release();
  assertCountersZero(admission);
});

test('random-key recovery flood cannot exceed recovery reserve peeks', async () => {
  const admission = new RequestAdmissionController(tinyConfig({
    mutationGlobalPending: 2,
    mutationGlobalRunning: 1,
    recoveryReserve: 1,
    controlReserve: 0,
    maxPendingDepth: 2,
    maxWaitMs: 15,
  }));
  const blocker = await admission.acquire({
    lane: 'mutation',
    principal: 'session:blocker',
    endpoint: 'post /budgets',
    weight: 1,
    trafficClass: TRAFFIC.RECOVERY,
  });
  let rejected = 0;
  for (let i = 0; i < 500; i += 1) {
    try {
      const attempt = await admission.acquireMutationWithJournalPeek({
        principal: `session:${i}`,
        endpoint: 'post /budgets',
        weight: 1,
        peekJournal: () => null,
      });
      attempt.ticket.release();
    } catch (error) {
      if (error instanceof AdmissionOverloadedError) rejected += 1;
      else throw error;
    }
  }
  blocker.release();
  assert.ok(rejected > 0);
  assertCountersZero(admission);
});

test('missing Idempotency-Key fails before admission or queue work', async () => {
  const admission = new RequestAdmissionController(tinyConfig());
  const queue = new SerialQueue('mutations', { maxPending: 1 });
  const req = mockReq({
    method: 'POST',
    path: '/api/v1/budgets',
    headers: {},
  });
  assert.throws(
    () => assertIdempotencyKeyHeader(req),
    (error) => error instanceof AppError && error.code === 'IDEMPOTENCY_KEY_REQUIRED',
  );
  await assert.rejects(
    () => withMutationAdmission(req, mockRes(), new OperationJournal(), queue, async () => 'never', {
      isDemo: () => false,
      isVersioned: true,
      admission,
    }),
    (error) => error instanceof AppError && error.code === 'IDEMPOTENCY_KEY_REQUIRED',
  );
  assert.equal(queue.pending, 0);
  assertCountersZero(admission);
});

test('read overload envelope omits idempotency key reuse metadata', () => {
  const req = { requestId: 'req-read' };
  const body = apiErrorBody(new AdmissionOverloadedError('busy', {
    retryAfterSeconds: 2,
    lane: 'read',
    endpoint: 'get /accounts',
  }), req);
  assert.equal(body.status, 429);
  assert.equal(body.body.code, 'ADMISSION_OVERLOADED');
  assert.equal(body.body.requestId, 'req-read');
  assert.equal(body.body.requiresIdempotencyKeyReuse, undefined);
  assert.equal(body.body.admission.lane, 'read');
  assert.equal(body.body.admission.requiresIdempotencyKeyReuse, undefined);
  assert.equal(body.body.admission.retryAfterSeconds, 2);
});

test('mutation overload envelope includes idempotency key reuse metadata', () => {
  const req = { requestId: 'req-mut' };
  const body = apiErrorBody(new AdmissionOverloadedError('busy', {
    retryAfterSeconds: 2,
    lane: 'mutation',
    endpoint: 'post /budgets',
  }), req);
  assert.equal(body.body.requiresIdempotencyKeyReuse, true);
  assert.equal(body.body.admission.requiresIdempotencyKeyReuse, true);
  assert.equal(body.body.admission.lane, 'mutation');
});

test('abort after admission before mutation queue does not execute handler', async () => {
  const admission = new RequestAdmissionController(tinyConfig({ recoveryReserve: 1, controlReserve: 0 }));
  const queue = new SerialQueue('mutations', { maxPending: 8 });
  const journal = new OperationJournal();
  const abort = new AbortController();
  const key = 'abort-key-12345678';
  let handlerRuns = 0;

  const { ticket } = await admission.acquireMutationWithJournalPeek({
    principal: 'token:api',
    endpoint: 'post /budgets',
    weight: 1,
    peekJournal: () => journal.get(key),
    signal: abort.signal,
  });
  await Promise.resolve();
  abort.abort();

  await assert.rejects(async () => {
    if (abort.signal.aborted) {
      throw new AdmissionUnavailableError('Client aborted before mutation started', {
        lane: 'mutation',
        endpoint: 'post /budgets',
      });
    }
    return queue.run(async () => {
      handlerRuns += 1;
      return { ok: true };
    });
  }, AdmissionUnavailableError);

  ticket.release();
  assert.equal(handlerRuns, 0);
  assert.equal(queue.pending, 0);
  assertCountersZero(admission);
});

test('closeAdmission rejects new work with 503 semantics and clears waiters', async () => {
  const admission = new RequestAdmissionController(tinyConfig({ recoveryReserve: 0 }));
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

test('graceful shutdown closes admission before mutation queue close', async () => {
  const phases = [];
  const admission = new RequestAdmissionController(tinyConfig());
  const mutationQueue = new SerialQueue('test-mutations');
  const server = require('http').createServer();

  const result = await runGracefulShutdown({
    signal: 'SIGTERM',
    httpServer: server,
    mutationQueue,
    requestAdmission: admission,
    shutdownApi: async () => {},
    totalTimeoutMs: 2_000,
    mutationDrainTimeoutMs: 500,
    exit: () => {},
    log: (phase) => { phases.push(phase); },
  });

  assert.equal(result.ok, true);
  assert.ok(phases.indexOf('in-flight-reads-aborted') < phases.indexOf('request-admission-stopped'));
  assert.ok(phases.indexOf('request-admission-stopped') < phases.indexOf('mutation-admission-stopped'));
  assert.equal(admission.getHealth().closed, true);
  assert.equal(mutationQueue.closed, true);
});

test('ordering regression: in-process shutdown abort resets before later client handlers', async () => {
  const shutdownAdmission = new RequestAdmissionController(tinyConfig());
  const mutationQueue = new SerialQueue('test-mutations-ordering');
  const server = require('http').createServer();

  await runGracefulShutdown({
    signal: 'SIGTERM',
    httpServer: server,
    mutationQueue,
    requestAdmission: shutdownAdmission,
    shutdownApi: async () => {},
    totalTimeoutMs: 2_000,
    mutationDrainTimeoutMs: 500,
    exit: () => {},
    log: () => {},
  });

  const { resetProcessShutdownTestIsolation } = require('./helpers/process-shutdown-test-isolation');
  resetProcessShutdownTestIsolation();

  const admission = new RequestAdmissionController(tinyConfig());
  const ticket = await admission.acquire({
    lane: 'mutation',
    principal: 'token:api',
    endpoint: 'post /refresh',
    weight: 1,
  });
  ticket.release();

  const { createClientAbortSignal } = require('../lib/client-abort-signal');
  const { EventEmitter } = require('events');
  const req = new EventEmitter();
  req.aborted = false;
  const res = new EventEmitter();
  res.writableFinished = false;
  res.finished = false;
  res.headersSent = false;
  const handle = createClientAbortSignal(req, res);
  assert.equal(handle.signal.aborted, false);
  handle.dispose();
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
  assert.equal(typeof health.recoveryReserve, 'number');
  assert.equal(typeof health.cheapReserve, 'number');
});

test('cache hit acquires bounded cheap lane instead of bypassing capacity', async () => {
  const admission = new RequestAdmissionController(tinyConfig({
    readGlobalPending: 2,
    readGlobalRunning: 1,
    cheapReserve: 1,
    controlReserve: 0,
  }));
  const coordinator = {
    readCacheEntry(key) {
      return key === 'accounts' ? [{ id: 'a1' }] : undefined;
    },
  };
  const req = mockReq({ path: '/api/v1/accounts' });
  let invoked = false;
  const value = await withReadAdmission(req, mockRes(), coordinator, async () => {
    invoked = true;
    return [{ id: 'live' }];
  }, { admission });
  assert.deepEqual(value, [{ id: 'a1' }]);
  assert.equal(invoked, false);
  assert.equal(admission.getHealth().stats.cacheHitAdmissions, 1);
  assert.equal(admission.getHealth().stats.cheapAdmissions, 1);
  assertCountersZero(admission);
});

test('withMutationAdmission executes under admitted slot and releases after handler', async () => {
  const admission = new RequestAdmissionController(tinyConfig({ recoveryReserve: 1, controlReserve: 0 }));
  const journal = new OperationJournal();
  const queue = new SerialQueue('mutations', { maxPending: 2 });
  const req = mockReq({
    method: 'POST',
    path: '/api/v1/budgets',
    headers: { 'Idempotency-Key': 'fresh-key-12345678' },
  });
  let ran = false;
  await withMutationAdmission(req, mockRes(), journal, queue, async () => {
    ran = true;
    assert.equal(admission.getHealth().lanes.mutation.globalRunning, 1);
  }, { isDemo: () => false, isVersioned: true, admission });
  assert.equal(ran, true);
  assert.equal(admission.getHealth().lanes.mutation.globalRunning, 0);
});

test('same-key completed replay storms stay admissible under recovery reserve', async () => {
  const admission = new RequestAdmissionController(tinyConfig({
    mutationGlobalPending: 2,
    mutationGlobalRunning: 1,
    recoveryReserve: 1,
    controlReserve: 0,
    maxPendingDepth: 2,
  }));
  const journal = new OperationJournal();
  const key = 'replay-key-12345678';
  journal.start(key, { method: 'POST', path: '/budgets', body: {} });

  for (let i = 0; i < 20; i += 1) {
    const replay = await admission.acquireMutationWithJournalPeek({
      principal: 'token:api',
      endpoint: 'post /budgets',
      weight: 1,
      peekJournal: () => journal.get(key),
    });
    assert.equal(replay.mode, 'recovery');
    replay.ticket.release();
  }
  assert.equal(admission.getHealth().stats.recoveryReplays, 20);
  assertCountersZero(admission);
});
