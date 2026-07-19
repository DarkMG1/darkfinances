'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const os = require('os');
const path = require('path');
const { spawn } = require('child_process');
const {
  RESERVED_ENV_KEYS,
  attachChildLogHandlers,
  buildDashboardServerEnv,
  dashboardRoot,
  parseReadyLine,
  validateExtraEnv,
  waitForChildExit,
} = require('./helpers/ephemeral-dashboard-server');

const DEMO_READY_PRELOAD = `
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
`;

async function spawnPingProbe({ nodeEnv, instanceId }) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'darkfinances-prod-contract-'));
  const preloadPath = path.join(dir, 'demo-ready-preload.js');
  fs.writeFileSync(preloadPath, DEMO_READY_PRELOAD);
  const logs = { value: '' };
  const child = spawn(process.execPath, ['server.js'], {
    cwd: dashboardRoot(),
    env: buildDashboardServerEnv({
      dir,
      instanceId,
      nodeEnv,
      demoOnly: true,
      extraEnv: {},
      preloadPath,
    }),
    stdio: ['ignore', 'pipe', 'pipe'],
  });
  attachChildLogHandlers(child, logs);
  return { child, logs, dir, instanceId };
}

async function waitForBoundPortFromFinanceLog(logs, timeoutMs = 10_000) {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    const match = logs.value.match(/Finance dashboard running on http:\/\/127\.0\.0\.1:(\d+)/);
    if (match) return Number(match[1], 10);
    await new Promise((resolve) => setImmediate(resolve));
  }
  throw new Error(`server never logged bound port: ${logs.value}`);
}

async function waitForTestReadyPort(logs, instanceId, timeoutMs = 10_000) {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    const ready = parseReadyLine(logs.value, instanceId);
    if (ready) return ready.port;
    await new Promise((resolve) => setImmediate(resolve));
  }
  throw new Error(`server never logged readiness marker: ${logs.value}`);
}

test('validateExtraEnv rejects reserved identity overrides', () => {
  for (const key of RESERVED_ENV_KEYS) {
    assert.throws(
      () => validateExtraEnv({ [key]: 'override' }),
      /cannot override reserved server identity keys/,
    );
  }
});

test('production mode ignores TEST_SERVER_INSTANCE_ID in ping and startup logs', async (t) => {
  const instanceId = 'a'.repeat(32);
  const { child, logs, dir } = await spawnPingProbe({
    nodeEnv: 'production',
    instanceId,
  });
  t.after(async () => {
    if (child.exitCode == null) child.kill('SIGTERM');
    await waitForChildExit(child, 5_000).catch(() => {});
    fs.rmSync(dir, { recursive: true, force: true });
  });

  const port = await waitForBoundPortFromFinanceLog(logs);
  const response = await fetch(`http://127.0.0.1:${port}/api/v1/ping`, {
    headers: { 'X-Finance-Token': 'test-api-token' },
  });
  assert.equal(response.status, 200);
  const body = await response.json();
  assert.equal(body.data.testInstanceId, undefined);
  assert.equal(Object.prototype.hasOwnProperty.call(body.data, 'testInstanceId'), false);
  assert.equal(logs.value.includes(`FINANCE_TEST_SERVER_READY ${port} ${instanceId}`), false);
  assert.equal(parseReadyLine(logs.value, instanceId), null);
});

test('test mode exposes instance identity in ping and startup logs', async (t) => {
  const instanceId = 'b'.repeat(32);
  const { child, logs, dir } = await spawnPingProbe({
    nodeEnv: 'test',
    instanceId,
  });
  t.after(async () => {
    if (child.exitCode == null) child.kill('SIGTERM');
    await waitForChildExit(child, 5_000).catch(() => {});
    fs.rmSync(dir, { recursive: true, force: true });
  });

  const port = await waitForTestReadyPort(logs, instanceId);
  const response = await fetch(`http://127.0.0.1:${port}/api/v1/ping`, {
    headers: { 'X-Finance-Token': 'test-api-token' },
  });
  assert.equal(response.status, 200);
  const body = await response.json();
  assert.equal(body.data.testInstanceId, instanceId);
  assert.match(logs.value, new RegExp(`FINANCE_TEST_SERVER_READY ${port} ${instanceId}`));
});
