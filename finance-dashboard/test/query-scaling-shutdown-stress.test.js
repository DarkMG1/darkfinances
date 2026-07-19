'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const http = require('http');
const net = require('net');
const os = require('os');
const path = require('path');
const { spawn } = require('child_process');
const { runGracefulShutdownInFlightReadCase } = require('./helpers/query-scaling-shutdown-case');

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
  accountCount = 6,
  rowsPerAccount = 40,
  fetchDelayMs = 80,
  barrierDir = null,
} = {}) {
  const port = await unusedPort();
  const base = `http://127.0.0.1:${port}`;
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'darkfinances-query-scaling-stress-'));
  const fixturePath = path.join(__dirname, 'fixtures', 'query-scaling-actual.js');
  const preload = path.join(dir, 'seed-query-scaling-fixture.js');
  fs.writeFileSync(preload, `
    const fixture = require(${JSON.stringify(fixturePath)});
    fixture.reset({ accountCount: ${accountCount}, rowsPerAccount: ${rowsPerAccount}, anchorMonth: '2024-06', yearSpan: 1 });
  `);
  const logs = { value: '' };
  const child = spawn(process.execPath, ['server.js'], {
    cwd: path.resolve(__dirname, '..'),
    env: baseServerEnv(port, dir, fixturePath, preload, {
      FINANCE_QUERY_TEST_FETCH_DELAY_MS: String(fetchDelayMs),
      FINANCE_QUERY_TEST_ACCOUNT_COUNT: String(accountCount),
      FINANCE_QUERY_TEST_ROWS_PER_ACCOUNT: String(rowsPerAccount),
      ...(barrierDir ? { FINANCE_QUERY_TEST_BARRIER_DIR: barrierDir } : {}),
    }),
    stdio: ['ignore', 'pipe', 'pipe'],
  });
  child.stdout.on('data', (chunk) => { logs.value += chunk; });
  child.stderr.on('data', (chunk) => { logs.value += chunk; });
  if (t) {
    t.after(() => {
      if (child.exitCode == null) {
        child.kill('SIGTERM');
        setTimeout(() => {
          if (child.exitCode == null) child.kill('SIGKILL');
        }, 2_000).unref();
      }
      fs.rmSync(dir, { recursive: true, force: true });
    });
  }
  await waitForServer(base, child, logs);
  return { base, port, dir, logs, child, headers: { 'X-Finance-Token': 'test-api-token' } };
}

async function resetScalingState(base, headers) {
  const response = await fetch(`${base}/api/v1/test/query-scaling-reset`, { headers });
  if (response.status !== 200) {
    throw new Error(`query-scaling-reset failed: ${response.status}`);
  }
}

const STRESS_ENABLED = process.env.FINANCE_QUERY_SHUTDOWN_STRESS === '1';
const SERIAL_RUNS = Number.parseInt(process.env.FINANCE_QUERY_SHUTDOWN_STRESS_SERIAL || '100', 10);
const PARALLEL_RUNS = Number.parseInt(process.env.FINANCE_QUERY_SHUTDOWN_STRESS_PARALLEL || '100', 10);
const PARALLELISM = Number.parseInt(process.env.FINANCE_QUERY_SHUTDOWN_STRESS_WORKERS || '5', 10);

test('graceful shutdown in-flight read stress (serial)', {
  skip: !STRESS_ENABLED,
  timeout: 600_000,
}, async (t) => {
  for (let i = 0; i < SERIAL_RUNS; i += 1) {
    await t.test(`serial run ${i + 1}/${SERIAL_RUNS}`, async (sub) => {
      await runGracefulShutdownInFlightReadCase({
        spawnQueryScalingServer,
        resetScalingState,
        t: sub,
      });
    });
  }
});

test('graceful shutdown in-flight read stress (parallel)', {
  skip: !STRESS_ENABLED,
  timeout: 600_000,
}, async (t) => {
  let cursor = 0;
  async function worker(workerId) {
    while (cursor < PARALLEL_RUNS) {
      const index = cursor;
      cursor += 1;
      if (index >= PARALLEL_RUNS) break;
      await t.test(`parallel run ${index + 1}/${PARALLEL_RUNS} worker ${workerId}`, async (sub) => {
        await runGracefulShutdownInFlightReadCase({
          spawnQueryScalingServer,
          resetScalingState,
          t: sub,
        });
      });
    }
  }
  await Promise.all(Array.from({ length: PARALLELISM }, (_, workerId) => worker(workerId + 1)));
  assert.equal(cursor, PARALLEL_RUNS);
});
