'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const http = require('http');
const net = require('net');
const os = require('os');
const path = require('path');
const { spawn } = require('child_process');
const { SerialQueue } = require('../lib/serial-queue');
const { closeHttpServer, closeIdleKeepAlive } = require('../lib/http-server-drain');
const { runGracefulShutdown } = require('../lib/graceful-shutdown');

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

function phaseIndex(logs, phase) {
  return logs.indexOf(`phase=${phase}`);
}

function phaseCount(logs, phase) {
  return (logs.match(new RegExp(`phase=${phase}`, 'g')) || []).length;
}

function spawnDashboard(dir, port, preloadBody, extraEnv = {}) {
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
  return { child, logs, base: `http://127.0.0.1:${port}`, markerPath: path.join(dir, 'marker.log') };
}

function markLine() {
  return `
    const fs = require('fs');
    const mark = (value) => fs.appendFileSync(process.env.TEST_MARKER, value + '\\n');
    const waitForRelease = async () => {
      while (!fs.existsSync(process.env.TEST_RELEASE_PATH)) {
        await new Promise((resolve) => setImmediate(resolve));
      }
    };
  `;
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

async function waitForMarker(markerPath, line, timeoutMs = 10_000) {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    if (fs.existsSync(markerPath)) {
      const content = fs.readFileSync(markerPath, 'utf8');
      if (content.includes(`${line}\n`) || content.trimEnd().endsWith(line)) return;
    }
    await new Promise((resolve) => setImmediate(resolve));
  }
  throw new Error(`marker line not seen: ${line}`);
}

async function waitForChildExit(child, timeoutMs = 15_000) {
  if (child.exitCode != null) return child.exitCode;
  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => reject(new Error('child exit timeout')), timeoutMs);
    child.once('exit', (code) => {
      clearTimeout(timer);
      resolve(code);
    });
  });
}

function mockDataModuleBlock(preloadExtras = '') {
  return `
    ${markLine()}
    const path = require('path');
    const dataPath = require.resolve(path.join(process.env.TEST_DASHBOARD_ROOT, 'dataModule.js'));
    const mock = {
      initApi: async () => ({ ok: true }),
      shutdownApi: async () => { mark('shutdown'); return { ok: true }; },
      getHealth: () => ({ ready: true }),
      syncNow: async () => {},
      getAccounts: async () => {
        mark('getAccounts:start');
        await waitForRelease();
        mark('getAccounts:end');
        return [{ id: 'a1', name: 'Checking' }];
      },
      setBudgetAmount: async () => {
        mark('mutation:start');
        await waitForRelease();
        mark('mutation:end');
        return { ok: true };
      },
      ${preloadExtras}
    };
    require.cache[dataPath] = { id: dataPath, filename: dataPath, loaded: true, exports: mock, children: [], paths: [] };
  `;
}

test('closeHttpServer resolves immediately when server is not listening', async () => {
  const server = http.createServer((_req, res) => {
    res.end('ok');
  });
  const result = await closeHttpServer(server);
  assert.deepEqual(result, { wasListening: false, alreadyClosed: true });
});

test('runGracefulShutdown skips Actual shutdown after HTTP drain timeout', async (t) => {
  const phases = [];
  let shutdownCalls = 0;
  const server = http.createServer((_req, res) => {
    res.writeHead(200);
    // Never finish — blocks close callback until force-close/timeout.
  });
  await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
  const port = server.address().port;

  const clientReq = http.get(`http://127.0.0.1:${port}/`);
  clientReq.on('error', () => {});
  await new Promise((resolve) => setImmediate(resolve));

  t.after(async () => {
    clientReq.destroy();
    await new Promise((resolve) => server.close(resolve));
  });

  const exitCodes = [];
  const result = await runGracefulShutdown({
    signal: 'SIGTERM',
    httpServer: server,
    mutationQueue: new SerialQueue('test-mutations'),
    shutdownApi: async () => {
      shutdownCalls += 1;
    },
    totalTimeoutMs: 200,
    mutationDrainTimeoutMs: 50,
    exit: (code) => { exitCodes.push(code); },
    log: (phase) => { phases.push(phase); },
  });

  assert.equal(result.ok, false);
  assert.equal(result.phase, 'http-drain-timeout');
  assert.equal(shutdownCalls, 0);
  assert.deepEqual(exitCodes, [1]);
  assert.ok(phases.includes('http-drained') === false);
});

