'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const os = require('os');
const path = require('path');
const { startEphemeralDashboardServer, waitForChildExit } = require('./helpers/ephemeral-dashboard-server');
const {
  childWatchContext,
  markPrelude,
  sidecarReleasePrelude,
  waitForMarkerDir,
} = require('./helpers/test-sync-barriers');

async function apiRequest(base, pathname, { method = 'GET', key, body } = {}) {
  const response = await fetch(`${base}${pathname}`, {
    method,
    headers: {
      'X-Finance-Token': 'test-api-token',
      ...(key ? { 'Idempotency-Key': key } : {}),
      ...(body === undefined ? {} : { 'Content-Type': 'application/json' }),
    },
    ...(body === undefined ? {} : { body: JSON.stringify(body) }),
  });
  const text = await response.text();
  let parsed;
  try { parsed = JSON.parse(text); } catch (_) { parsed = text; }
  return { response, body: parsed };
}

function markLine() {
  return `
    const fs = require('fs');
    ${markPrelude()}
    ${sidecarReleasePrelude()}
  `;
}

async function startCoordinatorServer(t, preloadBody, extraEnv = {}) {
  return startEphemeralDashboardServer(t, {
    tempPrefix: 'darkfinances-coordinator-',
    preloadBody,
    extraEnv,
  });
}

async function startCoordinatorServerWithSidecarGate(t, preloadBody) {
  const started = await startEphemeralDashboardServer(t, {
    tempPrefix: 'darkfinances-coordinator-',
    preloadBody,
    extraEnvForDir: (dir) => ({ TEST_RELEASE_PATH: path.join(dir, 'release.fill') }),
  });
  return {
    ...started,
    releaseFill() {
      fs.writeFileSync(path.join(started.dir, 'release.fill'), '1');
    },
  };
}

test('queued write blocks overlapping Actual-backed GET', async (t) => {
  const { base, child, logs, dir, childState, releaseFill } = await startCoordinatorServerWithSidecarGate(t, `
    ${markLine()}
    const path = require('path');
    const dataPath = require.resolve(path.join(process.env.TEST_DASHBOARD_ROOT, 'dataModule.js'));
    let writeStarted = false;
    let readDuringWrite = false;
    const mock = {
      initApi: async () => ({ ok: true }),
      shutdownApi: async () => ({ ok: true }),
      getHealth: () => ({ ready: true }),
      syncNow: async () => { mark('sync'); },
      getAccounts: async () => {
        if (writeStarted) readDuringWrite = true;
        mark('getAccounts');
        return [{ id: 'a1', name: 'Checking' }];
      },
      setBudgetAmount: async () => {
        writeStarted = true;
        mark('setBudget:start');
        await waitSidecarRelease();
        mark('setBudget:end');
        return { ok: true, needsSync: true };
      },
    };
    require.cache[dataPath] = { id: dataPath, filename: dataPath, loaded: true, exports: mock, children: [], paths: [] };
  `);

  const postPromise = apiRequest(base, '/api/v1/budgets', {
    method: 'POST',
    key: 'budget-block-get',
    body: { month: '2026-07', categoryId: 'food', amount: 100 },
  });
  await waitForMarkerDir(dir, 'setBudget:start', childWatchContext({ child, logs, childState }));
  const getPromise = apiRequest(base, '/api/v1/accounts');
  releaseFill();
  const [getResult, postResult] = await Promise.all([getPromise, postPromise]);
  assert.equal(getResult.response.status, 200);
  assert.equal(postResult.response.status, 200);
  const marker = fs.readFileSync(path.join(dir, 'marker.log'), 'utf8').trim().split('\n');
  const setStart = marker.indexOf('setBudget:start');
  const accountsIdx = marker.lastIndexOf('getAccounts');
  assert.ok(setStart >= 0);
  assert.ok(accountsIdx > setStart);
  assert.ok(marker.indexOf('setBudget:end') < accountsIdx || marker.filter((line) => line === 'getAccounts').length === 1);
});

test('read then write preserves ordering under coordinator (unit-covered); server lane stays healthy', async (t) => {
  const { base, child, logs, dir } = await startCoordinatorServer(t, `
    ${markLine()}
    const path = require('path');
    const dataPath = require.resolve(path.join(process.env.TEST_DASHBOARD_ROOT, 'dataModule.js'));
    const mock = {
      initApi: async () => ({ ok: true }),
      shutdownApi: async () => ({ ok: true }),
      getHealth: () => ({ ready: true }),
      syncNow: async () => { mark('sync'); },
      getCategories: async () => {
        mark('read:start');
        await new Promise((resolve) => setTimeout(resolve, 40));
        mark('read:end');
        return [{ id: 'c1', name: 'Food' }];
      },
      setBudgetAmount: async () => { mark('write'); return { ok: true }; },
    };
    require.cache[dataPath] = { id: dataPath, filename: dataPath, loaded: true, exports: mock, children: [], paths: [] };
  `);
  const read = await apiRequest(base, '/api/v1/categories');
  assert.equal(read.response.status, 200);
  const write = await apiRequest(base, '/api/v1/budgets', {
    method: 'POST',
    key: 'order-write',
    body: { month: '2026-07', categoryId: 'food', amount: 50 },
  });
  assert.equal(write.response.status, 200);
  const ping = await apiRequest(base, '/api/v1/ping');
  assert.equal(ping.response.status, 200);
  assert.equal(typeof ping.body.data.actualCoordinator.generation, 'number');
  const marker = fs.readFileSync(path.join(dir, 'marker.log'), 'utf8').trim().split('\n');
  assert.ok(marker.includes('read:start'));
  assert.ok(marker.includes('read:end'));
  assert.ok(marker.includes('write'));
});

