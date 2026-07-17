'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const net = require('net');
const os = require('os');
const path = require('path');
const { spawn } = require('child_process');

async function unusedPort() {
  return new Promise((resolve, reject) => {
    const server = net.createServer();
    server.once('error', reject);
    server.listen(0, '127.0.0.1', () => {
      const { port } = server.address();
      server.close((error) => error ? reject(error) : resolve(port));
    });
  });
}

async function waitForServer(base, child, logs) {
  const deadline = Date.now() + 10_000;
  while (Date.now() < deadline) {
    if (child.exitCode != null) throw new Error(`server exited early: ${logs.value}`);
    try {
      const response = await fetch(`${base}/auth/status`);
      if (response.ok) return;
    } catch (_) {}
    await new Promise((resolve) => setTimeout(resolve, 25));
  }
  throw new Error(`server startup timeout: ${logs.value}`);
}

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

function spawnServer(dir, port, preloadBody, extraEnv = {}) {
  const dashboardRoot = path.resolve(__dirname, '..');
  const preload = path.join(dir, 'mock-data-module.js');
  fs.writeFileSync(preload, preloadBody);
  const logs = { value: '' };
  const child = spawn(process.execPath, ['server.js'], {
    cwd: dashboardRoot,
    env: {
      ...process.env,
      NODE_ENV: 'test',
      DEMO_ONLY: '1',
      NODE_OPTIONS: `${process.env.NODE_OPTIONS || ''} --require=${preload}`.trim(),
      PORT: String(port),
      PUBLIC_ORIGIN: `http://localhost:${port}`,
      WEBAUTHN_ORIGIN: `http://localhost:${port}`,
      WEBAUTHN_RP_ID: 'localhost',
      FINANCE_API_TOKEN: 'test-api-token',
      SESSION_SECRET: 'test-session-secret-with-sufficient-length',
      SESSION_DIR: path.join(dir, 'sessions'),
      OPERATION_JOURNAL_PATH: path.join(dir, 'operation-journal.json'),
      PASSKEY_CREDENTIALS_FILE: path.join(dir, 'credentials.json'),
      TEST_DASHBOARD_ROOT: dashboardRoot,
      TEST_MARKER: path.join(dir, 'marker.log'),
      ...extraEnv,
    },
    stdio: ['ignore', 'pipe', 'pipe'],
  });
  child.stdout.on('data', (chunk) => { logs.value += chunk; });
  child.stderr.on('data', (chunk) => { logs.value += chunk; });
  return { child, logs, base: `http://127.0.0.1:${port}` };
}

function markLine() {
  return `
    const fs = require('fs');
    const mark = (value) => fs.appendFileSync(process.env.TEST_MARKER, value + '\\n');
    const waitSidecarRelease = async () => {
      while (!fs.existsSync(process.env.TEST_RELEASE_PATH)) {
        await new Promise((resolve) => setTimeout(resolve, 5));
      }
    };
  `;
}

async function waitForMarker(dir, line, timeoutMs = 10_000) {
  const markerPath = path.join(dir, 'marker.log');
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    if (fs.existsSync(markerPath)) {
      const content = fs.readFileSync(markerPath, 'utf8');
      if (content.includes(`${line}\n`) || content.trimEnd().endsWith(line)) return;
    }
    await new Promise((resolve) => setTimeout(resolve, 5));
  }
  throw new Error(`marker line not seen: ${line}\n${fs.existsSync(markerPath) ? fs.readFileSync(markerPath, 'utf8') : ''}`);
}

function spawnServerWithSidecarGate(dir, port, preloadBody) {
  const releasePath = path.join(dir, 'release.fill');
  const spawned = spawnServer(dir, port, preloadBody, { TEST_RELEASE_PATH: releasePath });
  return {
    ...spawned,
    releaseFill() {
      fs.writeFileSync(releasePath, '1');
    },
  };
}

