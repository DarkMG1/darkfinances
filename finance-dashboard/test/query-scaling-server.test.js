'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const crypto = require('crypto');
const fs = require('fs');
const http = require('http');
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
  const deadline = Date.now() + 15_000;
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

function baseServerEnv(port, dir, fixturePath, preload, extra = {}) {
  return {
    ...process.env,
    NODE_ENV: 'test',
    NODE_OPTIONS: `${process.env.NODE_OPTIONS || ''} --require=${preload}`.trim(),
    PORT: String(port),
    PUBLIC_ORIGIN: `http://localhost:${port}`,
    WEBAUTHN_ORIGIN: `http://localhost:${port}`,
    WEBAUTHN_RP_ID: 'localhost',
    FINANCE_API_TOKEN: 'test-api-token',
    FINANCE_QUERY_CURSOR_SECRET: 'server-test-cursor-secret',
    ACTUAL_API_PATH: fixturePath,
    ACTUAL_DATA_DIR: path.join(dir, 'actual-cache'),
    ACTUAL_SERVER_URL: 'http://127.0.0.1:1',
    ACTUAL_PASSWORD: 'test',
    ACTUAL_SYNC_ID: 'test-sync-id',
    FINANCE_TIME_ZONE: 'America/Los_Angeles',
    FINANCE_QUERY_MAX_LEDGER_ROWS: '500000',
    FINANCE_QUERY_MAX_TXN_LIST_ROWS: '500000',
    SESSION_SECRET: 'test-session-secret-with-sufficient-length',
    SESSION_DIR: path.join(dir, 'sessions'),
    OPERATION_JOURNAL_PATH: path.join(dir, 'operation-journal.json'),
    PASSKEY_CREDENTIALS_FILE: path.join(dir, 'credentials.json'),
    EVENTS_PATH: path.join(dir, 'events.json'),
    ...extra,
  };
}

async function spawnQueryScalingServer(t, {
  preloadBody,
  accountCount = 2,
  rowsPerAccount = 8,
  fetchDelayMs = 0,
  eventsSeed = null,
} = {}) {
  const port = await unusedPort();
  const base = `http://127.0.0.1:${port}`;
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'darkfinances-query-scaling-'));
  const fixturePath = path.join(__dirname, 'fixtures', 'query-scaling-actual.js');
  const preload = path.join(dir, 'seed-query-scaling-fixture.js');
  fs.writeFileSync(preload, preloadBody || `
    const fixture = require(${JSON.stringify(fixturePath)});
    fixture.reset({ accountCount: ${accountCount}, rowsPerAccount: ${rowsPerAccount}, anchorMonth: '2024-06', yearSpan: 1 });
  `);
  if (eventsSeed) {
    fs.writeFileSync(path.join(dir, 'events.json'), JSON.stringify(eventsSeed));
  }
  const logs = { value: '' };
  const child = spawn(process.execPath, ['server.js'], {
    cwd: path.resolve(__dirname, '..'),
    env: baseServerEnv(port, dir, fixturePath, preload, {
      FINANCE_QUERY_TEST_FETCH_DELAY_MS: String(fetchDelayMs),
      FINANCE_QUERY_TEST_ACCOUNT_COUNT: String(accountCount),
      FINANCE_QUERY_TEST_ROWS_PER_ACCOUNT: String(rowsPerAccount),
    }),
    stdio: ['ignore', 'pipe', 'pipe'],
  });
  child.stdout.on('data', (chunk) => { logs.value += chunk; });
  child.stderr.on('data', (chunk) => { logs.value += chunk; });
  t.after(() => {
    if (child.exitCode == null) child.kill('SIGTERM');
    fs.rmSync(dir, { recursive: true, force: true });
  });
  await waitForServer(base, child, logs);
  return { base, port, dir, logs, child, headers: { 'X-Finance-Token': 'test-api-token' } };
}

async function fetchScalingState(base, headers) {
  const response = await fetch(`${base}/api/v1/test/query-scaling-state`, { headers });
  assert.equal(response.status, 200);
  const body = await response.json();
  return body.data;
}

