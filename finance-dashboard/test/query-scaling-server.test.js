'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const crypto = require('crypto');
const fs = require('fs');
const http = require('http');
const path = require('path');
const {
  spawnEphemeralDashboardServer,
  waitForChildExit,
} = require('./helpers/ephemeral-dashboard-server');
const { pollBackoff } = require('./helpers/test-sync-barriers');
const { startQueryScalingServer } = require('./helpers/query-scaling-ephemeral-server');
const { runGracefulShutdownInFlightReadCase } = require('./helpers/query-scaling-shutdown-case');

const spawnQueryScalingServer = startQueryScalingServer;

async function fetchScalingState(base, headers) {
  const response = await fetch(`${base}/api/v1/test/query-scaling-state`, { headers });
  assert.equal(response.status, 200);
  const body = await response.json();
  return body.data;
}

async function tryFetchScalingState(base, headers) {
  try {
    const response = await fetch(`${base}/api/v1/test/query-scaling-state`, { headers });
    if (response.status !== 200) return null;
    const body = await response.json();
    return body.data;
  } catch (_) {
    return null;
  }
}

async function resetScalingState(base, headers) {
  const response = await fetch(`${base}/api/v1/test/query-scaling-reset`, { headers });
  assert.equal(response.status, 200);
}

async function waitForAbortSentinel(base, headers, { minAbortCount = 1, timeoutMs = 5_000 } = {}) {
  const deadline = Date.now() + timeoutMs;
  let lastState = null;
  while (Date.now() < deadline) {
    const state = await tryFetchScalingState(base, headers);
    if (state) {
      lastState = state;
      if (state.abortSentinel.abortCount >= minAbortCount) return state;
    }
    await pollBackoff();
  }
  if (lastState) {
    assert.fail(`abort sentinel not recorded: ${JSON.stringify(lastState)}`);
  }
  assert.fail('abort sentinel state unavailable before shutdown completed');
}

async function waitForScalingListenersDisposed(base, headers, timeoutMs = 8_000) {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    const settled = await tryFetchScalingState(base, headers);
    if (settled && settled.abortSentinel.listenersDisposed >= settled.abortSentinel.listenersAttached) {
      return settled;
    }
    await pollBackoff();
  }
  throw new Error('query scaling listeners were not disposed before deadline');
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
    await pollBackoff();
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
  const { child, logs, dir } = spawnEphemeralDashboardServer({
    nodeEnv: 'production',
    demoOnly: false,
    tempPrefix: 'darkfinances-query-scaling-prod-',
    extraEnvForDir: () => ({
      PUBLIC_ORIGIN: 'https://finances.example.test',
      WEBAUTHN_ORIGIN: 'https://finances.example.test',
      WEBAUTHN_RP_ID: 'finances.example.test',
      FINANCE_QUERY_CURSOR_SECRET: '',
      ACTUAL_SYNC_ID: '',
      PASSKEY_ENROLLMENT_TOKEN_HASH: crypto.createHash('sha256').update('closed').digest('hex'),
      PASSKEY_ENROLLMENT_EXPIRES_AT: String(Date.now() + 60_000),
    }),
  });
  t.after(async () => {
    if (child.exitCode == null) child.kill('SIGTERM');
    await waitForChildExit(child, 5_000).catch(() => {});
    fs.rmSync(dir, { recursive: true, force: true });
  });

  const deadline = Date.now() + 5_000;
  while (Date.now() < deadline && child.exitCode == null) {
    await pollBackoff();
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
  const settled = await waitForScalingListenersDisposed(base, headers);
  assert.ok(serverState.abortSentinel.abortCount >= 1);
  assert.ok(settled.abortSentinel.listenersDisposed >= settled.abortSentinel.listenersAttached);
  // Concurrent abort races may finish one in-flight account fetch beyond the nominal parallel budget.
  assert.ok(serverState.callLog.length <= (accountCount + 1) * 4 + 1);
});

test('graceful shutdown during in-flight read records abort without unbounded Actual calls', async (t) => {
  await runGracefulShutdownInFlightReadCase({
    spawnQueryScalingServer,
    resetScalingState,
    t,
  });
});