test('blocked Actual-backed GET completes before Actual shutdown marker', async (t) => {
  const port = await unusedPort();
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'df-shutdown-get-'));
  const releasePath = path.join(dir, 'release.fill');
  const { child, logs, base, markerPath } = spawnDashboard(dir, port, mockDataModuleBlock(), {
    TEST_RELEASE_PATH: releasePath,
  });
  t.after(() => {
    try { child.kill('SIGKILL'); } catch (_) {}
    fs.rmSync(dir, { recursive: true, force: true });
  });
  await waitForServer(base, child, logs);

  const readPromise = fetch(`${base}/api/v1/accounts`, {
    headers: { 'X-Finance-Token': 'test-api-token' },
  });
  await waitForMarker(markerPath, 'getAccounts:start');
  child.kill('SIGTERM');
  fs.writeFileSync(releasePath, '1');

  const response = await readPromise;
  assert.equal(response.status, 200);
  const exitCode = await waitForChildExit(child);
  assert.equal(exitCode, 0);

  const marker = fs.readFileSync(markerPath, 'utf8').trim().split('\n');
  assert.ok(marker.includes('getAccounts:end'));
  assert.ok(marker.includes('shutdown'));
  assert.ok(phaseIndex(logs.value, 'http-drained') < phaseIndex(logs.value, 'actual-shutdown-complete'));
  assert.ok(phaseIndex(logs.value, 'getAccounts:end') < phaseIndex(logs.value, 'actual-shutdown-complete'));
});

test('active mutation finishes before Actual shutdown', async (t) => {
  const port = await unusedPort();
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'df-shutdown-mutation-'));
  const releasePath = path.join(dir, 'release.fill');
  const { child, logs, base, markerPath } = spawnDashboard(dir, port, mockDataModuleBlock(), {
    TEST_RELEASE_PATH: releasePath,
  });
  t.after(() => {
    try { child.kill('SIGKILL'); } catch (_) {}
    fs.rmSync(dir, { recursive: true, force: true });
  });
  await waitForServer(base, child, logs);

  const mutationPromise = fetch(`${base}/api/v1/budgets`, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      'X-Finance-Token': 'test-api-token',
      'Idempotency-Key': 'shutdown-mutation',
    },
    body: JSON.stringify({ month: '2026-07', categoryId: 'food', amount: 5 }),
  });
  await waitForMarker(markerPath, 'mutation:start');
  child.kill('SIGTERM');
  fs.writeFileSync(releasePath, '1');

  const response = await mutationPromise;
  assert.equal(response.status, 200);
  const exitCode = await waitForChildExit(child);
  assert.equal(exitCode, 0);

  const marker = fs.readFileSync(markerPath, 'utf8').trim().split('\n');
  const mutationEnd = marker.indexOf('mutation:end');
  const shutdown = marker.indexOf('shutdown');
  assert.ok(mutationEnd >= 0 && shutdown >= 0);
  assert.ok(mutationEnd < shutdown);
  assert.ok(phaseIndex(logs.value, 'mutation-queue-drained') < phaseIndex(logs.value, 'actual-shutdown-complete'));
});

test('idle keep-alive connection does not block shutdown', async (t) => {
  const port = await unusedPort();
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'df-shutdown-keepalive-'));
  const { child, logs, base } = spawnDashboard(dir, port, mockDataModuleBlock());
  t.after(() => {
    try { child.kill('SIGKILL'); } catch (_) {}
    fs.rmSync(dir, { recursive: true, force: true });
  });
  await waitForServer(base, child, logs);

  const agent = new http.Agent({ keepAlive: true });
  await new Promise((resolve, reject) => {
    const req = http.get(`${base}/auth/status`, { agent }, (res) => {
      res.resume();
      res.on('end', resolve);
    });
    req.on('error', reject);
  });

  const started = Date.now();
  child.kill('SIGTERM');
  const exitCode = await waitForChildExit(child, 5_000);
  assert.equal(exitCode, 0);
  assert.ok(Date.now() - started < 4_000, `shutdown took too long: ${logs.value}`);
  assert.ok(phaseIndex(logs.value, 'http-drained') >= 0);
  agent.destroy();
});