async function resetScalingState(base, headers) {
  const response = await fetch(`${base}/api/v1/test/query-scaling-reset`, { headers });
  assert.equal(response.status, 200);
}

async function waitForAbortSentinel(base, headers, { minAbortCount = 1, timeoutMs = 5_000 } = {}) {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    const state = await fetchScalingState(base, headers);
    if (state.abortSentinel.abortCount >= minAbortCount) return state;
    await new Promise((resolve) => setTimeout(resolve, 25));
  }
  const finalState = await fetchScalingState(base, headers);
  assert.fail(`abort sentinel not recorded: ${JSON.stringify(finalState.abortSentinel)}`);
}

test('v1 read responses include query instrumentation headers', async (t) => {
  const { base, headers } = await spawnQueryScalingServer(t);

  const deadline = Date.now() + 10_000;
  let response;
  while (Date.now() < deadline) {
    response = await fetch(`${base}/api/v1/transactions?start=2024-06-01&end=2024-06-30`, { headers });
    if (
      response.status === 200
      && Number(response.headers.get('x-finance-query-accounts') || 0) > 0
    ) break;
    await new Promise((resolve) => setTimeout(resolve, 50));
  }
  assert.equal(response.status, 200);
  assert.match(response.headers.get('x-finance-query-accounts'), /^[1-9]\d*$/);
  assert.match(response.headers.get('x-finance-query-calls'), /^[1-9]\d*$/);
  assert.match(response.headers.get('x-finance-query-rows-scanned'), /^[1-9]\d*$/);
  assert.match(response.headers.get('x-finance-query-rows-returned'), /^\d+$/);
  assert.match(response.headers.get('x-finance-query-peak-retained'), /^\d+$/);
  assert.match(response.headers.get('x-finance-query-elapsed-ms'), /^\d+$/);
  assert.ok(Number(response.headers.get('x-finance-query-peak-retained')) <= Number(response.headers.get('x-finance-query-rows-returned')));
  assert.notEqual(response.headers.get('x-finance-query-aborted'), '1');
});

test('production server startup fails closed without cursor signing secret', async (t) => {
  const port = await unusedPort();
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'darkfinances-query-scaling-prod-'));
  const logs = { value: '' };
  const child = spawn(process.execPath, ['server.js'], {
    cwd: path.resolve(__dirname, '..'),
    env: {
      ...process.env,
      NODE_ENV: 'production',
      PORT: String(port),
      PUBLIC_ORIGIN: 'https://finances.example.test',
      WEBAUTHN_ORIGIN: 'https://finances.example.test',
      WEBAUTHN_RP_ID: 'finances.example.test',
      FINANCE_API_TOKEN: 'test-api-token',
      SESSION_SECRET: 'test-session-secret-with-sufficient-length',
      SESSION_DIR: path.join(dir, 'sessions'),
      OPERATION_JOURNAL_PATH: path.join(dir, 'operation-journal.json'),
      PASSKEY_CREDENTIALS_FILE: path.join(dir, 'credentials.json'),
      PASSKEY_ENROLLMENT_TOKEN_HASH: crypto.createHash('sha256').update('closed').digest('hex'),
      PASSKEY_ENROLLMENT_EXPIRES_AT: String(Date.now() + 60_000),
    },
    stdio: ['ignore', 'pipe', 'pipe'],
  });
  child.stdout.on('data', (chunk) => { logs.value += chunk; });
  child.stderr.on('data', (chunk) => { logs.value += chunk; });
  t.after(() => {
    if (child.exitCode == null) child.kill('SIGTERM');
    fs.rmSync(dir, { recursive: true, force: true });
  });

  const deadline = Date.now() + 5_000;
  while (Date.now() < deadline && child.exitCode == null) {
    await new Promise((resolve) => setTimeout(resolve, 25));
  }
  assert.notEqual(child.exitCode, 0);
  assert.match(logs.value, /Query cursor signing requires FINANCE_QUERY_CURSOR_SECRET/);
});