test('queued write blocks overlapping Actual-backed GET', async (t) => {
  const port = await unusedPort();
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'df-coordinator-block-'));
  const { child, logs, base } = spawnServer(dir, port, `
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
        await new Promise((resolve) => setTimeout(resolve, 30));
        return [{ id: 'a1', name: 'Checking' }];
      },
      setBudgetAmount: async () => {
        writeStarted = true;
        mark('setBudget:start');
        await new Promise((resolve) => setTimeout(resolve, 40));
        mark('setBudget:end');
        return { ok: true, needsSync: true };
      },
    };
    require.cache[dataPath] = { id: dataPath, filename: dataPath, loaded: true, exports: mock, children: [], paths: [] };
  `);
  t.after(() => {
    child.kill('SIGTERM');
    fs.rmSync(dir, { recursive: true, force: true });
  });
  await waitForServer(base, child, logs);

  const postPromise = apiRequest(base, '/api/v1/budgets', {
    method: 'POST',
    key: 'budget-block-get',
    body: { month: '2026-07', categoryId: 'food', amount: 100 },
  });
  await new Promise((resolve) => setTimeout(resolve, 5));
  const getPromise = apiRequest(base, '/api/v1/accounts');
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
  const port = await unusedPort();
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'df-coordinator-order-'));
  const { child, logs, base } = spawnServer(dir, port, `
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
  t.after(() => {
    child.kill('SIGTERM');
    fs.rmSync(dir, { recursive: true, force: true });
  });
  await waitForServer(base, child, logs);
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
  const port = await unusedPort();
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'df-coordinator-fail-read-'));
  const { child, logs, base } = spawnServer(dir, port, `
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
  t.after(() => {
    child.kill('SIGTERM');
    fs.rmSync(dir, { recursive: true, force: true });
  });
  await waitForServer(base, child, logs);
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
  const port = await unusedPort();
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'df-coordinator-local-read-'));
  const { child, logs, base } = spawnServer(dir, port, `
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
        await new Promise((resolve) => setTimeout(resolve, 40));
        mark('actual-read:end');
        return [];
      },
      getRules: () => { mark('local-rules'); return { rules: [] }; },
      getCatalogDisplay: () => [],
    };
    require.cache[dataPath] = { id: dataPath, filename: dataPath, loaded: true, exports: mock, children: [], paths: [] };
  `);
  t.after(() => {
    child.kill('SIGTERM');
    fs.rmSync(dir, { recursive: true, force: true });
  });
  await waitForServer(base, child, logs);
  const actualRead = apiRequest(base, '/api/v1/accounts');
  await new Promise((resolve) => setTimeout(resolve, 5));
  const localRead = apiRequest(base, '/api/v1/rules');
  await Promise.all([actualRead, localRead]);
  const marker = fs.readFileSync(path.join(dir, 'marker.log'), 'utf8').trim().split('\n');
  const rulesIdx = marker.indexOf('local-rules');
  const actualEnd = marker.indexOf('actual-read:end');
  assert.ok(rulesIdx >= 0);
  assert.ok(rulesIdx < actualEnd);
});

test('operation replay stays on mutation queue after coordinator write', async (t) => {
  const port = await unusedPort();
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'df-coordinator-replay-'));
  const { child, logs, base } = spawnServer(dir, port, `
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
  t.after(() => {
    child.kill('SIGTERM');
    fs.rmSync(dir, { recursive: true, force: true });
  });
  await waitForServer(base, child, logs);
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
  const port = await unusedPort();
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'df-coordinator-ping-'));
  const { child, logs, base } = spawnServer(dir, port, `
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
  t.after(() => {
    child.kill('SIGTERM');
    fs.rmSync(dir, { recursive: true, force: true });
  });
  await waitForServer(base, child, logs);
  const { body, response } = await apiRequest(base, '/api/v1/ping');
  assert.equal(response.status, 200);
  assert.ok(body.data.actualCoordinator);
  assert.equal(typeof body.data.actualCoordinator.generation, 'number');
  assert.equal(typeof body.data.actualCoordinator.queued, 'number');
  assert.ok(body.data.actualCoordinator.stats);
  assert.ok(Array.isArray(body.data.actualCoordinator.recent));
});