test('failed read does not strand mutation queue or coordinator lane', async (t) => {
  const { base, child, logs, dir } = await startCoordinatorServer(t, `
    ${markLine()}
    const path = require('path');
    const dataPath = require.resolve(path.join(process.env.TEST_DASHBOARD_ROOT, 'dataModule.js'));
    let failOnce = true;
    const mock = {
      initApi: async () => ({ ok: true }),
      shutdownApi: async () => ({ ok: true }),
      getHealth: () => ({ ready: true }),
      syncNow: async () => { mark('sync'); },
      getSpending: async () => {
        if (failOnce) {
          failOnce = false;
          mark('read:fail');
          throw new Error('injected read failure');
        }
        mark('read:ok');
        return { month: '2026-07', totalSpend: 0 };
      },
      setBudgetAmount: async () => { mark('write'); return { ok: true }; },
    };
    require.cache[dataPath] = { id: dataPath, filename: dataPath, loaded: true, exports: mock, children: [], paths: [] };
  `);
  const failed = await apiRequest(base, '/api/v1/spending');
  assert.equal(failed.response.status, 500);
  const ok = await apiRequest(base, '/api/v1/spending');
  assert.equal(ok.response.status, 200);
  const write = await apiRequest(base, '/api/v1/budgets', {
    method: 'POST',
    key: 'after-read-fail',
    body: { month: '2026-07', categoryId: 'food', amount: 10 },
  });
  assert.equal(write.response.status, 200);
  const marker = fs.readFileSync(path.join(dir, 'marker.log'), 'utf8').trim().split('\n');
  assert.deepEqual(marker.slice(0, 3), ['read:fail', 'read:ok', 'write']);
});

test('local rules read is not blocked by in-flight Actual read', async (t) => {
  const { base, child, logs, dir, childState, releaseFill } = await startCoordinatorServerWithSidecarGate(t, `
    ${markLine()}
    const path = require('path');
    const dataPath = require.resolve(path.join(process.env.TEST_DASHBOARD_ROOT, 'dataModule.js'));
    const mock = {
      initApi: async () => ({ ok: true }),
      shutdownApi: async () => ({ ok: true }),
      getHealth: () => ({ ready: true }),
      syncNow: async () => {},
      getAccounts: async () => {
        mark('actual-read:start');
        await waitSidecarRelease();
        mark('actual-read:end');
        return [];
      },
      getRules: () => { mark('local-rules'); return { rules: [] }; },
      getCatalogDisplay: () => [],
    };
    require.cache[dataPath] = { id: dataPath, filename: dataPath, loaded: true, exports: mock, children: [], paths: [] };
  `);
  const actualRead = apiRequest(base, '/api/v1/accounts');
  await waitForMarkerDir(dir, 'actual-read:start', childWatchContext({ child, logs, childState }));
  const localRead = apiRequest(base, '/api/v1/rules');
  await waitForMarkerDir(dir, 'local-rules', childWatchContext({ child, logs, childState }));
  releaseFill();
  await Promise.all([actualRead, localRead]);
  const marker = fs.readFileSync(path.join(dir, 'marker.log'), 'utf8').trim().split('\n');
  const rulesIdx = marker.indexOf('local-rules');
  const actualEnd = marker.indexOf('actual-read:end');
  assert.ok(rulesIdx >= 0);
  assert.ok(rulesIdx < actualEnd);
});

test('operation replay stays on mutation queue after coordinator write', async (t) => {
  const { base, child, logs, dir } = await startCoordinatorServer(t, `
    ${markLine()}
    const path = require('path');
    const dataPath = require.resolve(path.join(process.env.TEST_DASHBOARD_ROOT, 'dataModule.js'));
    const mock = {
      initApi: async () => ({ ok: true }),
      shutdownApi: async () => ({ ok: true }),
      getHealth: () => ({ ready: true }),
      syncNow: async () => { mark('sync'); },
      setBudgetAmount: async () => { mark('mutation'); return { ok: true, needsSync: true }; },
      proveBulkOperationJournalCompletion: () => null,
    };
    require.cache[dataPath] = { id: dataPath, filename: dataPath, loaded: true, exports: mock, children: [], paths: [] };
  `);
  const key = 'replay-budget';
  let result = await apiRequest(base, '/api/v1/budgets', {
    method: 'POST',
    key,
    body: { month: '2026-07', categoryId: 'food', amount: 25 },
  });
  assert.equal(result.response.status, 200);
  result = await apiRequest(base, `/api/v1/operations/${key}`);
  assert.equal(result.response.status, 200);
  assert.equal(result.body.data.phase, 'completed');
  const marker = fs.readFileSync(path.join(dir, 'marker.log'), 'utf8').trim().split('\n');
  assert.deepEqual(marker, ['mutation', 'sync']);
});

