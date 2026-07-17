'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const net = require('net');
const os = require('os');
const path = require('path');
const { spawn } = require('child_process');
const { OperationJournal } = require('../lib/operation-journal');
const { loadAdmissionLimitsConfig } = require('../lib/admission-limits-config');

async function unusedPort() {
  return new Promise((resolve, reject) => {
    const server = net.createServer();
    server.once('error', reject);
    server.listen(0, '127.0.0.1', () => {
      const { port } = server.address();
      server.close((error) => (error ? reject(error) : resolve(port)));
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
    await new Promise((resolve) => setImmediate(resolve));
  }
  throw new Error(`server startup timeout: ${logs.value}`);
}

function spawnServer(dir, port, extraEnv = {}) {
  const logs = { value: '' };
  const marker = path.join(dir, 'effects.log');
  const releasePath = path.join(dir, 'release.barrier');
  const preload = path.join(dir, 'mock-data-module.js');
  const dashboardRoot = path.resolve(__dirname, '..');
  fs.writeFileSync(preload, `
    const fs = require('fs');
    const path = require('path');
    const root = process.env.TEST_DASHBOARD_ROOT;
    const dataPath = require.resolve(path.join(root, 'dataModule.js'));
    const mark = (value) => fs.appendFileSync(process.env.TEST_EFFECT_MARKER, value + '\\n');
    const waitForRelease = async () => {
      while (!fs.existsSync(process.env.TEST_RELEASE_PATH)) {
        await new Promise((resolve) => setImmediate(resolve));
      }
    };
    const mock = new Proxy({
      initApi: async () => ({ ok: true }),
      shutdownApi: async () => ({ ok: true }),
      getHealth: () => ({ ready: true }),
      getAccounts: async () => {
        mark('accounts:start');
        await waitForRelease();
        mark('accounts:end');
        return [{ id: 'a1', name: 'Checking' }];
      },
      getBudgets: async ({ month }) => {
        mark('budget-read:' + (month || 'current'));
        return { month: month || '2026-07', categories: [] };
      },
      setBudgetAmount: async ({ month, categoryId, amount }) => {
        mark('budget:start');
        await waitForRelease();
        mark('budget:end:' + (month || 'unknown'));
        return { ok: true, month, categoryId, amount };
      },
      setOwesConfig: async (config) => {
        mark('setOwes:' + Object.keys(config || {}).sort().join(','));
        return { ok: true };
      },
    }, {
      get(target, property) {
        if (property in target) return target[property];
        return async () => [];
      },
    });
    require.cache[dataPath] = {
      id: dataPath,
      filename: dataPath,
      loaded: true,
      exports: mock,
      children: [],
      paths: [],
    };
  `);
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
      SELFTEST: '1',
      TEST_DASHBOARD_ROOT: dashboardRoot,
      TEST_EFFECT_MARKER: marker,
      TEST_RELEASE_PATH: releasePath,
      FINANCE_ADMISSION_READ_GLOBAL_PENDING: '4',
      FINANCE_ADMISSION_READ_GLOBAL_RUNNING: '1',
      FINANCE_ADMISSION_READ_PRINCIPAL_PENDING: '2',
      FINANCE_ADMISSION_READ_PRINCIPAL_RUNNING: '1',
      FINANCE_ADMISSION_MUTATION_GLOBAL_PENDING: '4',
      FINANCE_ADMISSION_MUTATION_GLOBAL_RUNNING: '1',
      FINANCE_ADMISSION_MUTATION_PRINCIPAL_PENDING: '2',
      FINANCE_ADMISSION_MUTATION_PRINCIPAL_RUNNING: '1',
      FINANCE_ADMISSION_LIGHTWEIGHT_GLOBAL_PENDING: '2',
      FINANCE_ADMISSION_LIGHTWEIGHT_GLOBAL_RUNNING: '1',
      FINANCE_ADMISSION_MAX_PENDING_DEPTH: '3',
      FINANCE_ADMISSION_CONTROL_RESERVE: '1',
      FINANCE_ADMISSION_RECOVERY_RESERVE: '1',
      FINANCE_ADMISSION_CHEAP_RESERVE: '1',
      FINANCE_ADMISSION_MAX_WAIT_MS: '25',
      ...extraEnv,
    },
    stdio: ['ignore', 'pipe', 'pipe'],
  });
  child.stdout.on('data', (chunk) => { logs.value += chunk; });
  child.stderr.on('data', (chunk) => { logs.value += chunk; });
  return { child, logs, marker, releasePath };
}

function tightAdmissionEnv(overrides = {}) {
  return {
    FINANCE_ADMISSION_MUTATION_GLOBAL_PENDING: '2',
    FINANCE_ADMISSION_MUTATION_GLOBAL_RUNNING: '1',
    FINANCE_ADMISSION_MUTATION_PRINCIPAL_PENDING: '1',
    FINANCE_ADMISSION_MUTATION_PRINCIPAL_RUNNING: '1',
    FINANCE_ADMISSION_READ_GLOBAL_PENDING: '1',
    FINANCE_ADMISSION_READ_GLOBAL_RUNNING: '1',
    FINANCE_ADMISSION_READ_PRINCIPAL_PENDING: '1',
    FINANCE_ADMISSION_READ_PRINCIPAL_RUNNING: '1',
    FINANCE_ADMISSION_LIGHTWEIGHT_GLOBAL_PENDING: '1',
    FINANCE_ADMISSION_LIGHTWEIGHT_GLOBAL_RUNNING: '1',
    FINANCE_ADMISSION_MAX_PENDING_DEPTH: '1',
    FINANCE_ADMISSION_CONTROL_RESERVE: '0',
    FINANCE_ADMISSION_RECOVERY_RESERVE: '1',
    FINANCE_ADMISSION_CHEAP_RESERVE: '0',
    ...overrides,
  };
}

