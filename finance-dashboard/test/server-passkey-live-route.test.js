'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const crypto = require('crypto');
const fs = require('fs');
const os = require('os');
const path = require('path');
const { spawn } = require('child_process');
const {
  attachChildLogHandlers,
  buildDashboardServerEnv,
  dashboardRoot,
  parseReadyLine,
  waitForChildExit,
} = require('./helpers/ephemeral-dashboard-server');
const {
  loadPasskeyCredentials,
  resetPasskeyTransactionQueues,
  resetWriteGuards,
  savePasskeyCredentials,
} = require('../lib/passkey-credentials-store');
const { resetPasskeyChallengeGuard } = require('../lib/passkey-challenge-guard');

const CREDENTIAL_ID = 'test-credential-id';

function buildPasskeyLiveRoutePreload({ deferVerify = false, authCounter = 1, injectWriteFailure = false } = {}) {
  return `
    'use strict';
    const fs = require('fs');
    const path = require('path');
    const root = process.env.TEST_DASHBOARD_ROOT;
    const dataPath = require.resolve(path.join(root, 'dataModule.js'));
    require.cache[dataPath] = {
      id: dataPath,
      filename: dataPath,
      loaded: true,
      exports: {
        initApi: async () => ({ ok: true }),
        shutdownApi: async () => ({ ok: true }),
        getHealth: () => ({ ready: true }),
      },
      children: [],
      paths: [],
    };
    ${injectWriteFailure ? `
    const originalRename = fs.renameSync;
    fs.renameSync = function patchedRename(...args) {
      if (String(args[0]).includes('.tmp')) {
        throw new Error('injected rename failure');
      }
      return originalRename(...args);
    };
    ` : ''}
    const capturePath = process.env.PASSKEY_VERIFY_CAPTURE_PATH;
    const gatePath = process.env.PASSKEY_VERIFY_GATE_PATH;
    const swuPath = require.resolve('@simplewebauthn/server', { paths: [root] });
    const real = require(swuPath);
    const capture = { register: 0, login: 0 };
    function persistCapture() {
      if (capturePath) fs.writeFileSync(capturePath, JSON.stringify(capture));
    }
    function waitForGate() {
      if (!${deferVerify ? 'true' : 'false'} || !gatePath) return Promise.resolve();
      return new Promise((resolve) => {
        const poll = () => {
          if (fs.existsSync(gatePath)) return resolve();
          setImmediate(poll);
        };
        poll();
      });
    }
    require.cache[swuPath] = {
      id: swuPath,
      filename: swuPath,
      loaded: true,
      exports: {
        ...real,
        verifyRegistrationResponse: async (opts) => {
          await waitForGate();
          capture.register += 1;
          persistCapture();
          return {
            verified: true,
            registrationInfo: {
              credential: {
                id: '${CREDENTIAL_ID}',
                publicKey: Buffer.alloc(65),
                counter: 0,
              },
            },
          };
        },
        verifyAuthenticationResponse: async (opts) => {
          await waitForGate();
          capture.login += 1;
          persistCapture();
          return {
            verified: true,
            authenticationInfo: { newCounter: ${authCounter} },
          };
        },
      },
      children: [],
      paths: [],
    };
  `;
}

function sessionCookieFromSetCookie(setCookieHeader) {
  return String(setCookieHeader || '').split(';')[0];
}

function sessionIdFromSetCookie(setCookieHeader) {
  const raw = sessionCookieFromSetCookie(setCookieHeader);
  const encodedValue = raw.includes('=') ? raw.slice(raw.indexOf('=') + 1) : '';
  const decodedValue = decodeURIComponent(encodedValue);
  const match = decodedValue.match(/^s:([^.]+)/);
  return match ? match[1] : null;
}

async function waitForPersistedSession(sessionDir, setCookieHeader, timeoutMs = 5_000) {
  const sessionId = sessionIdFromSetCookie(setCookieHeader);
  assert.ok(sessionId, 'expected connect.sid cookie');
  const sessionPath = path.join(sessionDir, `${sessionId}.json`);
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    if (fs.existsSync(sessionPath)) return sessionPath;
    await new Promise((resolve) => setImmediate(resolve));
  }
  throw new Error(`session file missing: ${sessionPath}`);
}

