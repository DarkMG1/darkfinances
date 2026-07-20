'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const http = require('http');
const path = require('path');
const { SerialQueue } = require('../lib/serial-queue');
const {
  closeHttpServer,
  closeHttpServerWithTimeout,
  closeIdleKeepAlive,
  HttpDrainTimeoutError,
} = require('../lib/http-server-drain');
const { bindGracefulShutdownSignals, runGracefulShutdown } = require('../lib/graceful-shutdown');
const { registerProcessShutdownTestIsolation } = require('./helpers/process-shutdown-test-isolation');
const { waitForChildExit } = require('./helpers/ephemeral-dashboard-server');
const {
  childWatchContext,
  markPrelude,
  pollBackoff,
  sidecarReleasePrelude,
  waitForMarkerFile,
} = require('./helpers/test-sync-barriers');
const { startShutdownDashboard } = require('./helpers/graceful-shutdown-ephemeral-server');

registerProcessShutdownTestIsolation(test);

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

function phaseIndex(logs, phase) {
  return logs.indexOf(`phase=${phase}`);
}

function phaseCount(logs, phase) {
  return (logs.match(new RegExp(`phase=${phase}`, 'g')) || []).length;
}

function markLine() {
  return `
    const fs = require('fs');
    ${markPrelude()}
    ${sidecarReleasePrelude()}
    const waitForRelease = waitSidecarRelease;
  `;
}

async function waitForMarker(markerPath, line, watch = {}, timeoutMs = 10_000) {
  return waitForMarkerFile(markerPath, line, { ...watch, timeoutMs, context: `marker ${line}` });
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
  const { child, logs, base, markerPath, releasePath } = await startShutdownDashboard(t, {
    tempPrefix: 'df-shutdown-get-',
    preloadBody: mockDataModuleBlock(),
  });
  t.after(() => {
    try { child.kill('SIGKILL'); } catch (_) {}
  });

  const readPromise = fetch(`${base}/api/v1/accounts`, {
    headers: { 'X-Finance-Token': 'test-api-token' },
  });
  await waitForMarker(markerPath, 'getAccounts:start', childWatchContext({ child, logs }));
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
  const { child, logs, base, markerPath, releasePath } = await startShutdownDashboard(t, {
    tempPrefix: 'df-shutdown-mutation-',
    preloadBody: mockDataModuleBlock(),
  });
  t.after(() => {
    try { child.kill('SIGKILL'); } catch (_) {}
  });

  const mutationPromise = fetch(`${base}/api/v1/budgets`, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      'X-Finance-Token': 'test-api-token',
      'Idempotency-Key': 'shutdown-mutation',
    },
    body: JSON.stringify({ month: '2026-07', categoryId: 'food', amount: 5 }),
  });
  await waitForMarker(markerPath, 'mutation:start', childWatchContext({ child, logs }));
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
  const { child, logs, base } = await startShutdownDashboard(t, {
    tempPrefix: 'df-shutdown-keepalive-',
    preloadBody: mockDataModuleBlock(),
  });
  t.after(() => {
    try { child.kill('SIGKILL'); } catch (_) {}
  });

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
  const hungBody = mockDataModuleBlock(`
      getAccounts: async () => {
        mark('getAccounts:hung');
        await new Promise(() => {});
        return [];
      },
  `);
  const { child, logs, base, markerPath } = await startShutdownDashboard(t, {
    tempPrefix: 'df-shutdown-timeout-',
    preloadBody: hungBody,
    extraEnvForDir: () => ({ FINANCE_SHUTDOWN_TIMEOUT_MS: '800' }),
  });
  t.after(() => {
    try { child.kill('SIGKILL'); } catch (_) {}
  });

  void fetch(`${base}/api/v1/accounts`, {
    headers: { 'X-Finance-Token': 'test-api-token' },
  }).catch(() => {});
  await waitForMarker(markerPath, 'getAccounts:hung', childWatchContext({ child, logs }));

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
  const { child, logs, base } = await startShutdownDashboard(t, {
    tempPrefix: 'df-shutdown-dup-signal-',
    preloadBody: mockDataModuleBlock(),
  });
  t.after(() => {
    try { child.kill('SIGKILL'); } catch (_) {}
  });

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

test('runGracefulShutdown emits in-flight-reads-aborted before admission stops', async () => {
  const phases = [];
  const server = http.createServer();
  const mutationQueue = new SerialQueue('test-mutations');
  const requestAdmission = { closeAdmission() {} };

  const result = await runGracefulShutdown({
    signal: 'SIGTERM',
    httpServer: server,
    mutationQueue,
    requestAdmission,
    shutdownApi: async () => {},
    totalTimeoutMs: 2_000,
    mutationDrainTimeoutMs: 500,
    exit: () => {},
    log: (phase) => { phases.push(phase); },
  });

  assert.equal(result.ok, true);
  assert.ok(phases.includes('in-flight-reads-aborted'));
  assert.ok(phases.indexOf('in-flight-reads-aborted') < phases.indexOf('request-admission-stopped'));
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
  await pollBackoff();
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

  await pollBackoff();
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

  t.mock.timers.enable({ apis: ['setTimeout'] });
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

  void startShutdown('SIGTERM');
  t.mock.timers.tick(80);
  await Promise.resolve();

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
  t.mock.timers.reset();
});