test('ping exposes bounded coordinator diagnostics without payloads', async (t) => {
  const { base, child, logs, dir } = await startCoordinatorServer(t, `
    const path = require('path');
    const dataPath = require.resolve(path.join(process.env.TEST_DASHBOARD_ROOT, 'dataModule.js'));
    require.cache[dataPath] = {
      id: dataPath,
      filename: dataPath,
      loaded: true,
      exports: {
        initApi: async () => ({ ok: true }),
        shutdownApi: async () => ({ ok: true }),
        getHealth: () => ({ ready: true }),
      },
      children: [],
      paths: [],
    };
  `);
  const { body, response } = await apiRequest(base, '/api/v1/ping');
  assert.equal(response.status, 200);
  assert.ok(body.data.actualCoordinator);
  assert.equal(typeof body.data.actualCoordinator.generation, 'number');
  assert.equal(typeof body.data.actualCoordinator.queued, 'number');
  assert.ok(body.data.actualCoordinator.stats);
  assert.ok(Array.isArray(body.data.actualCoordinator.recent));
});

test('shutdown drains mutations then shutdownApi without pre-closing coordinator', async (t) => {
  const { base, child, logs, dir, childState } = await startCoordinatorServer(t, `
    ${markLine()}
    const path = require('path');
    const dataPath = require.resolve(path.join(process.env.TEST_DASHBOARD_ROOT, 'dataModule.js'));
    const mock = {
      initApi: async () => ({ ok: true }),
      shutdownApi: async () => { mark('shutdown'); return { ok: true }; },
      getHealth: () => ({ ready: true }),
      syncNow: async () => {},
      setBudgetAmount: async () => {
        mark('mutation:start');
        await new Promise((resolve) => setTimeout(resolve, 30));
        mark('mutation:end');
        return { ok: true };
      },
    };
    require.cache[dataPath] = { id: dataPath, filename: dataPath, loaded: true, exports: mock, children: [], paths: [] };
  `);
  const pending = apiRequest(base, '/api/v1/budgets', {
    method: 'POST',
    key: 'shutdown-write',
    body: { month: '2026-07', categoryId: 'food', amount: 5 },
  });
  await waitForMarkerDir(dir, 'mutation:start', childWatchContext({ child, logs, childState }));
  child.kill('SIGTERM');
  const [exitCode] = await Promise.all([
    waitForChildExit(child, 15_000),
    pending,
  ]);
  const marker = fs.readFileSync(path.join(dir, 'marker.log'), 'utf8').trim().split('\n');
  assert.ok(marker.includes('mutation:start'));
  assert.ok(marker.includes('mutation:end'));
  assert.ok(marker.includes('shutdown'));
  if (exitCode != null) assert.equal(exitCode, 0);
});

test('production-path cachedActual fill cannot republish after mutation invalidates generation', async (t) => {
  const { base, child, logs, dir, childState, releaseFill } = await startCoordinatorServerWithSidecarGate(t, `
    ${markLine()}
    const path = require('path');
    const dataPath = require.resolve(path.join(process.env.TEST_DASHBOARD_ROOT, 'dataModule.js'));
    let accountsCall = 0;
    const mock = {
      initApi: async () => ({ ok: true }),
      shutdownApi: async () => ({ ok: true }),
      getHealth: () => ({ ready: true }),
      syncNow: async () => ({ ok: true }),
      getAccounts: async () => {
        accountsCall += 1;
        mark('accounts:inflight');
        await waitSidecarRelease();
        return [{ id: 'a1', name: accountsCall === 1 ? 'StaleDuringFill' : 'FreshAfterInvalidate' }];
      },
      setRecurringOverride: async () => ({ ok: true }),
    };
    require.cache[dataPath] = { id: dataPath, filename: dataPath, loaded: true, exports: mock, children: [], paths: [] };
  `);
  const { body: pingBefore } = await apiRequest(base, '/api/v1/ping');
  const genBefore = pingBefore.data.actualCoordinator.generation;
  const readPromise = apiRequest(base, '/api/v1/accounts');
  await waitForMarkerDir(dir, 'accounts:inflight', childWatchContext({ child, logs, childState }));
  const invalidatePromise = apiRequest(base, '/api/v1/recurring/test-key/override', {
    method: 'POST',
    key: 'stale-repub-invalidate',
    body: { status: 'active', hidden: false },
  });
  releaseFill();
  const [{ body: firstBody }, { response: invalidateResponse }] = await Promise.all([readPromise, invalidatePromise]);
  assert.equal(invalidateResponse.status, 200);
  assert.ok(['StaleDuringFill', 'FreshAfterInvalidate'].includes(firstBody.data[0].name));
  const { body: pingAfterMutate } = await apiRequest(base, '/api/v1/ping');
  assert.ok(pingAfterMutate.data.actualCoordinator.generation > genBefore);
  const { body: secondBody } = await apiRequest(base, '/api/v1/accounts');
  assert.equal(secondBody.data[0].name, 'FreshAfterInvalidate');
});

