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
  return { response, body: await response.json() };
}

test('server composes structural sync and strict bank uncertainty', async (t) => {
  const port = await unusedPort();
  const base = `http://127.0.0.1:${port}`;
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'darkfinances-operation-effects-'));
  const dashboardRoot = path.resolve(__dirname, '..');
  const marker = path.join(dir, 'effects.log');
  const preload = path.join(dir, 'mock-data-module.js');
  fs.writeFileSync(preload, `
    const fs = require('fs');
    const path = require('path');
    const dataPath = require.resolve(path.join(process.env.TEST_DASHBOARD_ROOT, 'dataModule.js'));
    const mark = (value) => fs.appendFileSync(process.env.TEST_EFFECT_MARKER, value + '\\n');
    const mock = new Proxy({
      initApi: async () => ({ ok: true }),
      shutdownApi: async () => ({ ok: true }),
      getHealth: () => ({ ready: true }),
      syncSplitwiseShareExpenses: async (options) => {
        mark('splitwise:' + JSON.stringify(options));
        return { ok: true, created: 0, updated: 0, pruned: 0, needsSync: true, status: 'in_progress' };
      },
      getBulkOperationResult: () => ({
        ok: true,
        created: 0,
        updated: 0,
        pruned: 0,
        needsSync: false,
        status: 'completed',
      }),
      syncNow: async () => { mark('sync'); },
      bankSync: async (options) => {
        mark('bank:' + JSON.stringify(options));
        throw new Error('injected bank rejection');
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
      TEST_EFFECT_MARKER: marker,
    },
    stdio: ['ignore', 'pipe', 'pipe'],
  });
  child.stdout.on('data', (chunk) => { logs.value += chunk; });
  child.stderr.on('data', (chunk) => { logs.value += chunk; });
  t.after(() => {
    child.kill('SIGTERM');
    fs.rmSync(dir, { recursive: true, force: true });
  });
  await waitForServer(base, child, logs);

  const splitwiseKey = 'splitwise-structural';
  let result = await apiRequest(base, '/api/v1/splitwise/sync-shares', {
    method: 'POST',
    key: splitwiseKey,
    body: {},
  });
  assert.equal(result.response.status, 200);
  const effects = fs.readFileSync(marker, 'utf8').trim().split('\n');
  assert.match(effects[0], /^splitwise:\{"sync":false,"operationKey":"splitwise-structural"/);
  assert.equal(effects[1], 'sync');

  result = await apiRequest(base, `/api/v1/operations/${splitwiseKey}`);
  assert.equal(result.body.data.phase, 'completed');

  const bankKey = 'bank-sync-reject';
  result = await apiRequest(base, '/api/v1/bank-sync', {
    method: 'POST',
    key: bankKey,
    body: {},
  });
  assert.equal(result.response.status, 409);
  assert.equal(result.body.code, 'OUTCOME_UNKNOWN');
  assert.match(fs.readFileSync(marker, 'utf8'), /bank:\{"throwOnBankError":true\}/);

  result = await apiRequest(base, `/api/v1/operations/${bankKey}`);
  assert.equal(result.body.data.status, 'started');
  assert.equal(result.body.data.phase, 'sync_unknown');
  assert.equal(result.body.data.outcome, 'unknown');
});
