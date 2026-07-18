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

function writeForecastErrorPreload(preloadPath, dashboardRoot) {
  fs.writeFileSync(preloadPath, `
    const path = require('path');
    const dataPath = require.resolve(path.join(process.env.TEST_DASHBOARD_ROOT, 'dataModule.js'));
    const { ForecastMoneyValidationError } = require(path.join(process.env.TEST_DASHBOARD_ROOT, 'lib/errors'));
    require.cache[dataPath] = {
      id: dataPath,
      filename: dataPath,
      loaded: true,
      exports: {
        initApi: async () => ({ ok: true }),
        shutdownApi: async () => ({ ok: true }),
        getHealth: () => ({ ready: true }),
        getForecast: async () => { throw new ForecastMoneyValidationError(); },
      },
      children: [],
      paths: [],
    };
  `);
}

test('forecast endpoint returns controlled unavailable error for invalid money', async (t) => {
  const port = await unusedPort();
  const base = `http://127.0.0.1:${port}`;
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'darkfinances-forecast-money-'));
  const dashboardRoot = path.resolve(__dirname, '..');
  const preload = path.join(dir, 'mock-data-module.js');
  writeForecastErrorPreload(preload, dashboardRoot);

  const logs = { value: '' };
  const child = spawn(process.execPath, ['server.js'], {
    cwd: dashboardRoot,
    env: {
      ...process.env,
      NODE_ENV: 'test',
      SELFTEST: '1',
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

  const response = await fetch(`${base}/api/v1/forecast?days=30`, {
    headers: { 'X-Finance-Token': 'test-api-token' },
  });
  const body = await response.json();
  assert.equal(response.status, 400);
  assert.equal(body.code, 'FORECAST_MONEY_INVALID');
  assert.equal(body.error, 'Forecast money input is invalid');
  assert.equal(JSON.stringify(body).includes(String(Number.MAX_VALUE)), false);
});

test('forecast endpoint returns complete assumptions aliases for valid demo forecast', async (t) => {
  const port = await unusedPort();
  const base = `http://127.0.0.1:${port}`;
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'darkfinances-forecast-demo-'));
  const dashboardRoot = path.resolve(__dirname, '..');

  const logs = { value: '' };
  const child = spawn(process.execPath, ['server.js'], {
    cwd: dashboardRoot,
    env: {
      ...process.env,
      NODE_ENV: 'test',
      SELFTEST: '1',
      PORT: String(port),
      DEMO_ONLY: '1',
      PUBLIC_ORIGIN: `http://localhost:${port}`,
      WEBAUTHN_ORIGIN: `http://localhost:${port}`,
      WEBAUTHN_RP_ID: 'localhost',
      SESSION_SECRET: 'test-session-secret-with-sufficient-length',
      SESSION_DIR: path.join(dir, 'sessions'),
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

  const response = await fetch(`${base}/api/v1/forecast?days=30`, {
    headers: { 'X-Demo-Mode': '1' },
  });
  const payload = await response.json();
  assert.equal(response.status, 200);
  const assumptions = payload.data.assumptions;
  assert.equal(assumptions.stsContainment.complete, false);
  assert.ok(assumptions.stsContainment.incompleteReasons.includes('budget_data_unavailable'));
  assert.equal(assumptions.projectionContainment.complete, false);
  assert.equal(assumptions.projectionContainment.stsContainmentIncomplete, true);
  assert.equal(assumptions.genericBudget.complete, false);
  assert.equal(assumptions.genericBudgetTarget, assumptions.genericBudget.target);
  assert.ok(payload.data.warnings.some((warning) => /Safe-to-Spend containment incomplete/.test(warning)));
  assert.ok(!payload.data.warnings.some((warning) => /category amounts are not safe integer cents/.test(warning)));
});
