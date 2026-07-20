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

function buildWebAuthnVerifyCapturePreload() {
  return `
    'use strict';
    const fs = require('fs');
    const root = process.env.TEST_DASHBOARD_ROOT;
    const capturePath = process.env.PASSKEY_VERIFY_CAPTURE_PATH;
    const swuPath = require.resolve('@simplewebauthn/server', { paths: [root] });
    const real = require(swuPath);
    const capture = { register: [], login: [] };
    function persistCapture() {
      if (capturePath) fs.writeFileSync(capturePath, JSON.stringify(capture));
    }
    require.cache[swuPath] = {
      id: swuPath,
      filename: swuPath,
      loaded: true,
      exports: {
        ...real,
        verifyRegistrationResponse: async (opts) => {
          capture.register.push({
            expectedOrigin: opts.expectedOrigin,
            expectedRPID: opts.expectedRPID,
          });
          persistCapture();
          return {
            verified: true,
            registrationInfo: {
              credential: {
                id: 'test-credential-id',
                publicKey: Buffer.alloc(65),
                counter: 0,
              },
            },
          };
        },
        verifyAuthenticationResponse: async (opts) => {
          capture.login.push({
            expectedOrigin: opts.expectedOrigin,
            expectedRPID: opts.expectedRPID,
          });
          persistCapture();
          return {
            verified: true,
            authenticationInfo: { newCounter: 1 },
          };
        },
      },
      children: [],
      paths: [],
    };
  `;
}

function readVerifyCapture(dir) {
  const capturePath = path.join(dir, 'webauthn-verify-capture.json');
  assert.ok(fs.existsSync(capturePath), `missing verify capture file: ${capturePath}`);
  return JSON.parse(fs.readFileSync(capturePath, 'utf8'));
}

function sessionCookieFromSetCookie(setCookieHeader) {
  return String(setCookieHeader || '').split(';')[0];
}

async function waitForReadyPort(logs, instanceId, timeoutMs = 30_000) {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    const ready = parseReadyLine(logs.value, instanceId);
    if (ready) return ready.port;
    await new Promise((resolve) => setImmediate(resolve));
  }
  throw new Error(`server never logged readiness marker: ${logs.value}`);
}

async function waitForBoundPortFromFinanceLog(logs, timeoutMs = 30_000) {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    const match = logs.value.match(/Finance dashboard running on http:\/\/127\.0\.0\.1:(\d+)/);
    if (match) return Number(match[1], 10);
    await new Promise((resolve) => setImmediate(resolve));
  }
  throw new Error(`server never logged bound port: ${logs.value}`);
}

async function spawnPasskeyOriginProbe({
  instanceId,
  nodeEnv = 'test',
  port = '0',
  publicOrigin = 'http://127.0.0.1:0',
  webauthnOrigin = 'http://127.0.0.1:0',
  extraEnv = {},
}) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'darkfinances-passkey-origin-'));
  const preloadPath = path.join(dir, 'webauthn-verify-capture-preload.js');
  fs.writeFileSync(preloadPath, buildWebAuthnVerifyCapturePreload());
  const code = 'passkey-origin-contract-code';
  const logs = { value: '' };
  const child = spawn(process.execPath, ['server.js'], {
    cwd: dashboardRoot(),
    env: buildDashboardServerEnv({
      dir,
      instanceId,
      nodeEnv,
      demoOnly: true,
      port,
      preloadPath,
      extraEnv: {
        PUBLIC_ORIGIN: publicOrigin,
        WEBAUTHN_ORIGIN: webauthnOrigin,
        PASSKEY_VERIFY_CAPTURE_PATH: path.join(dir, 'webauthn-verify-capture.json'),
        PASSKEY_ENROLLMENT_TOKEN_HASH: crypto.createHash('sha256').update(code).digest('hex'),
        PASSKEY_ENROLLMENT_EXPIRES_AT: String(Date.now() + 60_000),
        ...extraEnv,
      },
    }),
    stdio: ['ignore', 'pipe', 'pipe'],
  });
  attachChildLogHandlers(child, logs);
  return { child, logs, dir, instanceId, code, sessionDir: path.join(dir, 'sessions') };
}

function sessionIdFromSetCookie(setCookieHeader) {
  const raw = String(setCookieHeader || '').split(';')[0];
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
    if (session[field] != null) return;
    await new Promise((resolve) => setImmediate(resolve));
  }
  throw new Error(`session field missing: ${field}`);
}

