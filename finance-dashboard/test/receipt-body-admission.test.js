'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const crypto = require('crypto');
const fs = require('fs');
const path = require('path');
const {
  DEFAULT_MAX_JSON_BYTES,
  RECEIPT_MAX_JSON_BYTES,
} = require('../lib/receipt-limits');
const { startEphemeralDashboardServer } = require('./helpers/ephemeral-dashboard-server');
const { pollBackoff } = require('./helpers/test-sync-barriers');

const RECEIPT_PRELOAD = `
  const path = require('path');
  const root = process.env.TEST_DASHBOARD_ROOT;
  const dataPath = require.resolve(path.join(root, 'dataModule.js'));
  const real = require(dataPath);
  require.cache[dataPath] = {
    id: dataPath,
    filename: dataPath,
    loaded: true,
    exports: new Proxy(real, {
      get(target, property) {
        if (property === 'getTransactionById') return async ({ id }) => ({ id });
        if (property === 'initApi') return async () => ({ ok: true });
        if (property === 'shutdownApi') return async () => ({ ok: true });
        if (property === 'getHealth') return () => ({ ready: true });
        return target[property];
      },
    }),
    children: [],
    paths: [],
  };
`;

function largeReceiptJson(txnId) {
  const payload = Buffer.alloc(DEFAULT_MAX_JSON_BYTES, 0x41);
  Buffer.from(txnId).copy(payload);
  const png = Buffer.concat([
    Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]),
    payload,
  ]);
  const json = JSON.stringify({
    txnId,
    accountId: 'account-id',
    transactionDate: '2026-08-05',
    imageBase64: png.toString('base64'),
    mime: 'image/png',
    source: 'camera',
  });
  assert.ok(Buffer.byteLength(json) > DEFAULT_MAX_JSON_BYTES);
  assert.ok(Buffer.byteLength(json) < RECEIPT_MAX_JSON_BYTES);
  return json;
}

async function jsonResponse(response) {
  return { response, body: await response.json() };
}

function sessionIdFromSetCookie(setCookieHeader) {
  const raw = String(setCookieHeader || '').split(';')[0];
  const encodedValue = raw.includes('=') ? raw.slice(raw.indexOf('=') + 1) : '';
  const match = decodeURIComponent(encodedValue).match(/^s:([^.]+)/);
  return match ? match[1] : null;
}

async function authenticateBrowserSession(base, sessionDir, code) {
  const authorize = await fetch(`${base}/auth/enroll/authorize`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ code }),
  });
  assert.equal(authorize.status, 200);
  const setCookie = authorize.headers.get('set-cookie');
  const sessionId = sessionIdFromSetCookie(setCookie);
  assert.ok(sessionId);
  const sessionPath = path.join(sessionDir, `${sessionId}.json`);
  const deadline = Date.now() + 2_000;
  while (!fs.existsSync(sessionPath) && Date.now() < deadline) {
    await pollBackoff();
  }
  assert.ok(fs.existsSync(sessionPath), `session file missing: ${sessionPath}`);
  const session = JSON.parse(fs.readFileSync(sessionPath, 'utf8'));
  session.authenticated = true;
  fs.writeFileSync(sessionPath, JSON.stringify(session));
  return String(setCookie).split(';')[0];
}

test('large receipt JSON limit is available only to native and browser authenticated requests', async (t) => {
  const enrollmentCode = 'receipt-body-admission-code';
  const { base, dir } = await startEphemeralDashboardServer(t, {
    tempPrefix: 'darkfinances-receipt-body-admission-',
    preloadBody: RECEIPT_PRELOAD,
    extraEnvForDir: () => ({
      PASSKEY_ENROLLMENT_TOKEN_HASH: crypto
        .createHash('sha256')
        .update(enrollmentCode)
        .digest('hex'),
      PASSKEY_ENROLLMENT_EXPIRES_AT: String(Date.now() + 60_000),
    }),
  });

  const anonymous = await jsonResponse(await fetch(`${base}/api/v1/receipts`, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      'Idempotency-Key': 'anonymous-large-receipt',
    },
    body: largeReceiptJson('txn-anonymous-large'),
  }));
  assert.equal(anonymous.response.status, 413);
  assert.equal(anonymous.body.code, 'PAYLOAD_TOO_LARGE');

  const demo = await jsonResponse(await fetch(`${base}/api/v1/receipts`, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      'Idempotency-Key': 'demo-large-receipt',
      'X-Demo-Mode': '1',
    },
    body: largeReceiptJson('txn-demo-large'),
  }));
  assert.equal(demo.response.status, 413);
  assert.equal(demo.body.code, 'PAYLOAD_TOO_LARGE');

  const native = await jsonResponse(await fetch(`${base}/api/v1/receipts`, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      'Idempotency-Key': 'native-large-receipt',
      'X-Finance-Token': 'test-api-token',
    },
    body: largeReceiptJson('txn-native-large'),
  }));
  assert.equal(native.response.status, 200);

  const cookie = await authenticateBrowserSession(
    base,
    path.join(dir, 'sessions'),
    enrollmentCode,
  );
  const browser = await jsonResponse(await fetch(`${base}/api/receipts`, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      Cookie: cookie,
    },
    body: largeReceiptJson('txn-browser-large'),
  }));
  assert.equal(browser.response.status, 200);
});

test('origin and demo rate-limit checks run before receipt body parsing', async (t) => {
  const { base } = await startEphemeralDashboardServer(t, {
    tempPrefix: 'darkfinances-receipt-body-ordering-',
  });
  const malformedLargeBody = 'x'.repeat(DEFAULT_MAX_JSON_BYTES + 1);

  const wrongOrigin = await jsonResponse(await fetch(`${base}/api/v1/receipts`, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      'Idempotency-Key': 'wrong-origin-large-receipt',
      'X-Finance-Token': 'test-api-token',
      Origin: 'https://evil.example',
    },
    body: malformedLargeBody,
  }));
  assert.equal(wrongOrigin.response.status, 403);
  assert.equal(wrongOrigin.body.code, 'CORS_ORIGIN_REJECTED');

  const demoResponses = await Promise.all(Array.from({ length: 240 }, () => (
    fetch(`${base}/api/v1/ping`, { headers: { 'X-Demo-Mode': '1' } })
  )));
  assert.equal(demoResponses.every((response) => response.status === 200), true);
  await Promise.all(demoResponses.map((response) => response.arrayBuffer()));

  const rateLimited = await jsonResponse(await fetch(`${base}/api/v1/receipts`, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      'Idempotency-Key': 'rate-limited-large-receipt',
      'X-Demo-Mode': '1',
    },
    body: malformedLargeBody,
  }));
  assert.equal(rateLimited.response.status, 429);
  assert.equal(rateLimited.body.code, 'RATE_LIMITED');
});
