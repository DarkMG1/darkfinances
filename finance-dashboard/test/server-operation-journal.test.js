const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const net = require('net');
const os = require('os');
const path = require('path');
const { spawn } = require('child_process');
const { legacyRequestFingerprint } = require('../lib/operation-journal');

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

function mutationOptions(key, body) {
  return {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      'X-Finance-Token': 'test-api-token',
      'Idempotency-Key': key,
    },
    body: JSON.stringify(body),
  };
}

test('server exposes phase-aware replay and legacy-safe operation status', async (t) => {
  const port = await unusedPort();
  const base = `http://127.0.0.1:${port}`;
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'darkfinances-operation-server-'));
  const operationFile = path.join(dir, 'operation-journal.json');
  const reconciliationFile = path.join(dir, 'reconciliation.json');
  const legacyBody = { enabled: false };
  const legacyRoute = '/api/v1/reconciliation/enabled';
  const legacyKey = 'legacy-failed-01';
  fs.writeFileSync(operationFile, JSON.stringify({
    schemaVersion: 1,
    operations: {
      [legacyKey]: {
        key: legacyKey,
        fingerprint: legacyRequestFingerprint('POST', legacyRoute, legacyBody),
        method: 'POST',
        route: legacyRoute,
        status: 'failed',
        startedAt: '2025-01-01T00:00:00.000Z',
        completedAt: '2025-01-01T00:01:00.000Z',
        error: { code: 'INTERNAL_ERROR', message: 'ambiguous old failure' },
      },
    },
  }));

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
      OPERATION_JOURNAL_PATH: operationFile,
      RECON_PATH: reconciliationFile,
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

  const key = 'server-completed-1';
  let result = await request(
    base,
    '/api/v1/reconciliation/enabled?b=2&a=1&a=0',
    mutationOptions(key, { enabled: true }),
  );
  assert.equal(result.response.status, 200);
  assert.deepEqual(result.body.data, { ok: true, enabled: true });
  assert.deepEqual(result.body.operation, { key, replayed: false });

  result = await request(
    base,
    '/api/v1/reconciliation/enabled?a=1&a=0&b=2',
    mutationOptions(key, { enabled: true }),
  );
  assert.equal(result.response.status, 200);
  assert.equal(result.body.operation.replayed, true);

  result = await request(
    base,
    '/api/v1/reconciliation/enabled?a=9&b=2',
    mutationOptions(key, { enabled: true }),
  );
  assert.equal(result.response.status, 409);
  assert.equal(result.body.code, 'IDEMPOTENCY_KEY_REUSED');

  result = await request(base, `/api/v1/operations/${key}`, {
    headers: { 'X-Finance-Token': 'test-api-token' },
  });
  assert.equal(result.response.status, 200);
  assert.equal(result.body.data.status, 'completed');
  assert.equal(result.body.data.phase, 'completed');
  assert.equal(result.body.data.terminal, true);
  assert.deepEqual(result.body.data.result, { ok: true, enabled: true });
  assert.equal(Object.hasOwn(result.body.data, 'fingerprint'), false);

  const invalidKey = 'server-invalid-01';
  const invalidOptions = mutationOptions(invalidKey, { enabled: 'yes' });
  const firstInvalid = await request(base, legacyRoute, invalidOptions);
  const replayedInvalid = await request(base, legacyRoute, invalidOptions);
  assert.equal(firstInvalid.response.status, 400);
  assert.equal(replayedInvalid.response.status, 400);
  assert.equal(firstInvalid.body.code, 'INVALID_REQUEST');
  assert.equal(replayedInvalid.body.code, firstInvalid.body.code);
  assert.equal(replayedInvalid.body.error, firstInvalid.body.error);

  result = await request(base, `/api/v1/operations/${invalidKey}`, {
    headers: { 'X-Finance-Token': 'test-api-token' },
  });
  assert.equal(result.body.data.status, 'failed');
  assert.equal(result.body.data.phase, 'failed');
  assert.equal(result.body.data.outcome, 'failed');

  result = await request(base, `/api/v1/operations/${legacyKey}`, {
    headers: { 'X-Finance-Token': 'test-api-token' },
  });
  assert.equal(result.body.data.status, 'started');
  assert.equal(result.body.data.phase, 'started');
  assert.equal(result.body.data.outcome, 'unknown');
  assert.equal(result.body.data.legacyAmbiguous, true);

  result = await request(base, legacyRoute, mutationOptions(legacyKey, legacyBody));
  assert.equal(result.response.status, 409);
  assert.equal(result.body.code, 'OUTCOME_UNKNOWN');
  assert.equal(JSON.parse(fs.readFileSync(reconciliationFile, 'utf8')).enabled, true);
});
