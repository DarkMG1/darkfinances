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
const {
  closeHttpServer,
  closeHttpServerWithTimeout,
  closeIdleKeepAlive,
  HttpDrainTimeoutError,
} = require('../lib/http-server-drain');
const { bindGracefulShutdownSignals, runGracefulShutdown } = require('../lib/graceful-shutdown');

function createDeferred() {
  let resolve;
  let reject;
  const promise = new Promise((res, rej) => {
    resolve = res;
    reject = rej;
  });
  return { promise, resolve, reject };
}

async function createHungHttpServer() {
  let requestReady;
  const requestSeen = new Promise((resolve) => {
    requestReady = resolve;
  });
  const server = http.createServer((_req, res) => {
    requestReady();
    res.writeHead(200);
    // Never finish — blocks close callback until force-close/timeout.
  });
  await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
  const port = server.address().port;
  const clientReq = http.get(`http://127.0.0.1:${port}/`);
  clientReq.on('error', () => {});
  await requestSeen;
  return { server, clientReq };
}

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

test('closeHttpServerWithTimeout rejects immediately when budget is zero on a hung server', async (t) => {
  const { server, clientReq } = await createHungHttpServer();
  t.after(async () => {
    clientReq.destroy();
    await new Promise((resolve) => server.close(resolve));
  });

  const started = Date.now();
  await assert.rejects(
    () => closeHttpServerWithTimeout(server, 0),
    (error) => {
      assert.ok(error instanceof HttpDrainTimeoutError);
      assert.equal(error.reason, 'budget-exhausted');
      return true;
    },
  );
  assert.ok(Date.now() - started < 200, 'zero budget must fail immediately, not hang');
});

test('closeHttpServerWithTimeout rejects immediately when budget is exhausted on a hung server', async (t) => {
  const { server, clientReq } = await createHungHttpServer();
  t.after(async () => {
    clientReq.destroy();
    await new Promise((resolve) => server.close(resolve));
  });

  const started = Date.now();
  await assert.rejects(
    () => closeHttpServerWithTimeout(server, -1),
    (error) => {
      assert.ok(error instanceof HttpDrainTimeoutError);
      assert.equal(error.reason, 'budget-exhausted');
      return true;
    },
  );
  assert.ok(Date.now() - started < 200, 'exhausted budget must fail immediately, not hang');
});

test('closeHttpServerWithTimeout resolves immediately when budget is zero and server is not listening', async () => {
  const server = http.createServer();
  const result = await closeHttpServerWithTimeout(server, 0);
  assert.deepEqual(result, { wasListening: false, alreadyClosed: true });
});

test('runGracefulShutdown skips Actual shutdown when HTTP budget is exhausted on a hung server', async (t) => {
  const { server, clientReq } = await createHungHttpServer();
  t.after(async () => {
    clientReq.destroy();
    await new Promise((resolve) => server.close(resolve));
  });

  const phases = [];
  let shutdownCalls = 0;
  const exitCodes = [];
  const started = Date.now();
  const result = await runGracefulShutdown({
    signal: 'SIGTERM',
    httpServer: server,
    mutationQueue: new SerialQueue('test-mutations'),
    shutdownApi: async () => { shutdownCalls += 1; },
    totalTimeoutMs: 0,
    mutationDrainTimeoutMs: 50,
    exit: (code) => { exitCodes.push(code); },
    log: (phase, extra) => { phases.push({ phase, extra }); },
  });

  assert.ok(Date.now() - started < 500, 'shutdown must complete promptly on exhausted budget');
  assert.equal(result.ok, false);
  assert.equal(result.phase, 'http-drain-timeout');
  assert.equal(shutdownCalls, 0);
  assert.deepEqual(exitCodes, [1]);
  assert.ok(phases.some((entry) => entry.phase === 'shutdown-timeout' && entry.extra?.reason === 'budget-exhausted'));
  assert.ok(phases.every((entry) => entry.phase !== 'http-drained'));
});