async function waitForSessionField(sessionDir, setCookieHeader, field, timeoutMs = 5_000) {
  const sessionPath = await waitForPersistedSession(sessionDir, setCookieHeader, timeoutMs);
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    const session = JSON.parse(fs.readFileSync(sessionPath, 'utf8'));
    if (session[field] != null) return session[field];
    await new Promise((resolve) => setImmediate(resolve));
  }
  throw new Error(`session field missing: ${field}`);
}

async function waitForSessionFieldAbsent(sessionDir, setCookieHeader, field, timeoutMs = 5_000) {
  const sessionPath = await waitForPersistedSession(sessionDir, setCookieHeader, timeoutMs);
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    const session = JSON.parse(fs.readFileSync(sessionPath, 'utf8'));
    if (session[field] == null) return;
    await new Promise((resolve) => setImmediate(resolve));
  }
  throw new Error(`session field still present: ${field}`);
}

async function spawnPasskeyServer(t, {
  deferVerify = false,
  authCounter = 1,
  credsFile = null,
  injectWriteFailure = false,
  extraEnv = {},
} = {}) {
  resetPasskeyChallengeGuard();
  resetWriteGuards();
  resetPasskeyTransactionQueues();
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'darkfinances-passkey-live-'));
  const preloadPath = path.join(dir, 'passkey-live-preload.js');
  fs.writeFileSync(preloadPath, buildPasskeyLiveRoutePreload({ deferVerify, authCounter, injectWriteFailure }));
  const code = 'passkey-live-route-code';
  const logs = { value: '' };
  const credentialsFile = credsFile || path.join(dir, 'passkey-credentials.json');
  const instanceId = crypto.randomBytes(16).toString('hex');
  const child = spawn(process.execPath, ['server.js'], {
    cwd: dashboardRoot(),
    env: buildDashboardServerEnv({
      dir,
      instanceId,
      preloadPath,
      extraEnv: {
        PASSKEY_VERIFY_CAPTURE_PATH: path.join(dir, 'verify-capture.json'),
        PASSKEY_VERIFY_GATE_PATH: path.join(dir, 'verify-gate.open'),
        PASSKEY_ENROLLMENT_TOKEN_HASH: crypto.createHash('sha256').update(code).digest('hex'),
        PASSKEY_ENROLLMENT_EXPIRES_AT: String(Date.now() + 60_000),
        PASSKEY_CREDENTIALS_FILE: credentialsFile,
        ...extraEnv,
      },
    }),
    stdio: ['ignore', 'pipe', 'pipe'],
  });
  attachChildLogHandlers(child, logs);
  t.after(async () => {
    if (child.exitCode == null) child.kill('SIGTERM');
    await waitForChildExit(child, 5_000).catch(() => {});
    fs.rmSync(dir, { recursive: true, force: true });
  });
  const deadline = Date.now() + 30_000;
  let port;
  while (Date.now() < deadline) {
    const ready = parseReadyLine(logs.value, instanceId);
    if (ready) {
      port = ready.port;
      break;
    }
    await new Promise((resolve) => setImmediate(resolve));
  }
  if (!port) throw new Error(`server never became ready: ${logs.value}`);
  return {
    base: `http://127.0.0.1:${port}`,
    dir,
    code,
    sessionDir: path.join(dir, 'sessions'),
    credentialsFile,
    capturePath: path.join(dir, 'verify-capture.json'),
    gatePath: path.join(dir, 'verify-gate.open'),
    logs,
  };
}

async function authorizeEnrollment(base, code) {
  const enroll = await fetch(`${base}/auth/enroll/authorize`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ code }),
  });
  assert.equal(enroll.status, 200);
  return enroll.headers.get('set-cookie');
}

async function startRegistration(base, cookieHeader) {
  const response = await fetch(`${base}/auth/register/start`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', Cookie: sessionCookieFromSetCookie(cookieHeader) },
    body: '{}',
  });
  assert.equal(response.status, 200);
  const nextCookie = response.headers.get('set-cookie') || cookieHeader;
  return nextCookie;
}

async function startLogin(base, cookieHeader = '') {
  const response = await fetch(`${base}/auth/login/start`, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      ...(cookieHeader ? { Cookie: sessionCookieFromSetCookie(cookieHeader) } : {}),
    },
    body: '{}',
  });
  assert.equal(response.status, 200);
  return response.headers.get('set-cookie') || cookieHeader;
}