test('hung request hits bounded timeout with nonzero exit and no Actual shutdown', async (t) => {
  const port = await unusedPort();
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'df-shutdown-timeout-'));
  const hungBody = mockDataModuleBlock(`
      getAccounts: async () => {
        mark('getAccounts:hung');
        await new Promise(() => {});
        return [];
      },
  `);
  const { child, logs, base, markerPath } = spawnDashboard(dir, port, hungBody, {
    FINANCE_SHUTDOWN_TIMEOUT_MS: '800',
  });
  t.after(() => {
    try { child.kill('SIGKILL'); } catch (_) {}
    fs.rmSync(dir, { recursive: true, force: true });
  });
  await waitForServer(base, child, logs);

  void fetch(`${base}/api/v1/accounts`, {
    headers: { 'X-Finance-Token': 'test-api-token' },
  }).catch(() => {});
  await waitForMarker(markerPath, 'getAccounts:hung');

  const started = Date.now();
  child.kill('SIGTERM');
  const exitCode = await waitForChildExit(child, 5_000);
  assert.equal(exitCode, 1);
  assert.ok(Date.now() - started < 3_000);
  assert.ok(phaseIndex(logs.value, 'shutdown-timeout') >= 0);
  assert.equal(phaseIndex(logs.value, 'actual-shutdown-complete'), -1);
  assert.equal(fs.readFileSync(markerPath, 'utf8').includes('shutdown'), false);
});

test('duplicate signals invoke shutdown once', async (t) => {
  const port = await unusedPort();
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'df-shutdown-dup-signal-'));
  const { child, logs, base } = spawnDashboard(dir, port, mockDataModuleBlock());
  t.after(() => {
    try { child.kill('SIGKILL'); } catch (_) {}
    fs.rmSync(dir, { recursive: true, force: true });
  });
  await waitForServer(base, child, logs);

  child.kill('SIGTERM');
  child.kill('SIGINT');
  const exitCode = await waitForChildExit(child);
  assert.equal(exitCode, 0);
  assert.equal(phaseCount(logs.value, 'signal-received'), 1);
  assert.equal(phaseCount(logs.value, 'actual-shutdown-complete'), 1);
});

test('shutdown proceeds when HTTP server is already closed', async () => {
  const phases = [];
  let shutdownCalls = 0;
  const server = http.createServer();
  const mutationQueue = new SerialQueue('test-mutations');
  const exitCodes = [];

  const result = await runGracefulShutdown({
    signal: 'SIGTERM',
    httpServer: server,
    mutationQueue,
    shutdownApi: async () => { shutdownCalls += 1; },
    totalTimeoutMs: 2_000,
    mutationDrainTimeoutMs: 500,
    exit: (code) => { exitCodes.push(code); },
    log: (phase) => { phases.push(phase); },
  });

  assert.equal(result.ok, true);
  assert.equal(shutdownCalls, 1);
  assert.deepEqual(exitCodes, [0]);
  assert.ok(phases.indexOf('http-drained') > phases.indexOf('mutation-admission-stopped'));
  assert.ok(phases.indexOf('actual-shutdown-complete') > phases.indexOf('http-drained'));
});

test('closeIdleKeepAlive allows close callback when only idle sockets remain', async () => {
  const server = http.createServer((_req, res) => {
    res.writeHead(200);
    res.end('ok');
  });
  await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
  const port = server.address().port;
  const agent = new http.Agent({ keepAlive: true });

  await new Promise((resolve, reject) => {
    http.get(`http://127.0.0.1:${port}/`, { agent }, (res) => {
      res.resume();
      res.on('end', resolve);
    }).on('error', reject);
  });

  const closePromise = closeHttpServer(server);
  closeIdleKeepAlive(server);
  const result = await closePromise;
  assert.equal(result.wasListening, true);
  assert.equal(result.drained, true);
  agent.destroy();
});