test('runGracefulShutdown skips Actual shutdown after HTTP drain timeout', async (t) => {
  const { server, clientReq } = await createHungHttpServer();
  t.after(async () => {
    clientReq.destroy();
    await new Promise((resolve) => server.close(resolve));
  });

  const phases = [];
  let shutdownCalls = 0;
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

test('in-flight non-HTTP mutation queue task completes before Actual shutdown', async () => {
  const release = createDeferred();
  const markers = [];
  const mutationQueue = new SerialQueue('finance-mutations');
  const server = http.createServer();
  let shutdownCalls = 0;
  const exitCodes = [];
  const phases = [];

  const taskStarted = mutationQueue.run(async () => {
    markers.push('periodic-sync:start');
    await release.promise;
    markers.push('periodic-sync:end');
  });
  await new Promise((resolve) => setImmediate(resolve));
  assert.equal(mutationQueue.size, 1);

  const shutdownPromise = runGracefulShutdown({
    signal: 'SIGTERM',
    httpServer: server,
    mutationQueue,
    shutdownApi: async () => {
      shutdownCalls += 1;
      markers.push('shutdown');
    },
    totalTimeoutMs: 5_000,
    mutationDrainTimeoutMs: 5_000,
    exit: (code) => { exitCodes.push(code); },
    log: (phase) => { phases.push(phase); },
  });

  await new Promise((resolve) => setImmediate(resolve));
  assert.ok(phases.includes('mutation-admission-stopped'));
  assert.ok(phases.includes('http-admission-stopped'));
  assert.ok(markers.includes('periodic-sync:start'));
  assert.equal(markers.includes('periodic-sync:end'), false);
  assert.equal(shutdownCalls, 0);

  release.resolve();
  await taskStarted;
  const result = await shutdownPromise;

  assert.equal(result.ok, true);
  assert.equal(shutdownCalls, 1);
  assert.deepEqual(exitCodes, [0]);
  assert.deepEqual(markers, ['periodic-sync:start', 'periodic-sync:end', 'shutdown']);
  assert.ok(phases.indexOf('http-drained') < phases.indexOf('mutation-queue-drained'));
  assert.ok(phases.indexOf('mutation-queue-drained') < phases.indexOf('actual-shutdown-complete'));
});

test('hard cap exits once when shutdown phase never settles', async (t) => {
  const previousTimeout = process.env.FINANCE_SHUTDOWN_TIMEOUT_MS;
  const sigtermListeners = process.listeners('SIGTERM');
  const sigintListeners = process.listeners('SIGINT');
  process.env.FINANCE_SHUTDOWN_TIMEOUT_MS = '80';
  t.after(() => {
    if (previousTimeout === undefined) delete process.env.FINANCE_SHUTDOWN_TIMEOUT_MS;
    else process.env.FINANCE_SHUTDOWN_TIMEOUT_MS = previousTimeout;
    process.removeAllListeners('SIGTERM');
    process.removeAllListeners('SIGINT');
    for (const listener of sigtermListeners) process.on('SIGTERM', listener);
    for (const listener of sigintListeners) process.on('SIGINT', listener);
  });

  const timeoutLogs = [];
  const exitCodes = [];
  let shutdownCalls = 0;
  const { startShutdown } = bindGracefulShutdownSignals({
    httpServer: http.createServer(),
    mutationQueue: {
      close: () => {},
      drain: () => new Promise(() => {}),
    },
    shutdownApi: async () => { shutdownCalls += 1; },
    totalTimeoutMs: 80,
    exit: (code) => { exitCodes.push(code); },
    log: (phase, extra) => {
      if (phase === 'shutdown-timeout') timeoutLogs.push(extra);
    },
  });

  const started = Date.now();
  void startShutdown('SIGTERM');
  await new Promise((resolve) => setTimeout(resolve, 150));

  assert.ok(Date.now() - started < 500, 'hard cap must fire promptly');
  assert.deepEqual(exitCodes, [1]);
  assert.equal(shutdownCalls, 0);
  assert.equal(timeoutLogs.length, 1);
  assert.equal(timeoutLogs[0].step, 'hard-cap');
  assert.deepEqual(Object.keys(timeoutLogs[0]).sort(), [
    'canCloseIdle',
    'canForceClose',
    'listening',
    'step',
  ]);
});
