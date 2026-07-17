'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const net = require('net');
const os = require('node:os');
const path = require('path');
const { spawn } = require('child_process');

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
    await new Promise((resolve) => setTimeout(resolve, 25));
  }
  throw new Error(`server startup timeout: ${logs.value}`);
}

async function apiRequest(base, pathname) {
  const response = await fetch(`${base}${pathname}`, {
    headers: { 'X-Finance-Token': 'test-api-token' },
  });
  const text = await response.text();
  let parsed;
  try {
    parsed = JSON.parse(text);
  } catch {
    parsed = text;
  }
  return { response, body: parsed };
}

function spawnServer(dir, port, extraEnv = {}) {
  const dashboardRoot = path.resolve(__dirname, '..');
  const preload = path.join(dir, 'mock-data-module.js');
  fs.writeFileSync(preload, `
    const path = require('path');
    const dataPath = require.resolve(path.join(process.env.TEST_DASHBOARD_ROOT, 'dataModule.js'));
    const mock = {
      initApi: async () => ({ ok: true }),
      shutdownApi: async () => ({ ok: true }),
      getHealth: () => ({ ready: true }),
    };
    require('module').Module._load = new Proxy(require('module').Module._load, {
      apply(target, thisArg, args) {
        if (args[0] === dataPath) return mock;
        return Reflect.apply(target, thisArg, args);
      },
    });
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
      ...extraEnv,
    },
    stdio: ['ignore', 'pipe', 'pipe'],
  });
  child.stdout.on('data', (chunk) => { logs.value += chunk; });
  child.stderr.on('data', (chunk) => { logs.value += chunk; });
  return { child, logs, base: `http://127.0.0.1:${port}` };
}

test('ping exposes bounded sourceFreshness contract for reconnect refresh', async (t) => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'df-reconnect-ping-'));
  const manifestPath = path.join(dir, 'release-manifest.json');
  fs.writeFileSync(manifestPath, JSON.stringify({
    schemaVersion: 2,
    contract: 'reconnect-contract-abc',
    lockSha256: 'deadbeef',
  }));

  const port = await unusedPort();
  const { child, logs, base } = spawnServer(dir, port, {
    RELEASE_MANIFEST_PATH: manifestPath,
  });
  t.after(async () => {
    child.kill('SIGTERM');
    await new Promise((resolve) => child.once('exit', resolve));
    fs.rmSync(dir, { recursive: true, force: true });
  });
  await waitForServer(base, child, logs);

  const { body, response } = await apiRequest(base, '/api/v1/ping');
  assert.equal(response.status, 200);
  assert.equal(body.data.ok, true);
  assert.equal(typeof body.data.sourceFreshness, 'object');
  assert.equal(typeof body.data.sourceFreshness.cacheGeneration, 'number');
  assert.equal(body.data.sourceFreshness.sourceRevision, 'reconnect-contract-abc');
  assert.equal(body.data.sourceFreshness.financeTimeZone, 'America/Los_Angeles');
  assert.equal(typeof body.data.sourceFreshness.observedAt, 'number');
  assert.equal(typeof body.data.requestAdmission, 'object');
});

test('sourceFreshness is read-only control metadata and does not mutate finance state', async (t) => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'df-reconnect-readonly-'));
  const manifestPath = path.join(dir, 'release-manifest.json');
  fs.writeFileSync(manifestPath, JSON.stringify({
    schemaVersion: 2,
    contract: 'before',
    lockSha256: 'abc',
  }));

  const port = await unusedPort();
  const { child, logs, base } = spawnServer(dir, port, {
    RELEASE_MANIFEST_PATH: manifestPath,
  });
  t.after(async () => {
    child.kill('SIGTERM');
    await new Promise((resolve) => child.once('exit', resolve));
    fs.rmSync(dir, { recursive: true, force: true });
  });
  await waitForServer(base, child, logs);

  const first = await apiRequest(base, '/api/v1/ping');
  const second = await apiRequest(base, '/api/v1/ping');
  assert.deepEqual(
    first.body.data.sourceFreshness.sourceRevision,
    second.body.data.sourceFreshness.sourceRevision,
  );
  assert.equal(first.body.data.queuedMutations, second.body.data.queuedMutations);
});
