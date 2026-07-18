'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const crypto = require('crypto');
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

test('v1 read responses include query instrumentation headers', async (t) => {
  const port = await unusedPort();
  const base = `http://127.0.0.1:${port}`;
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'darkfinances-query-scaling-'));
  const fixturePath = path.join(__dirname, 'fixtures', 'query-scaling-actual.js');
  const preload = path.join(dir, 'seed-query-scaling-fixture.js');
  fs.writeFileSync(preload, `
    const fixture = require(${JSON.stringify(fixturePath)});
    fixture.reset({ accountCount: 2, rowsPerAccount: 8, anchorMonth: '2024-06', yearSpan: 1 });
  `);
  const logs = { value: '' };
  const child = spawn(process.execPath, ['server.js'], {
    cwd: path.resolve(__dirname, '..'),
    env: {
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

  const deadline = Date.now() + 10_000;
  let response;
  while (Date.now() < deadline) {
    response = await fetch(`${base}/api/v1/transactions?start=2024-06-01&end=2024-06-30`, {
      headers: { 'X-Finance-Token': 'test-api-token' },
    });
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

test('client disconnect aborts in-flight ledger reads without partial JSON success', async (t) => {
  const http = require('http');
  const port = await unusedPort();
  const base = `http://127.0.0.1:${port}`;
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'darkfinances-query-scaling-abort-'));
  const fixturePath = path.join(__dirname, 'fixtures', 'query-scaling-actual.js');
  const preload = path.join(dir, 'seed-query-scaling-abort.js');
  fs.writeFileSync(preload, `
    const fixture = require(${JSON.stringify(fixturePath)});
    fixture.reset({ accountCount: 6, rowsPerAccount: 40, anchorMonth: '2024-06', yearSpan: 1 });
  `);
  const logs = { value: '' };
  const child = spawn(process.execPath, ['server.js'], {
    cwd: path.resolve(__dirname, '..'),
    env: {
      ...process.env,
      NODE_ENV: 'test',
      NODE_OPTIONS: `${process.env.NODE_OPTIONS || ''} --require=${preload}`.trim(),
      PORT: String(port),
      PUBLIC_ORIGIN: `http://localhost:${port}`,
      WEBAUTHN_ORIGIN: `http://localhost:${port}`,
      WEBAUTHN_RP_ID: 'localhost',
      FINANCE_API_TOKEN: 'test-api-token',
      FINANCE_QUERY_CURSOR_SECRET: 'server-test-cursor-secret',
      FINANCE_QUERY_TEST_FETCH_DELAY_MS: '40',
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

  const outcome = await new Promise((resolve) => {
    const req = http.request({
      hostname: '127.0.0.1',
      port,
      path: '/api/v1/transactions?start=2024-01-01&end=2024-12-31',
      method: 'GET',
      headers: { 'X-Finance-Token': 'test-api-token' },
    }, (res) => {
      let body = '';
      res.on('data', (chunk) => { body += chunk; });
      res.on('end', () => resolve({ status: res.statusCode, body, headers: res.headers }));
    });
    req.on('error', (error) => resolve({ error }));
    req.end();
    setTimeout(() => req.destroy(), 30);
  });

  if (outcome.error) {
    assert.match(String(outcome.error.code || outcome.error.message), /ECONNRESET|aborted/i);
  } else {
    assert.notEqual(outcome.status, 200);
    const parsed = JSON.parse(outcome.body);
    assert.equal(parsed.code, 'QUERY_ABORTED');
    assert.equal(parsed.requiresIdempotencyKeyReuse, false);
    assert.equal(outcome.headers['x-finance-query-aborted'], '1');
  }
});
