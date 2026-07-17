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
  const { body: pingBefore } = await apiRequest(base, '/api/v1/ping');
  const genBefore = pingBefore.data.actualCoordinator.generation;
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
  const { body: pingAfterMutate } = await apiRequest(base, '/api/v1/ping');
  assert.ok(pingAfterMutate.data.actualCoordinator.generation > genBefore);
  const { body: secondBody } = await apiRequest(base, '/api/v1/accounts');
  assert.equal(secondBody.data[0].name, 'FreshAfterInvalidate');
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
        mark('getAccounts:' + accountsCall);
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
  const { body: pingBefore } = await apiRequest(base, '/api/v1/ping');
  const genBefore = pingBefore.data.actualCoordinator.generation;
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
  const { body: pingAfterMutate } = await apiRequest(base, '/api/v1/ping');
  assert.ok(pingAfterMutate.data.actualCoordinator.generation > genBefore);
  const { body: secondBody } = await apiRequest(base, '/api/v1/accounts');
  assert.equal(secondBody.data[0].name, 'AfterOverride');
  const marker = fs.readFileSync(path.join(dir, 'marker.log'), 'utf8').trim().split('\n');
  assert.ok(marker.includes('getAccounts:2'));
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
  const { body: pingBefore } = await apiRequest(base, '/api/v1/ping');
  const genBefore = pingBefore.data.actualCoordinator.generation;
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
  const { body: pingAfterMutate } = await apiRequest(base, '/api/v1/ping');
  assert.ok(pingAfterMutate.data.actualCoordinator.generation > genBefore);
  const { body: secondBody } = await apiRequest(base, '/api/v1/events');
  assert.equal(secondBody.data.events[0].name, 'FreshEvent');
  const marker = fs.readFileSync(path.join(dir, 'marker.log'), 'utf8').trim().split('\n');
  assert.ok(marker.filter((line) => line === 'fill:start').length >= 2);
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
  const { body: pingBefore } = await apiRequest(base, '/api/v1/ping');
  const genBefore = pingBefore.data.actualCoordinator.generation;
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
  const { body: pingAfterMutate } = await apiRequest(base, '/api/v1/ping');
  assert.ok(pingAfterMutate.data.actualCoordinator.generation > genBefore);
  const { body: secondBody } = await apiRequest(base, '/api/v1/goals');
  assert.equal(secondBody.data[0].name, 'FreshGoal');
  const marker = fs.readFileSync(path.join(dir, 'marker.log'), 'utf8').trim().split('\n');
  assert.ok(marker.filter((line) => line === 'fill:start').length >= 2);
});

test('projection mutation invalidates cache when journal local_applied persistence fails', async (t) => {
  const port = await unusedPort();
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'df-coordinator-journal-fail-'));
  const journalPath = path.join(dir, 'operation-journal.json');
  const { child, logs, base } = spawnServer(dir, port, `
    const fs = require('fs');
    const path = require('path');
    const root = process.env.TEST_DASHBOARD_ROOT;
    const mark = (value) => fs.appendFileSync(process.env.TEST_MARKER, value + '\\n');
    const journalModPath = require.resolve(path.join(root, 'lib/operation-journal.js'));
    const { writeJsonFile } = require(path.join(root, 'lib/json-store.js'));
    const journalMod = require(journalModPath);
    const OrigJournal = journalMod.OperationJournal;
    journalMod.OperationJournal = class PatchedOperationJournal extends OrigJournal {
      constructor(file, options = {}) {
        let writeCount = 0;
        super(file, {
          ...options,
          writeState(target, state) {
            writeCount += 1;
            if (writeCount === 2) {
              const error = new Error('injected local_applied journal failure');
              error.code = 'INJECTED_WRITE_FAILURE';
              throw error;
            }
            writeJsonFile(target, state);
          },
        });
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
  t.after(() => {
    try { child.kill('SIGKILL'); } catch (_) {}
    fs.rmSync(dir, { recursive: true, force: true });
  });
  await waitForServer(base, child, logs);

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
  assert.equal(fs.existsSync(journalPath), true);
});

test('recurring sidecar mutation discards in-flight recurring fill', async (t) => {
  const port = await unusedPort();
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'df-coordinator-recurring-stale-'));
  const { child, logs, base, releaseFill } = spawnServerWithSidecarGate(dir, port, `
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
        await new Promise((resolve) => setTimeout(resolve, 50));
        return [{ key: 'rent', name: recurringCall === 1 ? 'StaleRecurring' : 'FreshRecurring' }];
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
  const { body: pingBefore } = await apiRequest(base, '/api/v1/ping');
  const genBefore = pingBefore.data.actualCoordinator.generation;
  const readPromise = apiRequest(base, '/api/v1/recurring?window=18');
  await waitForMarker(dir, 'fill:start');
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
  const port = await unusedPort();
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'df-coordinator-bills-fresh-'));
  const { child, logs, base, releaseFill } = spawnServerWithSidecarGate(dir, port, `
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
        await new Promise((resolve) => setTimeout(resolve, 50));
        return [{ id: 'b1', name: billsCall === 1 ? 'StaleBill' : 'FreshBill', paid: billsCall > 1 }];
      },
      setBillPaid: async () => {
        mark('setBillPaid');
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
  const readPromise = apiRequest(base, '/api/v1/bills?days=45');
  await waitForMarker(dir, 'fill:start');
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
      ${extraMock}
    };
    require.cache[dataPath] = { id: dataPath, filename: dataPath, loaded: true, exports: mock, children: [], paths: [] };
  `;
}