test('shutdown drains mutations then shutdownApi without pre-closing coordinator', async (t) => {
  const port = await unusedPort();
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'df-coordinator-shutdown-'));
  const { child, logs, base } = spawnServer(dir, port, `
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
  t.after(() => {
    try { child.kill('SIGKILL'); } catch (_) {}
    fs.rmSync(dir, { recursive: true, force: true });
  });
  await waitForServer(base, child, logs);
  const pending = apiRequest(base, '/api/v1/budgets', {
    method: 'POST',
    key: 'shutdown-write',
    body: { month: '2026-07', categoryId: 'food', amount: 5 },
  });
  await new Promise((resolve) => setTimeout(resolve, 5));
  child.kill('SIGTERM');
  const exitCode = await new Promise((resolve) => {
    child.on('exit', (code) => resolve(code));
    setTimeout(() => resolve(undefined), 15_000);
  });
  await pending;
  const marker = fs.readFileSync(path.join(dir, 'marker.log'), 'utf8').trim().split('\n');
  assert.ok(marker.includes('mutation:start'));
  assert.ok(marker.includes('mutation:end'));
  assert.ok(marker.includes('shutdown'));
  if (exitCode != null) assert.equal(exitCode, 0);
});

test('production-path cachedActual fill cannot republish after mutation invalidates generation', async (t) => {
  const port = await unusedPort();
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'df-coordinator-stale-repub-'));
  const { child, logs, base } = spawnServer(dir, port, `
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
        await new Promise((resolve) => setTimeout(resolve, 50));
        return [{ id: 'a1', name: accountsCall === 1 ? 'StaleDuringFill' : 'FreshAfterInvalidate' }];
      },
      setRecurringOverride: async () => ({ ok: true }),
    };
    require.cache[dataPath] = { id: dataPath, filename: dataPath, loaded: true, exports: mock, children: [], paths: [] };
  `);
  t.after(() => {
    try { child.kill('SIGKILL'); } catch (_) {}
    fs.rmSync(dir, { recursive: true, force: true });
  });
  await waitForServer(base, child, logs);
  const readPromise = apiRequest(base, '/api/v1/accounts');
  await new Promise((resolve) => setTimeout(resolve, 5));
  const invalidatePromise = apiRequest(base, '/api/v1/recurring/test-key/override', {
    method: 'POST',
    key: 'stale-repub-invalidate',
    body: { status: 'active', hidden: false },
  });
  const [{ body: firstBody }, { response: invalidateResponse }] = await Promise.all([readPromise, invalidatePromise]);
  assert.equal(invalidateResponse.status, 200);
  assert.ok(['StaleDuringFill', 'FreshAfterInvalidate'].includes(firstBody.data[0].name));
  const { body: secondBody } = await apiRequest(base, '/api/v1/accounts');
  assert.equal(secondBody.data[0].name, 'FreshAfterInvalidate');
  const { body: pingBody } = await apiRequest(base, '/api/v1/ping');
  const stats = pingBody.data.actualCoordinator.stats;
  assert.ok(stats.staleFillsDiscarded >= 1 || stats.staleFillRetries >= 1);
});

test('account override sidecar mutation discards in-flight accounts fill', async (t) => {
  const port = await unusedPort();
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'df-coordinator-override-stale-'));
  const { child, logs, base, releaseFill } = spawnServerWithSidecarGate(dir, port, `
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
        mark('fill:start');
        await waitSidecarRelease();
        await new Promise((resolve) => setTimeout(resolve, 50));
        return [{ id: 'a1', name: accountsCall === 1 ? 'BeforeOverride' : 'AfterOverride' }];
      },
      setAccountOverride: async () => ({ ok: true }),
    };
    require.cache[dataPath] = { id: dataPath, filename: dataPath, loaded: true, exports: mock, children: [], paths: [] };
  `);
  t.after(() => {
    try { child.kill('SIGKILL'); } catch (_) {}
    fs.rmSync(dir, { recursive: true, force: true });
  });
  await waitForServer(base, child, logs);
  const readPromise = apiRequest(base, '/api/v1/accounts');
  await waitForMarker(dir, 'fill:start');
  const mutatePromise = apiRequest(base, '/api/v1/accounts/a1/override', {
    method: 'POST',
    key: 'override-stale',
    body: { name: 'Renamed' },
  });
  releaseFill();
  const [{ body: firstBody }, { response: mutateResponse }] = await Promise.all([readPromise, mutatePromise]);
  assert.equal(mutateResponse.status, 200);
  assert.equal(firstBody.data[0].name, 'BeforeOverride');
  const { body: secondBody } = await apiRequest(base, '/api/v1/accounts');
  assert.equal(secondBody.data[0].name, 'AfterOverride');
  const { body: pingBody } = await apiRequest(base, '/api/v1/ping');
  assert.ok(pingBody.data.actualCoordinator.generation >= 1);
});

test('events sidecar mutation discards in-flight events fill', async (t) => {
  const port = await unusedPort();
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'df-coordinator-events-stale-'));
  const { child, logs, base, releaseFill } = spawnServerWithSidecarGate(dir, port, `
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
        await new Promise((resolve) => setTimeout(resolve, 50));
        return { events: [{ slug: 'trip', name: eventsCall === 1 ? 'StaleEvent' : 'FreshEvent', taggedCount: 0 }] };
      },
      saveEvent: async () => ({ ok: true, slug: 'trip' }),
    };
    require.cache[dataPath] = { id: dataPath, filename: dataPath, loaded: true, exports: mock, children: [], paths: [] };
  `);
  t.after(() => {
    try { child.kill('SIGKILL'); } catch (_) {}
    fs.rmSync(dir, { recursive: true, force: true });
  });
  await waitForServer(base, child, logs);
  const readPromise = apiRequest(base, '/api/v1/events');
  await waitForMarker(dir, 'fill:start');
  const mutatePromise = apiRequest(base, '/api/v1/events', {
    method: 'POST',
    key: 'events-stale',
    body: { name: 'Trip', slug: 'trip' },
  });
  releaseFill();
  const [{ body: firstBody }, { response: mutateResponse }] = await Promise.all([readPromise, mutatePromise]);
  assert.equal(mutateResponse.status, 200);
  assert.equal(firstBody.data.events[0].name, 'StaleEvent');
  const { body: secondBody } = await apiRequest(base, '/api/v1/events');
  assert.equal(secondBody.data.events[0].name, 'FreshEvent');
  const { body: pingBody } = await apiRequest(base, '/api/v1/ping');
  assert.ok(pingBody.data.actualCoordinator.generation >= 1);
});

test('goals sidecar mutation discards in-flight goals fill', async (t) => {
  const port = await unusedPort();
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'df-coordinator-goals-stale-'));
  const { child, logs, base, releaseFill } = spawnServerWithSidecarGate(dir, port, `
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
        await new Promise((resolve) => setTimeout(resolve, 50));
        return [{ id: 'g1', name: goalsCall === 1 ? 'StaleGoal' : 'FreshGoal', target: 100, current: 0 }];
      },
      saveGoal: async () => ({ ok: true, id: 'g1' }),
    };
    require.cache[dataPath] = { id: dataPath, filename: dataPath, loaded: true, exports: mock, children: [], paths: [] };
  `);
  t.after(() => {
    try { child.kill('SIGKILL'); } catch (_) {}
    fs.rmSync(dir, { recursive: true, force: true });
  });
  await waitForServer(base, child, logs);
  const readPromise = apiRequest(base, '/api/v1/goals');
  await waitForMarker(dir, 'fill:start');
  const mutatePromise = apiRequest(base, '/api/v1/goals', {
    method: 'POST',
    key: 'goals-stale',
    body: { name: 'Emergency', target: 500 },
  });
  releaseFill();
  const [{ body: firstBody }, { response: mutateResponse }] = await Promise.all([readPromise, mutatePromise]);
  assert.equal(mutateResponse.status, 200);
  assert.equal(firstBody.data[0].name, 'StaleGoal');
  const { body: secondBody } = await apiRequest(base, '/api/v1/goals');
  assert.equal(secondBody.data[0].name, 'FreshGoal');
  const { body: pingBody } = await apiRequest(base, '/api/v1/ping');
  assert.ok(pingBody.data.actualCoordinator.generation >= 1);
});
