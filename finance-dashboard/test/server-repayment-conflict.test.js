'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const os = require('os');
const path = require('path');
const net = require('net');
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
  for (let attempt = 0; attempt < 100; attempt += 1) {
    if (child.exitCode != null) throw new Error(`server exited early: ${logs.value}`);
    try {
      const response = await fetch(`${base}/api/v1/ping`, {
        headers: { 'X-Finance-Token': 'test-api-token' },
      });
      if (response.status === 200) return;
    } catch (_) {}
    await new Promise((resolve) => setTimeout(resolve, 25));
  }
  throw new Error(`server did not start: ${logs.value}`);
}

async function request(base, route, { method = 'GET', key, body } = {}) {
  const response = await fetch(`${base}${route}`, {
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

test('repayment confirmation ownership conflicts are terminal before operation effects', async (t) => {
  const port = await unusedPort();
  const base = `http://127.0.0.1:${port}`;
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'darkfinances-repay-conflict-'));
  const dashboardRoot = path.resolve(__dirname, '..');
  const marker = path.join(dir, 'effects.log');
  const preload = path.join(dir, 'mock-data-module.js');
  fs.writeFileSync(preload, `
    const fs = require('fs');
    const path = require('path');
    const dataPath = require.resolve(path.join(process.env.TEST_DASHBOARD_ROOT, 'dataModule.js'));
    const { KnownPreApplyError } = require(path.join(process.env.TEST_DASHBOARD_ROOT, 'lib/errors.js'));
    const mark = (value) => fs.appendFileSync(process.env.TEST_EFFECT_MARKER, value + '\\n');
    const repaymentConflict = () => {
      throw new KnownPreApplyError('A repayment confirmation for this transaction is already in progress', {
        code: 'REPAYMENT_CONFIRMATION_IN_PROGRESS',
        status: 409,
      });
    };
    const mock = new Proxy({
      initApi: async () => ({ ok: true }),
      shutdownApi: async () => ({ ok: true }),
      getHealth: () => ({ ready: true }),
      assertTransactionMutationAvailable: ({ ids = [] }) => {
        mark('mutation-preflight:' + ids.filter(Boolean).join(','));
        if (ids.map(String).includes('repay-owned')) repaymentConflict();
      },
      confirmRepayment: async ({ id }) => {
        mark('confirm-mutation:' + id);
        return { ok: true, inflowId: 'repay-owned', linked: 1 };
      },
      setTransactionCategory: async ({ id }) => { mark('category-mutation:' + id); },
      addReimbLink: async ({ inflow }) => { mark('link-mutation:' + inflow.id); },
      syncNow: async () => { mark('sync'); },
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

  const conflictCases = [
    { route: '/api/v1/repayments/sg_repay-owned/confirm', method: 'POST', key: 'confirm-key' },
    { route: '/api/v1/transactions/repay-owned/category', method: 'POST', key: 'category-key', body: { categoryId: 'cat' } },
    {
      route: '/api/v1/reimb-links',
      method: 'POST',
      key: 'link-key',
      body: {
        inflow: { id: 'repay-owned', amount: 10 },
        expense: { id: 'expense', amount: -10 },
        allocationCents: 1000,
      },
    },
  ];

  for (const conflictCase of conflictCases) {
    const result = await request(base, conflictCase.route, conflictCase);
    assert.equal(result.response.status, 409, conflictCase.route);
    assert.equal(result.body.code, 'REPAYMENT_CONFIRMATION_IN_PROGRESS', conflictCase.route);
  }

  const effects = fs.readFileSync(marker, 'utf8').trim().split('\n').filter(Boolean);
  assert.ok(effects.every((line) => line.startsWith('mutation-preflight:')));
  assert.equal(effects.some((line) => line.includes('confirm-mutation')), false);
  assert.equal(effects.some((line) => line.includes('category-mutation')), false);
  assert.equal(effects.some((line) => line.includes('link-mutation')), false);
});