test('parallel register finish requests verify exactly once and clear persisted challenge first', async (t) => {
  const { base, code, sessionDir, capturePath, gatePath } = await spawnPasskeyServer(t, { deferVerify: true });
  const enrollCookie = await authorizeEnrollment(base, code);
  await waitForPersistedSession(sessionDir, enrollCookie);
  const startCookie = await startRegistration(base, enrollCookie);
  await waitForSessionField(sessionDir, startCookie, 'regChallenge');

  const cookie = sessionCookieFromSetCookie(startCookie);
  const first = fetch(`${base}/auth/register/finish`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', Cookie: cookie },
    body: JSON.stringify({ id: CREDENTIAL_ID, response: { transports: [] } }),
  });
  const second = fetch(`${base}/auth/register/finish`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', Cookie: cookie },
    body: JSON.stringify({ id: CREDENTIAL_ID, response: { transports: [] } }),
  });

  await waitForSessionFieldAbsent(sessionDir, startCookie, 'regChallenge');
  fs.writeFileSync(gatePath, 'release');
  const [firstRes, secondRes] = await Promise.all([first, second]);
  const firstText = await firstRes.text();
  const secondText = await secondRes.text();
  assert.equal(firstRes.status === 200 || secondRes.status === 200, true);
  assert.equal(firstRes.status === 400 || secondRes.status === 400, true);
  const capture = JSON.parse(fs.readFileSync(capturePath, 'utf8'));
  assert.equal(capture.register, 1);
  assert.equal(firstText.includes('challenge'), false);
  assert.equal(secondText.includes('challenge'), false);
});

test('parallel login finish requests verify exactly once for counterless credentials', async (t) => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'darkfinances-passkey-zero-login-'));
  const credsFile = path.join(dir, 'passkey-credentials.json');
  savePasskeyCredentials([{
    credentialID: CREDENTIAL_ID,
    credentialPublicKey: Buffer.alloc(65).toString('base64'),
    counter: 0,
    transports: ['internal'],
    createdAt: '2026-07-13T00:00:00.000Z',
    lastUsedAt: null,
  }], credsFile);

  const { base, sessionDir, capturePath, gatePath } = await spawnPasskeyServer(t, {
    deferVerify: true,
    authCounter: 0,
    credsFile,
  });
  const startCookie = await startLogin(base);
  await waitForSessionField(sessionDir, startCookie, 'authChallenge');

  const cookie = sessionCookieFromSetCookie(startCookie);
  const first = fetch(`${base}/auth/login/finish`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', Cookie: cookie },
    body: JSON.stringify({ id: CREDENTIAL_ID, response: {} }),
  });
  const second = fetch(`${base}/auth/login/finish`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', Cookie: cookie },
    body: JSON.stringify({ id: CREDENTIAL_ID, response: {} }),
  });

  await waitForSessionFieldAbsent(sessionDir, startCookie, 'authChallenge');
  fs.writeFileSync(gatePath, 'release');
  const [firstRes, secondRes] = await Promise.all([first, second]);
  assert.deepEqual([firstRes.status, secondRes.status].sort(), [200, 400]);
  const capture = JSON.parse(fs.readFileSync(capturePath, 'utf8'));
  assert.equal(capture.login, 1);
  const stored = loadPasskeyCredentials(credsFile)[0];
  assert.equal(stored.counter, 0);
  assert.ok(stored.lastUsedAt);
});