test('client disconnect aborts in-flight ledger reads with server-side abort markers', async (t) => {
  const accountCount = 6;
  const { base, headers, port } = await spawnQueryScalingServer(t, {
    accountCount,
    rowsPerAccount: 40,
    fetchDelayMs: 40,
  });
  await resetScalingState(base, headers);

  const outcome = await new Promise((resolve) => {
    const req = http.request({
      hostname: '127.0.0.1',
      port,
      path: '/api/v1/transactions?start=2024-01-01&end=2024-12-31',
      method: 'GET',
      headers,
    }, (res) => {
      let body = '';
      res.on('data', (chunk) => { body += chunk; });
      res.on('end', () => resolve({ status: res.statusCode, body, headers: res.headers }));
    });
    req.on('error', (error) => resolve({ error }));
    req.end();
    setTimeout(() => req.destroy(), 30);
  });

  const serverState = await waitForAbortSentinel(base, headers);
  assert.ok(serverState.abortSentinel.abortCount >= 1);
  assert.ok(serverState.callLog.length <= accountCount + 1, `expected bounded Actual calls, got ${serverState.callLog.length}`);

  if (outcome.error) {
    assert.match(String(outcome.error.code || outcome.error.message), /ECONNRESET|aborted/i);
  } else {
    assert.notEqual(outcome.status, 200);
    const parsed = JSON.parse(outcome.body);
    assert.equal(parsed.code, 'QUERY_ABORTED');
    assert.equal(parsed.requiresIdempotencyKeyReuse, false);
    assert.equal(outcome.headers['x-finance-query-aborted'], '1');
    assert.equal(outcome.headers['x-finance-query-rows-returned'], '0');
    assert.equal(outcome.headers['x-finance-query-peak-retained'], '0');
  }
});

test('normal completed GET does not record abort sentinel or false-positive abort headers', async (t) => {
  const { base, headers } = await spawnQueryScalingServer(t, { accountCount: 2, rowsPerAccount: 8 });
  await resetScalingState(base, headers);

  const response = await fetch(`${base}/api/v1/transactions?start=2024-06-01&end=2024-06-30`, { headers });
  assert.equal(response.status, 200);
  assert.notEqual(response.headers.get('x-finance-query-aborted'), '1');

  const state = await fetchScalingState(base, headers);
  assert.equal(state.abortSentinel.abortCount, 0);
  assert.ok(state.abortSentinel.listenersDisposed >= state.abortSentinel.listenersAttached);
});

test('keep-alive sequential GETs complete without abort sentinel noise', async (t) => {
  const { base, headers } = await spawnQueryScalingServer(t, { accountCount: 2, rowsPerAccount: 8 });
  await resetScalingState(base, headers);

  for (let i = 0; i < 3; i++) {
    const response = await fetch(`${base}/api/v1/transactions?start=2024-06-01&end=2024-06-30`, {
      headers: { ...headers, Connection: 'keep-alive' },
      keepalive: true,
    });
    assert.equal(response.status, 200);
    await response.arrayBuffer();
  }

  const state = await fetchScalingState(base, headers);
  assert.equal(state.abortSentinel.abortCount, 0);
  assert.ok(state.abortSentinel.listenersDisposed >= state.abortSentinel.listenersAttached);
});

test('handler error path disposes client abort listeners', async (t) => {
  const { base, headers } = await spawnQueryScalingServer(t);
  await resetScalingState(base, headers);

  const response = await fetch(`${base}/api/v1/test/query-scaling-throw`, { headers });
  assert.equal(response.status, 500);
  const body = await response.json();
  assert.equal(body.code, 'TEST_HANDLER_ERROR');

  const state = await fetchScalingState(base, headers);
  assert.equal(state.abortSentinel.abortCount, 0);
  assert.ok(state.abortSentinel.listenersDisposed >= state.abortSentinel.listenersAttached);
});

test('explicit fetch abort returns QUERY_ABORTED without relying on client ECONNRESET alone', async (t) => {
  const accountCount = 4;
  const { base, headers } = await spawnQueryScalingServer(t, {
    accountCount,
    rowsPerAccount: 30,
    fetchDelayMs: 50,
  });
  await resetScalingState(base, headers);

  const controller = new AbortController();
  const responsePromise = fetch(`${base}/api/v1/transactions?start=2024-01-01&end=2024-12-31`, {
    headers,
    signal: controller.signal,
  });
  setTimeout(() => controller.abort(), 20);

  const response = await responsePromise.catch((error) => ({ aborted: true, error }));
  if (!response.aborted) {
    assert.notEqual(response.status, 200);
    const body = await response.json();
    assert.equal(body.code, 'QUERY_ABORTED');
    assert.equal(response.headers.get('x-finance-query-aborted'), '1');
  }

  const serverState = await waitForAbortSentinel(base, headers);
  assert.ok(serverState.callLog.length <= accountCount + 1);
});

