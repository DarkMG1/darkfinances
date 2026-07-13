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

async function request(base, pathname, options = {}) {
  const response = await fetch(`${base}${pathname}`, options);
  const text = await response.text();
  let body;
  try { body = JSON.parse(text); } catch (_) { body = text; }
  return { response, body };
}

test('server security boundaries fail closed', async (t) => {
  const port = await unusedPort();
  const base = `http://127.0.0.1:${port}`;
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'darkfinances-server-'));
  const code = 'test-enrollment-code';
  const logs = { value: '' };
  const child = spawn(process.execPath, ['server.js'], {
    cwd: path.resolve(__dirname, '..'),
    env: {
      ...process.env,
      NODE_ENV: 'test',
      PORT: String(port),
      DEMO_ONLY: '1',
      PUBLIC_ORIGIN: `http://localhost:${port}`,
      WEBAUTHN_ORIGIN: `http://localhost:${port}`,
      WEBAUTHN_RP_ID: 'localhost',
      FINANCE_API_TOKEN: 'test-api-token',
      SESSION_SECRET: 'test-session-secret-with-sufficient-length',
      SESSION_DIR: path.join(dir, 'sessions'),
      OPERATION_JOURNAL_PATH: path.join(dir, 'operation-journal.json'),
      PASSKEY_CREDENTIALS_FILE: path.join(dir, 'credentials.json'),
      PASSKEY_ENROLLMENT_TOKEN_HASH: crypto.createHash('sha256').update(code).digest('hex'),
      PASSKEY_ENROLLMENT_EXPIRES_AT: String(Date.now() + 60_000),
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

  let result = await request(base, '/api/v1/accounts');
  assert.equal(result.response.status, 401);
  result = await request(base, '/api/v1/accounts', { headers: { 'X-Demo-Mode': '1' } });
  assert.equal(result.response.status, 200);
  assert.ok(Array.isArray(result.body.data));
  assert.equal(result.response.headers.get('x-content-type-options'), 'nosniff');
  assert.equal(result.response.headers.get('x-frame-options'), 'DENY');
  assert.equal(result.response.headers.get('cache-control'), 'no-store');
  assert.equal(result.response.headers.get('etag'), null);
  result = await request(base, '/api/v1/today', { headers: { 'X-Demo-Mode': '1' } });
  assert.equal(result.response.status, 200);
  assert.equal(result.body.data.complete, false);
  assert.equal(result.body.data.liquidity.safeToSpend.complete, false);
  assert.equal(result.body.data.liquidity.safeToSpend.value, null);
  assert.equal(result.body.data.liquidity.safeToSpend.valueCents, null);
  assert.equal(result.body.data.revision.startsWith('demo-'), true);

  result = await request(base, '/api/v1/phantom/log', { headers: { 'X-Demo-Mode': '1' } });
  assert.equal(result.response.status, 404);
  result = await request(base, '/api/v1/not-a-real-write', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', 'X-Demo-Mode': '1' },
    body: '{}',
  });
  assert.equal(result.response.status, 404);
  result = await request(base, '/demo', { redirect: 'manual' });
  assert.equal(result.response.status, 200);
  assert.match(String(result.body), /demoOnlyPage/);
  result = await request(base, '/api/v1/transactions', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', 'X-Demo-Mode': '1' },
    body: JSON.stringify({ payee: '<img src=x onerror=alert(1)>' }),
  });
  assert.deepEqual(result.body.data, { ok: true, demo: true });
  result = await request(base, '/api/v1/transactions', { headers: { 'X-Demo-Mode': '1' } });
  assert.equal(JSON.stringify(result.body).includes('onerror'), false);

  result = await request(base, '/api/v1/transactions', {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      'X-Demo-Mode': '1',
      Origin: 'https://evil.example',
    },
    body: '{}',
  });
  assert.equal(result.response.status, 403);

  result = await request(base, '/auth/register/start_DISABLED', { method: 'POST' });
  assert.equal(result.response.status, 404);
  result = await request(base, '/auth/register/start', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: '{}',
  });
  assert.equal(result.response.status, 403);
  result = await request(base, '/auth/enroll/authorize', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ code }),
  });
  assert.equal(result.response.status, 200);
  const cookie = result.response.headers.get('set-cookie').split(';')[0];
  result = await request(base, '/auth/register/start', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', Cookie: cookie },
    body: '{}',
  });
  assert.equal(result.response.status, 200);
  assert.equal(typeof result.body.challenge, 'string');

  result = await request(base, '/api/v1/ping', {
    headers: { 'X-Finance-Token': 'test-api-token' },
  });
  assert.equal(result.response.status, 503);
  assert.equal(result.body.code, 'NOT_READY');
  assert.equal(typeof result.body.requestId, 'string');

  result = await request(base, '/api/v1/transactions', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', 'X-Finance-Token': 'test-api-token' },
    body: JSON.stringify({ accountId: 'account', amount: 0 }),
  });
  assert.equal(result.response.status, 400);
  assert.equal(result.body.code, 'IDEMPOTENCY_KEY_REQUIRED');

  result = await request(base, '/api/v1/transactions', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', 'X-Finance-Token': 'test-api-token', 'Idempotency-Key': 'test-create-invalid' },
    body: JSON.stringify({ accountId: 'account', amount: 0 }),
  });
  assert.equal(result.response.status, 400);
  assert.equal(result.body.code, 'INVALID_REQUEST');

  result = await request(base, '/api/v1/transactions/txn', {
    method: 'DELETE',
    headers: { 'Content-Type': 'application/json', 'X-Finance-Token': 'test-api-token', 'Idempotency-Key': 'test-delete-invalid' },
    body: JSON.stringify({ id: 'txn' }),
  });
  assert.equal(result.response.status, 400);

  result = await request(base, '/api/v1/receipts', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', 'X-Finance-Token': 'test-api-token', 'Idempotency-Key': 'test-receipt-invalid' },
    body: JSON.stringify({ txnId: 'txn', imageBase64: 'PHNjcmlwdD4=', mime: 'text/html' }),
  });
  assert.equal(result.response.status, 400);
});