async function v1Fetch(base, pathname, options = {}) {
  const response = await fetch(`${base}/api/v1${pathname}`, {
    ...options,
    headers: {
      'X-Finance-Token': 'test-api-token',
      ...(options.headers || {}),
    },
  });
  const text = await response.text();
  let body;
  try { body = JSON.parse(text); } catch (_) { body = text; }
  return { response, body };
}

test('expensive GET flood returns 429 while ping and operation status stay responsive', async (t) => {
  const port = await unusedPort();
  const base = `http://127.0.0.1:${port}`;
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'darkfinances-admission-flood-'));
  const { child, logs, marker, releasePath } = spawnServer(dir, port);
  t.after(() => {
    child.kill('SIGTERM');
    fs.rmSync(dir, { recursive: true, force: true });
  });
  await waitForServer(base, child, logs);

  const blocked = v1Fetch(base, '/accounts');
  await new Promise((resolve) => setImmediate(resolve));
  const queued = v1Fetch(base, '/accounts');
  await new Promise((resolve) => setImmediate(resolve));
  const overloaded = await v1Fetch(base, '/accounts');
  assert.equal(overloaded.response.status, 429);
  assert.equal(overloaded.body.code, 'ADMISSION_OVERLOADED');
  assert.equal(overloaded.body.requiresIdempotencyKeyReuse, true);
  assert.match(String(overloaded.response.headers.get('retry-after') || ''), /^\d+$/);

  const ping = await v1Fetch(base, '/ping');
  assert.equal(ping.response.status, 200);
  assert.equal(ping.body.data.ok, true);
  assert.equal(typeof ping.body.data.requestAdmission, 'object');

  fs.writeFileSync(releasePath, 'go');
  await blocked;
  await queued;
  const markerText = fs.existsSync(marker) ? fs.readFileSync(marker, 'utf8') : '';
  assert.ok(markerText.includes('accounts:start'));
});

test('overload before journal start returns stable envelope and same-key replay stays admissible', async (t) => {
  const port = await unusedPort();
  const base = `http://127.0.0.1:${port}`;
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'darkfinances-admission-idem-'));
  const journalPath = path.join(dir, 'operation-journal.json');
  const { child, logs, marker, releasePath } = spawnServer(dir, port, tightAdmissionEnv());
  t.after(() => {
    child.kill('SIGTERM');
    fs.rmSync(dir, { recursive: true, force: true });
  });
  await waitForServer(base, child, logs);

  const key = 'budget-key-12345678';
  const body = { month: '2026-07', categoryId: 'cat-groceries', amount: 100 };
  const first = v1Fetch(base, '/budgets', {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      'Idempotency-Key': key,
    },
    body: JSON.stringify(body),
  });
  const deadline = Date.now() + 5_000;
  while (Date.now() < deadline) {
    if (fs.existsSync(marker) && fs.readFileSync(marker, 'utf8').includes('budget:start')) break;
    await new Promise((resolve) => setImmediate(resolve));
  }
  assert.ok(fs.existsSync(marker) && fs.readFileSync(marker, 'utf8').includes('budget:start'));
  const rejected = await v1Fetch(base, '/budgets', {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      'Idempotency-Key': 'other-key-123456789',
    },
    body: JSON.stringify(body),
  });
  assert.equal(rejected.response.status, 429);
  assert.equal(rejected.body.code, 'ADMISSION_OVERLOADED');
  assert.equal(rejected.body.requestId?.length > 0, true);

  fs.writeFileSync(releasePath, 'go');
  const firstResult = await first;
  assert.equal(firstResult.response.status, 200);

  const markerText = fs.existsSync(marker) ? fs.readFileSync(marker, 'utf8') : '';
  assert.equal(markerText.includes('budget:start'), true);
  assert.equal(markerText.split('budget:end:').length - 1, 1);

  const replay = await v1Fetch(base, '/budgets', {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      'Idempotency-Key': key,
    },
    body: JSON.stringify(body),
  });
  assert.equal(replay.response.status, 200);
  assert.equal(replay.body.operation.replayed, true);
  assert.equal(markerText.split('budget:start').length - 1, 1);

  const journal = new OperationJournal(journalPath);
  assert.equal(journal.get(key)?.phase, 'completed');
});

test('missing Idempotency-Key returns 400 before queue saturation', async (t) => {
  const port = await unusedPort();
  const base = `http://127.0.0.1:${port}`;
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'darkfinances-admission-no-key-'));
  const { child, logs } = spawnServer(dir, port, tightAdmissionEnv());
  t.after(() => {
    child.kill('SIGTERM');
    fs.rmSync(dir, { recursive: true, force: true });
  });
  await waitForServer(base, child, logs);

  const rejected = await v1Fetch(base, '/budgets', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ month: '2026-07', categoryId: 'cat-groceries', amount: 100 }),
  });
  assert.equal(rejected.response.status, 400);
  assert.equal(rejected.body.code, 'IDEMPOTENCY_KEY_REQUIRED');
});

test('malformed admission env fails startup validation', () => {
  assert.throws(
    () => loadAdmissionLimitsConfig({ FINANCE_ADMISSION_MUTATION_GLOBAL_PENDING: 'not-a-number' }),
    /positive integer/,
  );
});