test('concurrent counter updates cannot regress stored counter', async (t) => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'darkfinances-passkey-counter-route-'));
  const credsFile = path.join(dir, 'passkey-credentials.json');
  savePasskeyCredentials([{
    credentialID: CREDENTIAL_ID,
    credentialPublicKey: Buffer.alloc(65).toString('base64'),
    counter: 3,
    transports: ['internal'],
    createdAt: '2026-07-13T00:00:00.000Z',
    lastUsedAt: null,
  }], credsFile);

  const { base, sessionDir, capturePath, gatePath } = await spawnPasskeyServer(t, {
    deferVerify: true,
    authCounter: 4,
    credsFile,
  });

  async function finishOnce() {
    const startCookie = await startLogin(base);
    await waitForSessionField(sessionDir, startCookie, 'authChallenge');
    const cookie = sessionCookieFromSetCookie(startCookie);
    const pending = fetch(`${base}/auth/login/finish`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', Cookie: cookie },
      body: JSON.stringify({ id: CREDENTIAL_ID, response: {} }),
    });
    await waitForSessionFieldAbsent(sessionDir, startCookie, 'authChallenge');
    return pending;
  }

  const firstPending = finishOnce();
  const secondPending = finishOnce();
  fs.writeFileSync(gatePath, 'release');
  const [firstRes, secondRes] = await Promise.all([firstPending, secondPending]);
  assert.deepEqual([firstRes.status, secondRes.status].sort(), [200, 400]);
  const capture = JSON.parse(fs.readFileSync(capturePath, 'utf8'));
  assert.equal(capture.login, 2);
  assert.equal(loadPasskeyCredentials(credsFile)[0].counter, 4);
});

test('credential-store write failure returns 500 and preserves prior file', async (t) => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'darkfinances-passkey-write-fail-route-'));
  const credsFile = path.join(dir, 'passkey-credentials.json');
  savePasskeyCredentials([{
    credentialID: CREDENTIAL_ID,
    credentialPublicKey: Buffer.alloc(65).toString('base64'),
    counter: 2,
    transports: ['internal'],
    createdAt: '2026-07-13T00:00:00.000Z',
    lastUsedAt: null,
  }], credsFile);
  const before = fs.readFileSync(credsFile, 'utf8');

  const { base, sessionDir } = await spawnPasskeyServer(t, {
    authCounter: 3,
    credsFile,
    injectWriteFailure: true,
  });

  const startCookie = await startLogin(base);
  await waitForSessionField(sessionDir, startCookie, 'authChallenge');
  const finish = await fetch(`${base}/auth/login/finish`, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      Cookie: sessionCookieFromSetCookie(startCookie),
    },
    body: JSON.stringify({ id: CREDENTIAL_ID, response: {} }),
  });
  assert.equal(finish.status, 500);
  assert.equal(await finish.text(), '{"error":"Could not complete authentication"}');
  assert.equal(fs.readFileSync(credsFile, 'utf8'), before);
  assert.equal(loadPasskeyCredentials(credsFile)[0].counter, 2);
});

test('successful login finish regenerates session and invalidates prior sid', async (t) => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'darkfinances-passkey-session-regen-'));
  const credsFile = path.join(dir, 'passkey-credentials.json');
  savePasskeyCredentials([{
    credentialID: CREDENTIAL_ID,
    credentialPublicKey: Buffer.alloc(65).toString('base64'),
    counter: 1,
    transports: ['internal'],
    createdAt: '2026-07-13T00:00:00.000Z',
    lastUsedAt: null,
  }], credsFile);

  const { base, sessionDir } = await spawnPasskeyServer(t, { authCounter: 2, credsFile });
  const startCookie = await startLogin(base);
  await waitForSessionField(sessionDir, startCookie, 'authChallenge');
  const oldSessionId = sessionIdFromSetCookie(startCookie);
  assert.ok(oldSessionId);

  const finish = await fetch(`${base}/auth/login/finish`, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      Cookie: sessionCookieFromSetCookie(startCookie),
    },
    body: JSON.stringify({ id: CREDENTIAL_ID, response: {} }),
  });
  assert.equal(finish.status, 200);
  const newCookie = finish.headers.get('set-cookie') || startCookie;
  const newSessionId = sessionIdFromSetCookie(newCookie);
  assert.ok(newSessionId);
  assert.notEqual(newSessionId, oldSessionId);

  const oldStatus = await fetch(`${base}/auth/status`, {
    headers: { Cookie: sessionCookieFromSetCookie(startCookie) },
  });
  assert.equal((await oldStatus.json()).authenticated, false);

  const newStatus = await fetch(`${base}/auth/status`, {
    headers: { Cookie: sessionCookieFromSetCookie(newCookie) },
  });
  assert.equal((await newStatus.json()).authenticated, true);
  await waitForSessionField(sessionDir, newCookie, 'authenticated');
});

