const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const net = require('net');
const os = require('os');
const path = require('path');
const { spawn } = require('child_process');
const { validateSidecar } = require('../../ops/lib/backup-verify');
const { validatePasskeyCredentials } = require('../lib/passkey-credentials-schema');
const {
  loadPasskeyCredentials,
  normalizePasskeyCredentialsFromText,
  resetWriteGuards,
  savePasskeyCredentials,
} = require('../lib/passkey-credentials-store');
const { RuntimeStateError } = require('../lib/runtime-state-store');

function passkeyReadError(error, pattern) {
  return error instanceof RuntimeStateError
    && (pattern.test(error.message) || pattern.test(error.cause?.message || ''));
}

const SAMPLE_CRED = Object.freeze({
  credentialID: 'cred-integration-1',
  credentialPublicKey: Buffer.from('public-key-bytes').toString('base64'),
  counter: 0,
  transports: ['internal'],
  createdAt: '2026-07-13T00:00:00.000Z',
  lastUsedAt: null,
});

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
      const response = await fetch(`${base}/login`);
      if (response.status === 200) return;
    } catch (_) {}
    await new Promise((resolve) => setTimeout(resolve, 25));
  }
  throw new Error(`server startup timeout: ${logs.value}`);
}

async function startServer(t, credsFile) {
  const dir = path.dirname(credsFile);
  fs.mkdirSync(path.join(dir, 'sessions'), { recursive: true, mode: 0o700 });
  const port = await unusedPort();
  const base = `http://127.0.0.1:${port}`;
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
      PASSKEY_CREDENTIALS_FILE: credsFile,
    },
    stdio: ['ignore', 'pipe', 'pipe'],
  });
  child.stdout.on('data', (chunk) => { logs.value += chunk; });
  child.stderr.on('data', (chunk) => { logs.value += chunk; });
  t.after(() => child.kill('SIGTERM'));
  await waitForServer(base, child, logs);
  return { base, child, logs };
}

test('loadPasskeyCredentials treats missing file as empty enrollment', (t) => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'darkfinances-passkey-'));
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
  assert.deepEqual(loadPasskeyCredentials(path.join(dir, 'missing.json')), []);
});

test('loadPasskeyCredentials unwraps legacy wrapper losslessly', (t) => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'darkfinances-passkey-'));
  const file = path.join(dir, 'passkey-credentials.json');
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
  fs.writeFileSync(file, `${JSON.stringify({ credentials: [SAMPLE_CRED] }, null, 2)}\n`, { mode: 0o600 });
  assert.deepEqual(loadPasskeyCredentials(file), [SAMPLE_CRED]);
});

test('loadPasskeyCredentials rejects JSON null and malformed wrapper', (t) => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'darkfinances-passkey-'));
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
  const nullFile = path.join(dir, 'null.json');
  fs.writeFileSync(nullFile, 'null\n', { mode: 0o600 });
  assert.throws(
    () => loadPasskeyCredentials(nullFile),
    (error) => passkeyReadError(error, /JSON null is invalid/),
  );
  const badFile = path.join(dir, 'bad.json');
  fs.writeFileSync(badFile, `${JSON.stringify({ credentials: 'bad' })}\n`, { mode: 0o600 });
  assert.throws(
    () => loadPasskeyCredentials(badFile),
    (error) => passkeyReadError(error, /credentials must be an array/),
  );
});

test('malformed passkey credential entries fail schema backup validation and production load', (t) => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'darkfinances-passkey-malformed-'));
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
  const malformed = JSON.stringify([{}]);
  assert.equal(validatePasskeyCredentials(JSON.parse(malformed)), false);
  assert.throws(
    () => validateSidecar('passkey-credentials.json', malformed),
    /failed schema validation|invalid/i,
  );
  assert.throws(
    () => normalizePasskeyCredentialsFromText(malformed),
    RuntimeStateError,
  );
  resetWriteGuards();
  const file = path.join(dir, 'passkey-credentials.json');
  fs.writeFileSync(file, `${malformed}\n`, { mode: 0o600 });
  assert.throws(() => loadPasskeyCredentials(file), RuntimeStateError);
});

test('corrupt passkey primary quarantines read and blocks external save', (t) => {
  resetWriteGuards();
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'darkfinances-passkey-guard-'));
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
  const file = path.join(dir, 'passkey-credentials.json');
  fs.writeFileSync(file, '[{}]\n', { mode: 0o600 });
  assert.throws(() => loadPasskeyCredentials(file), RuntimeStateError);
  assert.throws(
    () => savePasskeyCredentials([SAMPLE_CRED], file),
    (error) => error.code === 'RUNTIME_STATE_WRITE_BLOCKED',
  );
  assert.ok(fs.readdirSync(dir).some((entry) => entry.includes('.corrupt-')));
});