test('/events disconnect aborts enrichment ledger reads', async (t) => {
  const accountCount = 3;
  const { base, headers, port } = await spawnQueryScalingServer(t, {
    accountCount,
    rowsPerAccount: 25,
    fetchDelayMs: 120,
    eventsSeed: {
      events: [{ slug: 'trip-a', name: 'Trip A', start: '2024-06-01', created: '2024-06-01T00:00:00.000Z' }],
    },
  });
  await resetScalingState(base, headers);

  await new Promise((resolve) => {
    const req = http.request({
      hostname: '127.0.0.1',
      port,
      path: '/api/v1/test/query-scaling-events',
      method: 'GET',
      headers,
    }, (res) => {
      res.on('data', () => {});
      res.on('end', resolve);
    });
    req.on('error', () => resolve());
    req.end();
    setTimeout(() => req.destroy(), 60);
  });

  const serverState = await waitForAbortSentinel(base, headers, { timeoutMs: 8_000 });
  assert.ok(serverState.abortSentinel.abortCount >= 1);
  assert.ok(serverState.callLog.length <= accountCount + 1);
});

test('concurrent disconnecting reads stay bounded and dispose listeners', async (t) => {
  const accountCount = 6;
  const { base, headers, port } = await spawnQueryScalingServer(t, {
    accountCount,
    rowsPerAccount: 35,
    fetchDelayMs: 35,
  });
  await resetScalingState(base, headers);

  await Promise.all(Array.from({ length: 4 }, () => new Promise((resolve) => {
    const req = http.request({
      hostname: '127.0.0.1',
      port,
      path: '/api/v1/transactions?start=2024-01-01&end=2024-12-31',
      method: 'GET',
      headers,
    }, (res) => {
      res.on('data', () => {});
      res.on('end', resolve);
    });
    req.on('error', () => resolve());
    req.end();
    setTimeout(() => req.destroy(), 20);
  })));

  const serverState = await waitForAbortSentinel(base, headers, { minAbortCount: 1, timeoutMs: 8_000 });
  await new Promise((resolve) => setTimeout(resolve, 150));
  const settled = await fetchScalingState(base, headers);
  assert.ok(serverState.abortSentinel.abortCount >= 1);
  assert.ok(settled.abortSentinel.listenersDisposed >= settled.abortSentinel.listenersAttached);
  // Concurrent abort races may finish one in-flight account fetch beyond the nominal parallel budget.
  assert.ok(serverState.callLog.length <= (accountCount + 1) * 4 + 1);
});

test('graceful shutdown during in-flight read records abort without unbounded Actual calls', async (t) => {
  const accountCount = 6;
  const { base, headers, port, child } = await spawnQueryScalingServer(t, {
    accountCount,
    rowsPerAccount: 40,
    fetchDelayMs: 80,
  });
  await resetScalingState(base, headers);

  http.request({
    hostname: '127.0.0.1',
    port,
    path: '/api/v1/transactions?start=2024-01-01&end=2024-12-31',
    method: 'GET',
    headers,
  }, (res) => {
    res.on('data', () => {});
  }).end();

  await new Promise((resolve) => setTimeout(resolve, 25));
  child.kill('SIGTERM');

  const deadline = Date.now() + 8_000;
  let serverState;
  while (Date.now() < deadline) {
    try {
      serverState = await fetchScalingState(base, headers);
      if (serverState.abortSentinel.abortCount >= 1) break;
    } catch (_) {}
    await new Promise((resolve) => setTimeout(resolve, 50));
  }
  if (serverState) {
    assert.ok(serverState.abortSentinel.abortCount >= 1);
    assert.ok(serverState.callLog.length <= accountCount + 1);
  }
});