async function finishRegistration(base, sessionDir, code) {
  const enroll = await fetch(`${base}/auth/enroll/authorize`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ code }),
  });
  assert.equal(enroll.status, 200);
  const enrollCookieHeader = enroll.headers.get('set-cookie');
  await waitForPersistedSession(sessionDir, enrollCookieHeader);
  let cookie = sessionCookieFromSetCookie(enrollCookieHeader);
  const start = await fetch(`${base}/auth/register/start`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', Cookie: cookie },
    body: '{}',
  });
  assert.equal(start.status, 200);
  const startCookieHeader = start.headers.get('set-cookie') || enrollCookieHeader;
  if (start.headers.get('set-cookie')) {
    cookie = sessionCookieFromSetCookie(start.headers.get('set-cookie'));
  }
  await waitForSessionField(sessionDir, startCookieHeader, 'regChallenge');
  const finish = await fetch(`${base}/auth/register/finish`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', Cookie: cookie },
    body: JSON.stringify({ id: 'test-credential-id', response: { transports: [] } }),
  });
  assert.equal(finish.status, 200, await finish.text());
  return cookie;
}

async function finishLogin(base, sessionDir, cookie) {
  const start = await fetch(`${base}/auth/login/start`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', Cookie: cookie },
    body: '{}',
  });
  assert.equal(start.status, 200);
  const startCookieHeader = start.headers.get('set-cookie') || cookie;
  if (start.headers.get('set-cookie')) {
    cookie = sessionCookieFromSetCookie(start.headers.get('set-cookie'));
  }
  await waitForSessionField(sessionDir, startCookieHeader, 'authChallenge');
  const finish = await fetch(`${base}/auth/login/finish`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', Cookie: cookie },
    body: JSON.stringify({ id: 'test-credential-id', response: {} }),
  });
  assert.equal(finish.status, 200);
}

test('PORT=0 passkey verification uses rebound bound-port origin for register and login', async (t) => {
  const instanceId = crypto.randomBytes(16).toString('hex');
  const { child, logs, dir, code, sessionDir } = await spawnPasskeyOriginProbe({ instanceId });
  t.after(async () => {
    if (child.exitCode == null) child.kill('SIGTERM');
    await waitForChildExit(child, 5_000).catch(() => {});
    fs.rmSync(dir, { recursive: true, force: true });
  });

  const port = await waitForReadyPort(logs, instanceId);
  const base = `http://127.0.0.1:${port}`;
  const expectedOrigin = `http://127.0.0.1:${port}`;

  const cookie = await finishRegistration(base, sessionDir, code);
  await finishLogin(base, sessionDir, cookie);

  const capture = readVerifyCapture(dir);
  assert.equal(capture.register.length, 1);
  assert.equal(capture.login.length, 1);
  assert.equal(capture.register[0].expectedOrigin, expectedOrigin);
  assert.equal(capture.login[0].expectedOrigin, expectedOrigin);
  assert.notEqual(capture.register[0].expectedOrigin, 'http://127.0.0.1:0');
});

test('fixed-port production passkey verification keeps configured WEBAUTHN_ORIGIN', async (t) => {
  const instanceId = crypto.randomBytes(16).toString('hex');
  const fixedOrigin = 'http://127.0.0.1:5017';
  const { child, logs, dir, code, sessionDir } = await spawnPasskeyOriginProbe({
    instanceId,
    nodeEnv: 'production',
    port: '5017',
    publicOrigin: fixedOrigin,
    webauthnOrigin: fixedOrigin,
  });
  t.after(async () => {
    if (child.exitCode == null) child.kill('SIGTERM');
    await waitForChildExit(child, 5_000).catch(() => {});
    fs.rmSync(dir, { recursive: true, force: true });
  });

  const port = await waitForBoundPortFromFinanceLog(logs);
  assert.equal(port, 5017);
  const base = `http://127.0.0.1:${port}`;

  const cookie = await finishRegistration(base, sessionDir, code);
  await finishLogin(base, sessionDir, cookie);

  const capture = readVerifyCapture(dir);
  assert.equal(capture.register.at(-1).expectedOrigin, fixedOrigin);
  assert.equal(capture.login.at(-1).expectedOrigin, fixedOrigin);
});