test('missing passkey file allows external save', (t) => {
  resetWriteGuards();
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'darkfinances-passkey-missing-save-'));
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
  const file = path.join(dir, 'passkey-credentials.json');
  assert.doesNotThrow(() => savePasskeyCredentials([SAMPLE_CRED], file));
  assert.deepEqual(JSON.parse(fs.readFileSync(file, 'utf8')), [SAMPLE_CRED]);
});

test('backup-validated passkey bytes normalize to the same credentials loadPasskeyCredentials consumes', () => {
  const wrapper = JSON.stringify({ credentials: [SAMPLE_CRED] });
  assert.doesNotThrow(() => validateSidecar('passkey-credentials.json', wrapper));
  assert.deepEqual(
    normalizePasskeyCredentialsFromText(wrapper),
    loadPasskeyCredentialsFromBytes(wrapper),
  );
  const bare = JSON.stringify([SAMPLE_CRED]);
  assert.doesNotThrow(() => validateSidecar('passkey-credentials.json', bare));
  assert.deepEqual(normalizePasskeyCredentialsFromText(bare), [SAMPLE_CRED]);
});

function loadPasskeyCredentialsFromBytes(text) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'darkfinances-passkey-bytes-'));
  const file = path.join(dir, 'passkey-credentials.json');
  fs.writeFileSync(file, `${text}\n`, { mode: 0o600 });
  try {
    return loadPasskeyCredentials(file);
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
}

test('savePasskeyCredentials writes canonical bare array with private mode and atomic rename', (t) => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'darkfinances-passkey-save-'));
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
  const file = path.join(dir, 'passkey-credentials.json');
  savePasskeyCredentials([SAMPLE_CRED], file);
  const stat = fs.statSync(file);
  assert.equal(stat.mode & 0o777, 0o600);
  assert.deepEqual(JSON.parse(fs.readFileSync(file, 'utf8')), [SAMPLE_CRED]);
  assert.equal(fs.readdirSync(dir).some((name) => name.includes('.tmp')), false);
});

test('server auth/status treats missing credentials file as unregistered', async (t) => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'darkfinances-passkey-server-'));
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
  const credsFile = path.join(dir, 'passkey-credentials.json');
  const server = await startServer(t, credsFile);
  const response = await fetch(`${server.base}/auth/status`);
  const body = await response.json();
  assert.equal(response.status, 200);
  assert.equal(body.registered, false);
});

test('server auth/status accepts legacy wrapper credentials on disk', async (t) => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'darkfinances-passkey-server-'));
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
  const credsFile = path.join(dir, 'passkey-credentials.json');
  fs.writeFileSync(credsFile, `${JSON.stringify({ credentials: [SAMPLE_CRED] }, null, 2)}\n`, { mode: 0o600 });
  const server = await startServer(t, credsFile);
  const response = await fetch(`${server.base}/auth/status`);
  const body = await response.json();
  assert.equal(response.status, 200);
  assert.equal(body.registered, true);
});

test('server auth/status fails closed for JSON null credentials file', async (t) => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'darkfinances-passkey-server-'));
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
  const credsFile = path.join(dir, 'passkey-credentials.json');
  fs.writeFileSync(credsFile, 'null\n', { mode: 0o600 });
  const server = await startServer(t, credsFile);
  const response = await fetch(`${server.base}/auth/status`);
  assert.equal(response.status, 500);
});

test('server auth/status fails closed for malformed credentials file', async (t) => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'darkfinances-passkey-server-'));
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
  const credsFile = path.join(dir, 'passkey-credentials.json');
  fs.writeFileSync(credsFile, `${JSON.stringify({ credentials: 'bad' })}\n`, { mode: 0o600 });
  const server = await startServer(t, credsFile);
  const response = await fetch(`${server.base}/auth/status`);
  assert.equal(response.status, 500);
});

test('server auth/status fails closed for nonfunctional credential entries', async (t) => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'darkfinances-passkey-server-'));
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
  const credsFile = path.join(dir, 'passkey-credentials.json');
  fs.writeFileSync(credsFile, '[{}]\n', { mode: 0o600 });
  const server = await startServer(t, credsFile);
  const response = await fetch(`${server.base}/auth/status`);
  assert.equal(response.status, 500);
});