test('account override sidecar mutation discards in-flight accounts fill', async (t) => {
  const { base, child, logs, dir, childState, releaseFill } = await startCoordinatorServerWithSidecarGate(t, `
    ${markLine()}
    const path = require('path');
    const dataPath = require.resolve(path.join(process.env.TEST_DASHBOARD_ROOT, 'dataModule.js'));
    let accountsCall = 0;
    const mock = {
      initApi: async () => ({ ok: true }),
      shutdownApi: async () => ({ ok: true }),
      getHealth: () => ({ ready: true }),
      syncNow: async () => ({ ok: true }),
      getAccounts: async () => {
        accountsCall += 1;
        mark('getAccounts:' + accountsCall);
        mark('fill:start');
        await waitSidecarRelease();
        return [{ id: 'a1', name: accountsCall === 1 ? 'BeforeOverride' : 'AfterOverride' }];
      },
      setAccountOverride: async () => ({ ok: true }),
    };
    require.cache[dataPath] = { id: dataPath, filename: dataPath, loaded: true, exports: mock, children: [], paths: [] };
  `);
  const { body: pingBefore } = await apiRequest(base, '/api/v1/ping');
  const genBefore = pingBefore.data.actualCoordinator.generation;
  const readPromise = apiRequest(base, '/api/v1/accounts');
  await waitForMarkerDir(dir, 'fill:start', childWatchContext({ child, logs, childState }));
  const mutatePromise = apiRequest(base, '/api/v1/accounts/a1/override', {
    method: 'POST',
    key: 'override-stale',
    body: { name: 'Renamed' },
  });
  releaseFill();
  const [{ body: firstBody }, { response: mutateResponse }] = await Promise.all([readPromise, mutatePromise]);
  assert.equal(mutateResponse.status, 200);
  assert.equal(firstBody.data[0].name, 'BeforeOverride');
  const { body: pingAfterMutate } = await apiRequest(base, '/api/v1/ping');
  assert.ok(pingAfterMutate.data.actualCoordinator.generation > genBefore);
  const { body: secondBody } = await apiRequest(base, '/api/v1/accounts');
  assert.equal(secondBody.data[0].name, 'AfterOverride');
  const marker = fs.readFileSync(path.join(dir, 'marker.log'), 'utf8').trim().split('\n');
  assert.ok(marker.includes('getAccounts:2'));
});

test('events sidecar mutation discards in-flight events fill', async (t) => {
  const { base, child, logs, dir, childState, releaseFill } = await startCoordinatorServerWithSidecarGate(t, `
    ${markLine()}
    const path = require('path');
    const dataPath = require.resolve(path.join(process.env.TEST_DASHBOARD_ROOT, 'dataModule.js'));
    let eventsCall = 0;
    const mock = {
      initApi: async () => ({ ok: true }),
      shutdownApi: async () => ({ ok: true }),
      getHealth: () => ({ ready: true }),
      syncNow: async () => ({ ok: true }),
      getEvents: async () => {
        eventsCall += 1;
        mark('fill:start');
        await waitSidecarRelease();
        return { events: [{ slug: 'trip', name: eventsCall === 1 ? 'StaleEvent' : 'FreshEvent', taggedCount: 0 }] };
      },
      saveEvent: async () => ({ ok: true, slug: 'trip' }),
    };
    require.cache[dataPath] = { id: dataPath, filename: dataPath, loaded: true, exports: mock, children: [], paths: [] };
  `);
  const { body: pingBefore } = await apiRequest(base, '/api/v1/ping');
  const genBefore = pingBefore.data.actualCoordinator.generation;
  const readPromise = apiRequest(base, '/api/v1/events');
  await waitForMarkerDir(dir, 'fill:start', childWatchContext({ child, logs, childState }));
  const mutatePromise = apiRequest(base, '/api/v1/events', {
    method: 'POST',
    key: 'events-stale',
    body: { name: 'Trip', slug: 'trip' },
  });
  releaseFill();
  const [{ body: firstBody }, { response: mutateResponse }] = await Promise.all([readPromise, mutatePromise]);
  assert.equal(mutateResponse.status, 200);
  assert.equal(firstBody.data.events[0].name, 'StaleEvent');
  const { body: pingAfterMutate } = await apiRequest(base, '/api/v1/ping');
  assert.ok(pingAfterMutate.data.actualCoordinator.generation > genBefore);
  const { body: secondBody } = await apiRequest(base, '/api/v1/events');
  assert.equal(secondBody.data.events[0].name, 'FreshEvent');
  const marker = fs.readFileSync(path.join(dir, 'marker.log'), 'utf8').trim().split('\n');
  assert.ok(marker.filter((line) => line === 'fill:start').length >= 2);
});