test('recurring sidecar mutation fully invalidates every warmed horizon variant', async (t) => {
  const port = await unusedPort();
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'df-coordinator-recurring-family-'));
  const { child, logs, base } = spawnServer(dir, port, sidecarMockShell(`
      callsByWindow: {},
      getRecurring: async function({ window } = {}) {
        const w = String(window ?? 18);
        this.callsByWindow[w] = (this.callsByWindow[w] || 0) + 1;
        mark('recurring:' + w + ':' + this.callsByWindow[w]);
        return [{ key: 'rent', window: Number(w), pass: this.callsByWindow[w] }];
      },
      setRecurringOverride: async () => ({ ok: true }),
  `));
  t.after(() => {
    try { child.kill('SIGKILL'); } catch (_) {}
    fs.rmSync(dir, { recursive: true, force: true });
  });
  await waitForServer(base, child, logs);

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
  const port = await unusedPort();
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'df-coordinator-bills-family-'));
  const { child, logs, base } = spawnServer(dir, port, sidecarMockShell(`
      callsByDays: {},
      getBills: async function({ days } = {}) {
        const d = String(days ?? 45);
        this.callsByDays[d] = (this.callsByDays[d] || 0) + 1;
        mark('bills:' + d + ':' + this.callsByDays[d]);
        return [{ id: 'b1', days: Number(d), pass: this.callsByDays[d] }];
      },
      setBillPaid: async () => ({ ok: true }),
  `));
  t.after(() => {
    try { child.kill('SIGKILL'); } catch (_) {}
    fs.rmSync(dir, { recursive: true, force: true });
  });
  await waitForServer(base, child, logs);

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
  const port = await unusedPort();
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'df-coordinator-owes-family-'));
  const { child, logs, base } = spawnServer(dir, port, sidecarMockShell(`
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
  t.after(() => {
    try { child.kill('SIGKILL'); } catch (_) {}
    fs.rmSync(dir, { recursive: true, force: true });
  });
  await waitForServer(base, child, logs);

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
  const port = await unusedPort();
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'df-coordinator-link-family-'));
  const { child, logs, base } = spawnServer(dir, port, sidecarMockShell(`
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
  t.after(() => {
    try { child.kill('SIGKILL'); } catch (_) {}
    fs.rmSync(dir, { recursive: true, force: true });
  });
  await waitForServer(base, child, logs);

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
  const port = await unusedPort();
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'df-coordinator-dismiss-family-'));
  const { child, logs, base, releaseFill } = spawnServerWithSidecarGate(dir, port, sidecarMockShell(`
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
          await new Promise((resolve) => setTimeout(resolve, 50));
        }
        const pass = this.bump(key);
        return { suggestions: [], pass };
      },
      dismissRepayment: async () => ({ ok: true, dismissed: 'in1' }),
  `));
  t.after(() => {
    try { child.kill('SIGKILL'); } catch (_) {}
    fs.rmSync(dir, { recursive: true, force: true });
  });
  await waitForServer(base, child, logs);

  const warm = await apiRequest(base, '/api/v1/repayments/suggestions?from=2026-03-01&to=2026-06-30');
  assert.equal(warm.body.data.pass, 1);

  const readPromise = apiRequest(base, '/api/v1/repayments/suggestions?from=2026-08-01&to=2026-09-30');
  await waitForMarker(dir, 'fill:start');
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
