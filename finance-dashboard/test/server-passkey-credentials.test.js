const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const os = require('os');
const path = require('path');
const { validateSidecar } = require('../../ops/lib/backup-verify');
const { validatePasskeyCredentials } = require('../lib/passkey-credentials-schema');
const {
  loadPasskeyCredentials,
  normalizePasskeyCredentialsFromText,
  resetWriteGuards,
  savePasskeyCredentials,
} = require('../lib/passkey-credentials-store');
const { RuntimeStateError } = require('../lib/runtime-state-store');
const { startEphemeralDashboardServer } = require('./helpers/ephemeral-dashboard-server');

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

async function startServer(t, credsFile) {
  const dir = path.dirname(credsFile);
  fs.mkdirSync(path.join(dir, 'sessions'), { recursive: true, mode: 0o700 });
  const started = await startEphemeralDashboardServer(t, {
    tempPrefix: 'darkfinances-passkey-server-',
    dir,
    extraEnvForDir: () => ({
      PASSKEY_CREDENTIALS_FILE: credsFile,
    }),
  });
  return started;
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