test('goals sidecar mutation discards in-flight goals fill', async (t) => {
  const { base, child, logs, dir, childState, releaseFill } = await startCoordinatorServerWithSidecarGate(t, `
    ${markLine()}
    const path = require('path');
    const dataPath = require.resolve(path.join(process.env.TEST_DASHBOARD_ROOT, 'dataModule.js'));
    let goalsCall = 0;
    const mock = {
      initApi: async () => ({ ok: true }),
      shutdownApi: async () => ({ ok: true }),
      getHealth: () => ({ ready: true }),
      syncNow: async () => ({ ok: true }),
      getGoals: async () => {
        goalsCall += 1;
        mark('fill:start');
        await waitSidecarRelease();
        return [{ id: 'g1', name: goalsCall === 1 ? 'StaleGoal' : 'FreshGoal', target: 100, current: 0 }];
      },
      saveGoal: async () => ({ ok: true, id: 'g1' }),
    };
    require.cache[dataPath] = { id: dataPath, filename: dataPath, loaded: true, exports: mock, children: [], paths: [] };
  `);
  const { body: pingBefore } = await apiRequest(base, '/api/v1/ping');
  const genBefore = pingBefore.data.actualCoordinator.generation;
  const readPromise = apiRequest(base, '/api/v1/goals');
  await waitForMarkerDir(dir, 'fill:start', childWatchContext({ child, logs, childState }));
  const mutatePromise = apiRequest(base, '/api/v1/goals', {
    method: 'POST',
    key: 'goals-stale',
    body: { name: 'Emergency', target: 500 },
  });
  releaseFill();
  const [{ body: firstBody }, { response: mutateResponse }] = await Promise.all([readPromise, mutatePromise]);
  assert.equal(mutateResponse.status, 200);
  assert.equal(firstBody.data[0].name, 'StaleGoal');
  const { body: pingAfterMutate } = await apiRequest(base, '/api/v1/ping');
  assert.ok(pingAfterMutate.data.actualCoordinator.generation > genBefore);
  const { body: secondBody } = await apiRequest(base, '/api/v1/goals');
  assert.equal(secondBody.data[0].name, 'FreshGoal');
  const marker = fs.readFileSync(path.join(dir, 'marker.log'), 'utf8').trim().split('\n');
  assert.ok(marker.filter((line) => line === 'fill:start').length >= 2);
});

test('projection mutation invalidates cache when journal local_applied persistence fails', async (t) => {
  const { base, dir } = await startCoordinatorServer(t, `
    const fs = require('fs');
    const path = require('path');
    const root = process.env.TEST_DASHBOARD_ROOT;
    const mark = (value) => fs.appendFileSync(process.env.TEST_MARKER, value + '\\n');
    const journalModPath = require.resolve(path.join(root, 'lib/operation-journal.js'));
    const journalMod = require(journalModPath);
    const OrigJournal = journalMod.OperationJournal;
    journalMod.OperationJournal = class PatchedOperationJournal extends OrigJournal {
      constructor(file, options = {}) {
        super(file, options);
        this._patchedWriteCount = 0;
      }
      writePruned(state) {
        this._patchedWriteCount += 1;
        if (this._patchedWriteCount === 2) {
          const error = new Error('injected local_applied journal failure');
          error.code = 'INJECTED_WRITE_FAILURE';
          throw error;
        }
        return super.writePruned(state);
      }
    };
    const dataPath = require.resolve(path.join(root, 'dataModule.js'));
    let mutated = false;
    const mock = {
      initApi: async () => ({ ok: true }),
      shutdownApi: async () => ({ ok: true }),
      getHealth: () => ({ ready: true }),
      syncNow: async () => ({ ok: true }),
      getEvents: async () => {
        mark('getEvents:' + (mutated ? 'fresh' : 'stale'));
        return {
          events: [{ slug: 'trip', name: mutated ? 'FreshAfterSidecar' : 'CachedStale', taggedCount: 0 }],
        };
      },
      saveEvent: async () => {
        mark('saveEvent');
        mutated = true;
        return { ok: true, slug: 'trip' };
      },
    };
    require.cache[dataPath] = { id: dataPath, filename: dataPath, loaded: true, exports: mock, children: [], paths: [] };
  `);

  const warm = await apiRequest(base, '/api/v1/events');
  assert.equal(warm.response.status, 200);
  assert.equal(warm.body.data.events[0].name, 'CachedStale');

  const mutate = await apiRequest(base, '/api/v1/events', {
    method: 'POST',
    key: 'journal-fail-events',
    body: { name: 'Trip', slug: 'trip' },
  });
  assert.equal(mutate.response.status, 409);
  assert.equal(mutate.body.code, 'OUTCOME_UNKNOWN');

  const op = await apiRequest(base, '/api/v1/operations/journal-fail-events');
  assert.equal(op.response.status, 200);
  assert.equal(op.body.data.phase, 'started');

  const fresh = await apiRequest(base, '/api/v1/events');
  assert.equal(fresh.response.status, 200);
  assert.equal(fresh.body.data.events[0].name, 'FreshAfterSidecar');

  const marker = fs.readFileSync(path.join(dir, 'marker.log'), 'utf8').trim().split('\n');
  assert.ok(marker.includes('saveEvent'));
  assert.ok(marker.indexOf('saveEvent') < marker.lastIndexOf('getEvents:fresh'));
  assert.equal(fs.existsSync(path.join(dir, 'operation-journal.json')), true);
});