test('successful registration finish regenerates session and invalidates prior sid', async (t) => {
  const { base, code, sessionDir, credentialsFile } = await spawnPasskeyServer(t);
  const enrollCookie = await authorizeEnrollment(base, code);
  await waitForPersistedSession(sessionDir, enrollCookie);
  const startCookie = await startRegistration(base, enrollCookie);
  await waitForSessionField(sessionDir, startCookie, 'regChallenge');
  const oldSessionId = sessionIdFromSetCookie(startCookie);
  assert.ok(oldSessionId);

  const finish = await fetch(`${base}/auth/register/finish`, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      Cookie: sessionCookieFromSetCookie(startCookie),
    },
    body: JSON.stringify({ id: CREDENTIAL_ID, response: { transports: [] } }),
  });
  assert.equal(finish.status, 200);
  const newCookie = finish.headers.get('set-cookie') || startCookie;
  const newSessionId = sessionIdFromSetCookie(newCookie);
  assert.ok(newSessionId);
  assert.notEqual(newSessionId, oldSessionId);

  const oldStatus = await fetch(`${base}/auth/status`, {
    headers: { Cookie: sessionCookieFromSetCookie(startCookie) },
  });
  assert.equal((await oldStatus.json()).authenticated, false);

  const newStatus = await fetch(`${base}/auth/status`, {
    headers: { Cookie: sessionCookieFromSetCookie(newCookie) },
  });
  assert.equal((await newStatus.json()).authenticated, true);
  await waitForSessionField(sessionDir, newCookie, 'authenticated');
  const stored = loadPasskeyCredentials(credentialsFile);
  assert.equal(stored.length, 1);
  assert.equal(stored[0].credentialID, CREDENTIAL_ID);
});

test('registration session regeneration failure returns generic 500 and keeps old sid unauthenticated', async (t) => {
  const { base, code, sessionDir, credentialsFile } = await spawnPasskeyServer(t, {
    extraEnv: { TEST_INJECT_SESSION_REGENERATE_FAILURE: '1' },
  });
  const enrollCookie = await authorizeEnrollment(base, code);
  await waitForPersistedSession(sessionDir, enrollCookie);
  const startCookie = await startRegistration(base, enrollCookie);
  await waitForSessionField(sessionDir, startCookie, 'regChallenge');
  assert.equal(loadPasskeyCredentials(credentialsFile).length, 0);

  const finish = await fetch(`${base}/auth/register/finish`, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      Cookie: sessionCookieFromSetCookie(startCookie),
    },
    body: JSON.stringify({ id: CREDENTIAL_ID, response: { transports: [] } }),
  });
  assert.equal(finish.status, 500);
  assert.equal(await finish.text(), '{"error":"Could not complete registration"}');

  const status = await fetch(`${base}/auth/status`, {
    headers: { Cookie: sessionCookieFromSetCookie(startCookie) },
  });
  assert.equal((await status.json()).authenticated, false);
  const stored = loadPasskeyCredentials(credentialsFile);
  assert.equal(stored.length, 1);
  assert.equal(stored[0].credentialID, CREDENTIAL_ID);
});

test('session regeneration failure does not authenticate the browser session', async (t) => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'darkfinances-passkey-session-regen-fail-'));
  const credsFile = path.join(dir, 'passkey-credentials.json');
  savePasskeyCredentials([{
    credentialID: CREDENTIAL_ID,
    credentialPublicKey: Buffer.alloc(65).toString('base64'),
    counter: 1,
    transports: ['internal'],
    createdAt: '2026-07-13T00:00:00.000Z',
    lastUsedAt: null,
  }], credsFile);

  const { base, sessionDir } = await spawnPasskeyServer(t, {
    authCounter: 2,
    credsFile,
    extraEnv: { TEST_INJECT_SESSION_REGENERATE_FAILURE: '1' },
  });

  const startCookie = await startLogin(base);
  await waitForSessionField(sessionDir, startCookie, 'authChallenge');
  const finish = await fetch(`${base}/auth/login/finish`, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      Cookie: sessionCookieFromSetCookie(startCookie),
    },
    body: JSON.stringify({ id: CREDENTIAL_ID, response: {} }),
  });
  assert.equal(finish.status, 500);
  assert.equal(await finish.text(), '{"error":"Could not complete authentication"}');

  const status = await fetch(`${base}/auth/status`, {
    headers: { Cookie: sessionCookieFromSetCookie(startCookie) },
  });
  assert.equal((await status.json()).authenticated, false);
});
