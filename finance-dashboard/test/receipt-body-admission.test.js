'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const crypto = require('crypto');
const fs = require('fs');
const http = require('http');
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

const RECEIPT_GATE_PRELOAD = `
  const fs = require('fs');
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
        if (property === 'assertTransactionMutationAvailable') return () => {};
        if (property === 'validateReceiptUpload') return () => {};
        if (property === 'addReceipt') return (receipt) => ({ id: 'receipt-' + receipt.txnId });
        if (property === 'getTransactionById') {
          return async ({ id }) => {
            fs.appendFileSync(process.env.TEST_MARKER, 'receipt-start:' + id + '\\n');
            const release = process.env.TEST_MARKER + '.release';
            while (!fs.existsSync(release)) {
              await new Promise((resolve) => setTimeout(resolve, 5));
            }
            return { id };
          };
        }
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

function incompleteBodyResponse(base, pathname, {
  declaredBytes = DEFAULT_MAX_JSON_BYTES + 1,
  headers = {},
  method = 'POST',
  prefix = '{',
  timeoutMs = 2_000,
} = {}) {
  return new Promise((resolve, reject) => {
    const url = new URL(pathname, base);
    let settled = false;
    const request = http.request({
      hostname: url.hostname,
      port: url.port,
      path: `${url.pathname}${url.search}`,
      method,
      headers: {
        'Content-Length': String(declaredBytes),
        ...headers,
      },
    });
    const timer = setTimeout(() => {
      if (settled) return;
      settled = true;
      request.destroy();
      reject(new Error(`server did not respond before incomplete body buffering (${method} ${pathname})`));
    }, timeoutMs);
    request.on('response', (response) => {
      const chunks = [];
      response.on('data', (chunk) => chunks.push(chunk));
      response.on('end', () => {
        if (settled) return;
        settled = true;
        clearTimeout(timer);
        request.destroy();
        const text = Buffer.concat(chunks).toString('utf8');
        let body;
        try { body = JSON.parse(text); } catch (_) { body = text; }
        resolve({ response, body });
      });
    });
    request.on('error', (error) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      reject(error);
    });
    request.flushHeaders();
    if (prefix) request.write(prefix);
  });
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
  assert.equal(anonymous.response.status, 401);
  assert.equal(anonymous.body.code, 'UNAUTHENTICATED');

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

test('live API authentication, OPTIONS, and passkey rate checks precede body buffering', async (t) => {
  const { base } = await startEphemeralDashboardServer(t, {
    tempPrefix: 'darkfinances-pre-body-auth-rate-',
  });
  const declaredBytes = DEFAULT_MAX_JSON_BYTES + 1;
  assert.ok(declaredBytes < RECEIPT_MAX_JSON_BYTES);

  const anonymousV1 = await incompleteBodyResponse(base, '/api/v1/receipts', {
    declaredBytes,
    headers: {
      'Content-Type': 'application/json',
      'Idempotency-Key': 'anonymous-partial-receipt',
    },
  });
  assert.equal(anonymousV1.response.statusCode, 401);
  assert.equal(anonymousV1.body.code, 'UNAUTHENTICATED');

  const anonymousLegacy = await incompleteBodyResponse(base, '/api/receipts', {
    declaredBytes,
    headers: { 'Content-Type': 'application/json' },
  });
  assert.equal(anonymousLegacy.response.statusCode, 302);
  assert.equal(anonymousLegacy.response.headers.location, '/login');

  const options = await incompleteBodyResponse(base, '/api/v1/receipts', {
    declaredBytes,
    method: 'OPTIONS',
    prefix: '',
  });
  assert.equal(options.response.statusCode, 204);

  for (let attempt = 0; attempt < 10; attempt += 1) {
    const response = await fetch(`${base}/auth/enroll/authorize`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: '{}',
    });
    assert.equal(response.status, 403);
    await response.arrayBuffer();
  }
  const rateLimited = await incompleteBodyResponse(base, '/auth/enroll/authorize', {
    declaredBytes,
    headers: { 'Content-Type': 'application/json' },
  });
  assert.equal(rateLimited.response.statusCode, 429);
  assert.deepEqual(rateLimited.body, { error: 'Too many requests' });
});

test('authenticated large receipt buffering waits behind bounded pre-body admission', async (t) => {
  const { base, markerPath } = await startEphemeralDashboardServer(t, {
    tempPrefix: 'darkfinances-receipt-pre-body-gate-',
    preloadBody: RECEIPT_GATE_PRELOAD,
    extraEnv: {
      FINANCE_ADMISSION_MUTATION_GLOBAL_PENDING: '3',
      FINANCE_ADMISSION_MUTATION_GLOBAL_RUNNING: '1',
      FINANCE_ADMISSION_MUTATION_PRINCIPAL_PENDING: '1',
      FINANCE_ADMISSION_MUTATION_PRINCIPAL_RUNNING: '1',
      FINANCE_ADMISSION_CONTROL_RESERVE: '1',
      FINANCE_ADMISSION_RECOVERY_RESERVE: '1',
      FINANCE_ADMISSION_MAX_WAIT_MS: '50',
    },
  });
  const releasePath = `${markerPath}.release`;
  t.after(() => {
    try { fs.writeFileSync(releasePath, 'release'); } catch (_) {}
  });

  const png = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]);
  const first = fetch(`${base}/api/v1/receipts`, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      'Idempotency-Key': 'bounded-first-receipt',
      'X-Finance-Token': 'test-api-token',
    },
    body: JSON.stringify({
      txnId: 'txn-bounded-first',
      accountId: 'account-id',
      transactionDate: '2026-08-05',
      imageBase64: png.toString('base64'),
      mime: 'image/png',
      source: 'camera',
    }),
  }).then(jsonResponse);

  const deadline = Date.now() + 2_000;
  while (
    (!fs.existsSync(markerPath) || !fs.readFileSync(markerPath, 'utf8').includes('receipt-start:txn-bounded-first'))
    && Date.now() < deadline
  ) {
    await pollBackoff();
  }
  assert.ok(fs.existsSync(markerPath));
  assert.match(fs.readFileSync(markerPath, 'utf8'), /receipt-start:txn-bounded-first/);

  let overloaded;
  try {
    overloaded = await incompleteBodyResponse(base, '/api/v1/receipts', {
      declaredBytes: DEFAULT_MAX_JSON_BYTES + 1,
      headers: {
        'Content-Type': 'application/json',
        'Idempotency-Key': 'bounded-second-receipt',
        'X-Finance-Token': 'test-api-token',
      },
      timeoutMs: 2_000,
    });
  } finally {
    fs.writeFileSync(releasePath, 'release');
  }
  assert.equal(overloaded.response.statusCode, 429);
  assert.equal(overloaded.body.code, 'ADMISSION_OVERLOADED');
  assert.equal(overloaded.body.admission?.lane, 'mutation');

  const firstResult = await first;
  assert.equal(firstResult.response.status, 200);
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