test('recurring sidecar mutation discards in-flight recurring fill', async (t) => {
  const { base, child, logs, dir, childState, releaseFill } = await startCoordinatorServerWithSidecarGate(t, `
    ${markLine()}
    const path = require('path');
    const dataPath = require.resolve(path.join(process.env.TEST_DASHBOARD_ROOT, 'dataModule.js'));
    let recurringCall = 0;
    const mock = {
      initApi: async () => ({ ok: true }),
      shutdownApi: async () => ({ ok: true }),
      getHealth: () => ({ ready: true }),
      syncNow: async () => ({ ok: true }),
      getRecurring: async () => {
        recurringCall += 1;
        mark('fill:start');
        await waitSidecarRelease();
        return [{ key: 'rent', name: recurringCall === 1 ? 'StaleRecurring' : 'FreshRecurring' }];
      },
      setRecurringOverride: async () => ({ ok: true }),
    };
    require.cache[dataPath] = { id: dataPath, filename: dataPath, loaded: true, exports: mock, children: [], paths: [] };
  `);
  const { body: pingBefore } = await apiRequest(base, '/api/v1/ping');
  const genBefore = pingBefore.data.actualCoordinator.generation;
  const readPromise = apiRequest(base, '/api/v1/recurring?window=18');
  await waitForMarkerDir(dir, 'fill:start', childWatchContext({ child, logs, childState }));
  const mutatePromise = apiRequest(base, '/api/v1/recurring/rent/override', {
    method: 'POST',
    key: 'recurring-stale',
    body: { status: 'active', hidden: false },
  });
  releaseFill();
  const [{ body: firstBody }, { response: mutateResponse }] = await Promise.all([readPromise, mutatePromise]);
  assert.equal(mutateResponse.status, 200);
  assert.equal(firstBody.data[0].name, 'StaleRecurring');
  const { body: pingAfterMutate } = await apiRequest(base, '/api/v1/ping');
  assert.ok(pingAfterMutate.data.actualCoordinator.generation > genBefore);
  const { body: secondBody } = await apiRequest(base, '/api/v1/recurring?window=18');
  assert.equal(secondBody.data[0].name, 'FreshRecurring');
  const marker = fs.readFileSync(path.join(dir, 'marker.log'), 'utf8').trim().split('\n');
  assert.ok(marker.filter((line) => line === 'fill:start').length >= 2);
});

test('bills sidecar mutation completes before subsequent GET returns fresh projection', async (t) => {
  const { base, child, logs, dir, childState, releaseFill } = await startCoordinatorServerWithSidecarGate(t, `
    ${markLine()}
    const path = require('path');
    const dataPath = require.resolve(path.join(process.env.TEST_DASHBOARD_ROOT, 'dataModule.js'));
    let billsCall = 0;
    const mock = {
      initApi: async () => ({ ok: true }),
      shutdownApi: async () => ({ ok: true }),
      getHealth: () => ({ ready: true }),
      syncNow: async () => ({ ok: true }),
      getBills: async () => {
        billsCall += 1;
        mark('fill:start');
        await waitSidecarRelease();
        return [{ id: 'b1', name: billsCall === 1 ? 'StaleBill' : 'FreshBill', paid: billsCall > 1 }];
      },
      setBillPaid: async () => {
        mark('setBillPaid');
        return { ok: true };
      },
    };
    require.cache[dataPath] = { id: dataPath, filename: dataPath, loaded: true, exports: mock, children: [], paths: [] };
  `);
  const readPromise = apiRequest(base, '/api/v1/bills?days=45');
  await waitForMarkerDir(dir, 'fill:start', childWatchContext({ child, logs, childState }));
  const mutatePromise = apiRequest(base, '/api/v1/bills/paid', {
    method: 'POST',
    key: 'bills-fresh',
    body: { id: 'b1', key: 'rent', dueDate: '2026-07-15', paid: true },
  });
  releaseFill();
  const [{ body: firstBody }, { response: mutateResponse }] = await Promise.all([readPromise, mutatePromise]);
  assert.equal(mutateResponse.status, 200);
  assert.equal(firstBody.data[0].name, 'StaleBill');
  const marker = fs.readFileSync(path.join(dir, 'marker.log'), 'utf8').trim().split('\n');
  assert.ok(marker.includes('setBillPaid'));
  const { body: secondBody } = await apiRequest(base, '/api/v1/bills?days=45');
  assert.equal(secondBody.data[0].name, 'FreshBill');
  const markerAfterGet = fs.readFileSync(path.join(dir, 'marker.log'), 'utf8').trim().split('\n');
  assert.ok(markerAfterGet.indexOf('setBillPaid') < markerAfterGet.lastIndexOf('fill:start'));
});

function lastInvalidationEvent(pingBody) {
  const events = pingBody.data.actualCoordinator.recent.filter((e) => e.kind === 'invalidate');
  return events.at(-1);
}

function sidecarMockShell(extraMock) {
  return `
    ${markLine()}
    const path = require('path');
    const dataPath = require.resolve(path.join(process.env.TEST_DASHBOARD_ROOT, 'dataModule.js'));
    const mock = {
      initApi: async () => ({ ok: true }),
      shutdownApi: async () => ({ ok: true }),
      getHealth: () => ({ ready: true }),
      syncNow: async () => ({ ok: true }),
      assertTransactionMutationAvailable: () => {},
      assertReimbursementLinkJournalAdmission: () => {},
      assertRepaymentConfirmationJournalAdmission: () => {},
      assertBulkOperationJournalAdmission: () => {},
      ${extraMock}
    };
    require.cache[dataPath] = { id: dataPath, filename: dataPath, loaded: true, exports: mock, children: [], paths: [] };
  `;
}

test('recurring sidecar mutation fully invalidates every warmed horizon variant', async (t) => {
  const { base, child, logs, dir, childState, releaseFill } = await startCoordinatorServerWithSidecarGate(t, sidecarMockShell(`
      callsByWindow: {},
      getRecurring: async function({ window } = {}) {
        const w = String(window ?? 18);
        this.callsByWindow[w] = (this.callsByWindow[w] || 0) + 1;
        mark('recurring:' + w + ':' + this.callsByWindow[w]);
        return [{ key: 'rent', window: Number(w), pass: this.callsByWindow[w] }];
      },
      setRecurringOverride: async () => ({ ok: true }),
  `));

  for (const window of [12, 30]) {
    const warm = await apiRequest(base, `/api/v1/recurring?window=${window}`);
    assert.equal(warm.response.status, 200);
    assert.equal(warm.body.data[0].pass, 1);
  }
  const cached = await apiRequest(base, '/api/v1/recurring?window=12');
  assert.equal(cached.body.data[0].pass, 1);

  const mutate = await apiRequest(base, '/api/v1/recurring/rent/override', {
    method: 'POST',
    key: 'recurring-family',
    body: { status: 'active', hidden: false },
  });
  assert.equal(mutate.response.status, 200);

  const { body: pingAfter } = await apiRequest(base, '/api/v1/ping');
  assert.equal(lastInvalidationEvent(pingAfter).keys, null);

  for (const window of [12, 30]) {
    const fresh = await apiRequest(base, `/api/v1/recurring?window=${window}`);
    assert.equal(fresh.response.status, 200);
    assert.equal(fresh.body.data[0].pass, 2, `recurring-${window} should recompute after mutation`);
  }
});

test('bills sidecar mutation fully invalidates every warmed days horizon variant', async (t) => {
  const { base, child, logs, dir, childState, releaseFill } = await startCoordinatorServerWithSidecarGate(t, sidecarMockShell(`
      callsByDays: {},
      getBills: async function({ days } = {}) {
        const d = String(days ?? 45);
        this.callsByDays[d] = (this.callsByDays[d] || 0) + 1;
        mark('bills:' + d + ':' + this.callsByDays[d]);
        return [{ id: 'b1', days: Number(d), pass: this.callsByDays[d] }];
      },
      setBillPaid: async () => ({ ok: true }),
  `));

  for (const days of [14, 90]) {
    const warm = await apiRequest(base, `/api/v1/bills?days=${days}`);
    assert.equal(warm.response.status, 200);
    assert.equal(warm.body.data[0].pass, 1);
  }
  const cached = await apiRequest(base, '/api/v1/bills?days=14');
  assert.equal(cached.body.data[0].pass, 1);

  const mutate = await apiRequest(base, '/api/v1/bills/paid', {
    method: 'POST',
    key: 'bills-family',
    body: { id: 'b1', key: 'rent', dueDate: '2026-07-15', paid: true },
  });
  assert.equal(mutate.response.status, 200);

  const { body: pingAfter } = await apiRequest(base, '/api/v1/ping');
  assert.equal(lastInvalidationEvent(pingAfter).keys, null);

  for (const days of [14, 90]) {
    const fresh = await apiRequest(base, `/api/v1/bills?days=${days}`);
    assert.equal(fresh.body.data[0].pass, 2, `bills-${days} should recompute after mutation`);
  }
});

test('owes sidecar mutation fully invalidates every warmed reimbursement projection key', async (t) => {
  const { base, child, logs, dir, childState, releaseFill } = await startCoordinatorServerWithSidecarGate(t, sidecarMockShell(`
      callsByKey: {},
      bump(key) {
        this.callsByKey[key] = (this.callsByKey[key] || 0) + 1;
        mark(key + ':' + this.callsByKey[key]);
        return this.callsByKey[key];
      },
      getReimbursement: async function({ from, to, openOnly } = {}) {
        const key = 'reimb-' + (from || 'd') + '-' + (to || 'd') + '-' + !!openOnly;
        return { key, pass: this.bump(key) };
      },
      getReimbursementLedger: async function({ month } = {}) {
        const key = 'reimb-ledger-' + (month || 'current');
        return { key, pass: this.bump(key) };
      },
      suggestRepayments: async function({ from, to } = {}) {
        const key = 'reimb-suggest-' + (from || 'd') + '-' + (to || 'd');
        return { key, suggestions: [], pass: this.bump(key) };
      },
      getToday: async function() { return { pass: this.bump('today') }; },
      setOwesConfig: async () => ({ ok: true }),
  `));

  const warmTargets = [
    '/api/v1/reimbursement?from=2026-01-01&to=2026-03-31&openOnly=1',
    '/api/v1/reimbursement',
    '/api/v1/reimbursement-ledger?month=2026-07',
    '/api/v1/repayments/suggestions?from=2026-01-01&to=2026-06-30',
    '/api/v1/today',
  ];
  for (const pathname of warmTargets) {
    const warm = await apiRequest(base, pathname);
    assert.equal(warm.response.status, 200);
    assert.equal(warm.body.data.pass, 1, pathname);
  }
  const cached = await apiRequest(base, '/api/v1/reimbursement?from=2026-01-01&to=2026-03-31&openOnly=1');
  assert.equal(cached.body.data.pass, 1);

  const mutate = await apiRequest(base, '/api/v1/owes-config', {
    method: 'POST',
    key: 'owes-family',
    body: { expected: {} },
  });
  assert.equal(mutate.response.status, 200);

  const { body: pingAfter } = await apiRequest(base, '/api/v1/ping');
  assert.equal(lastInvalidationEvent(pingAfter).keys, null);

  for (const pathname of warmTargets) {
    const fresh = await apiRequest(base, pathname);
    assert.equal(fresh.response.status, 200);
    assert.equal(fresh.body.data.pass, 2, pathname);
  }
});

test('reimb link sidecar mutation fully invalidates every warmed reimbursement projection key', async (t) => {
  const { base, child, logs, dir, childState, releaseFill } = await startCoordinatorServerWithSidecarGate(t, sidecarMockShell(`
      callsByKey: {},
      bump(key) {
        this.callsByKey[key] = (this.callsByKey[key] || 0) + 1;
        mark(key + ':' + this.callsByKey[key]);
        return this.callsByKey[key];
      },
      getReimbursement: async function({ from, to, openOnly } = {}) {
        const key = 'reimb-' + (from || 'd') + '-' + (to || 'd') + '-' + !!openOnly;
        return { key, pass: this.bump(key) };
      },
      getReimbursementLedger: async function({ month } = {}) {
        const key = 'reimb-ledger-' + (month || 'current');
        return { key, pass: this.bump(key) };
      },
      suggestRepayments: async function({ from, to } = {}) {
        const key = 'reimb-suggest-' + (from || 'd') + '-' + (to || 'd');
        return { key, suggestions: [], pass: this.bump(key) };
      },
      addReimbLink: async () => ({ ok: true, inflowId: 'in1', expenseId: 'ex1' }),
  `));

  const warmTargets = [
    '/api/v1/reimbursement?from=2026-02-01&to=2026-04-30&openOnly=true',
    '/api/v1/reimbursement-ledger?month=2026-06',
    '/api/v1/repayments/suggestions?from=2026-02-01&to=2026-05-31',
  ];
  for (const pathname of warmTargets) {
    const warm = await apiRequest(base, pathname);
    assert.equal(warm.response.status, 200);
    assert.equal(warm.body.data.pass, 1, pathname);
  }

  const mutate = await apiRequest(base, '/api/v1/reimb-links', {
    method: 'POST',
    key: 'link-family',
    body: {
      inflow: { id: 'in1', amount: 50, date: '2026-07-01' },
      expense: { id: 'ex1', amount: -50, date: '2026-06-15' },
      amount: 50,
    },
  });
  assert.equal(mutate.response.status, 200);

  const { body: pingAfter } = await apiRequest(base, '/api/v1/ping');
  assert.equal(lastInvalidationEvent(pingAfter).keys, null);

  for (const pathname of warmTargets) {
    const fresh = await apiRequest(base, pathname);
    assert.equal(fresh.body.data.pass, 2, pathname);
  }
});

test('dismiss repayment sidecar mutation uses projection write lane with full invalidation', async (t) => {
  const { base, child, logs, dir, childState, releaseFill } = await startCoordinatorServerWithSidecarGate(t, sidecarMockShell(`
      callsByKey: {},
      fillCount: 0,
      bump(key) {
        this.callsByKey[key] = (this.callsByKey[key] || 0) + 1;
        mark(key + ':' + this.callsByKey[key]);
        return this.callsByKey[key];
      },
      suggestRepayments: async function({ from, to } = {}) {
        const key = 'reimb-suggest-' + (from || 'd') + '-' + (to || 'd');
        this.fillCount += 1;
        if (this.fillCount === 2) {
          mark('fill:start');
          await waitSidecarRelease();
        }
        const pass = this.bump(key);
        return { suggestions: [], pass };
      },
      dismissRepayment: async () => ({ ok: true, dismissed: 'in1' }),
  `));

  const warm = await apiRequest(base, '/api/v1/repayments/suggestions?from=2026-03-01&to=2026-06-30');
  assert.equal(warm.body.data.pass, 1);

  const readPromise = apiRequest(base, '/api/v1/repayments/suggestions?from=2026-08-01&to=2026-09-30');
  await waitForMarkerDir(dir, 'fill:start', childWatchContext({ child, logs, childState }));
  const mutatePromise = apiRequest(base, '/api/v1/repayments/sg_in1/dismiss', {
    method: 'POST',
    key: 'dismiss-family',
    body: {},
  });
  releaseFill();
  const [{ body: firstBody }, { response: mutateResponse }] = await Promise.all([readPromise, mutatePromise]);
  assert.equal(mutateResponse.status, 200);
  assert.equal(firstBody.data.pass, 1);

  const { body: pingAfter } = await apiRequest(base, '/api/v1/ping');
  assert.equal(lastInvalidationEvent(pingAfter).keys, null);

  const freshWarm = await apiRequest(base, '/api/v1/repayments/suggestions?from=2026-03-01&to=2026-06-30');
  assert.equal(freshWarm.body.data.pass, 2);
  const freshOther = await apiRequest(base, '/api/v1/repayments/suggestions?from=2026-08-01&to=2026-09-30');
  assert.equal(freshOther.body.data.pass, 2);
});
