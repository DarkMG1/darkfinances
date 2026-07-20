const test = require('node:test');
const assert = require('node:assert/strict');
const crypto = require('crypto');
const fs = require('fs');
const path = require('path');
const {
  RECEIPT_MAX_BASE64_CHARS,
  RECEIPT_MAX_DECODED_BYTES,
  RECEIPT_MAX_JSON_BYTES,
  DEFAULT_MAX_JSON_BYTES,
} = require('../lib/receipt-limits');
const { startEphemeralDashboardServer } = require('./helpers/ephemeral-dashboard-server');

const REQUEST_CONTRACT_PRELOAD = `
    const fs = require('fs');
    const path = require('path');
    const root = process.env.TEST_DASHBOARD_ROOT;
    const dataPath = require.resolve(path.join(root, 'dataModule.js'));
    const mark = (value) => fs.appendFileSync(process.env.TEST_EFFECT_MARKER, value + '\\n');
    const mock = new Proxy({
      initApi: async () => ({ ok: true }),
      shutdownApi: async () => ({ ok: true }),
      getHealth: () => ({ ready: true }),
      getTransactionById: async ({ id }) => {
        mark('lookup:' + id);
        return { id };
      },
      setOwesConfig: async (config) => {
        mark('setOwes:' + Object.keys(config || {}).sort().join(','));
        return { ok: true };
      },
      addReceipt: async (receipt) => {
        mark('addReceipt:' + receipt.txnId);
        return { id: 'receipt-test', txnId: receipt.txnId, mime: receipt.mime };
      },
    }, {
      get(target, property) {
        if (property in target) return target[property];
        return async () => [];
      },
    });
    require.cache[dataPath] = {
      id: dataPath,
      filename: dataPath,
      loaded: true,
      exports: mock,
      children: [],
      paths: [],
    };
  `;

async function request(base, pathname, options = {}) {
  const response = await fetch(`${base}${pathname}`, options);
  const text = await response.text();
  let body;
  try { body = JSON.parse(text); } catch (_) { body = text; }
  return { response, body, text };
}

function mutationOptions(key, body, headers = {}) {
  return {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      'X-Finance-Token': 'test-api-token',
      'Idempotency-Key': key,
      ...headers,
    },
    body: JSON.stringify(body),
  };
}

function markerLines(file) {
  return fs.existsSync(file) ? fs.readFileSync(file, 'utf8').trim().split('\n').filter(Boolean) : [];
}

function pngBase64(payloadSize) {
  const payload = Buffer.alloc(Math.max(1, payloadSize), 0x41);
  const png = Buffer.concat([
    Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]),
    payload,
  ]);
  return png.toString('base64');
}

test('uniform request contract matrix for v1 and legacy surfaces', async (t) => {
  const { base, port, effectMarkerPath: marker } = await startEphemeralDashboardServer(t, {
    tempPrefix: 'darkfinances-request-contract-',
    preloadBody: REQUEST_CONTRACT_PRELOAD,
    extraEnvForDir: () => ({ SELFTEST: '1' }),
  });

  const matrix = [];

  const record = (name, result, expected) => {
    matrix.push({
      case: name,
      status: result.response.status,
      code: result.body?.code,
      contentType: result.response.headers.get('content-type'),
      requestId: result.body?.requestId,
      ...expected,
    });
  };

  let result = await request(base, '/api/v1/accounts');
  record('auth missing token', result, { expectStatus: 401, expectCode: 'UNAUTHENTICATED' });
  assert.equal(result.response.status, 401);
  assert.equal(result.body.code, 'UNAUTHENTICATED');
  assert.match(result.response.headers.get('content-type'), /application\/json/);
  assert.equal(typeof result.body.requestId, 'string');

  result = await request(base, '/api/v1/transactions', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', Origin: 'https://evil.example', 'X-Finance-Token': 'test-api-token' },
    body: '{}',
  });
  record('cors rejected write', result, { expectStatus: 403, expectCode: 'CORS_ORIGIN_REJECTED' });
  assert.equal(result.response.status, 403);
  assert.equal(result.body.code, 'CORS_ORIGIN_REJECTED');

  result = await request(base, '/api/v1/transactions', {
    method: 'OPTIONS',
    headers: { Origin: `${base.replace(/\/$/, '')}`, 'Access-Control-Request-Method': 'POST' },
  });
  record('cors preflight', result, { expectStatus: 204 });
  assert.equal(result.response.status, 204);

  result = await request(base, '/api/v1/not-a-real-write', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', 'X-Finance-Token': 'test-api-token', 'Idempotency-Key': 'missing-route-01' },
    body: '{}',
  });
  record('404 unknown route', result, { expectStatus: 404, expectCode: 'NOT_FOUND' });
  assert.equal(result.response.status, 404);
  assert.equal(result.body.code, 'NOT_FOUND');

  result = await request(base, '/api/v1/transactions', {
    method: 'PATCH',
    headers: { 'Content-Type': 'application/json', 'X-Finance-Token': 'test-api-token' },
    body: '{}',
  });
  record('405 method mismatch', result, { expectStatus: 405, expectCode: 'METHOD_NOT_ALLOWED' });
  assert.equal(result.response.status, 405);
  assert.equal(result.body.code, 'METHOD_NOT_ALLOWED');

  for (const body of ['{', '{"accountId":', 'not-json']) {
    result = await request(base, '/api/v1/reconciliation/enabled', {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'X-Finance-Token': 'test-api-token',
        'Idempotency-Key': `malformed-${body.length}`,
      },
      body,
    });
    assert.equal(result.response.status, 400, `malformed body ${JSON.stringify(body)}`);
    assert.equal(result.body.code, 'INVALID_REQUEST');
  }
  record('malformed json', result, { expectStatus: 400, expectCode: 'INVALID_REQUEST' });

  result = await request(base, '/api/v1/reconciliation/enabled', {
    method: 'POST',
    headers: {
      'Content-Type': 'text/plain',
      'X-Finance-Token': 'test-api-token',
      'Idempotency-Key': 'wrong-content-type-01',
    },
    body: '{"enabled":true}',
  });
  record('unsupported content type', result, { expectStatus: 415, expectCode: 'UNSUPPORTED_MEDIA_TYPE' });
  assert.equal(result.response.status, 415);
  assert.equal(result.body.code, 'UNSUPPORTED_MEDIA_TYPE');

  result = await request(base, '/api/v1/reconciliation/enabled', {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      'X-Finance-Token': 'test-api-token',
      'Idempotency-Key': 'unknown-field-01',
    },
    body: JSON.stringify({ enabled: true, surprise: true }),
  });
  record('unknown top-level field', result, { expectStatus: 400, expectCode: 'INVALID_REQUEST' });
  assert.equal(result.response.status, 400);
  assert.equal(result.body.code, 'INVALID_REQUEST');
  assert.equal(String(result.body.error).includes('surprise'), false);

  const invalidKey = 'setOwes-invalid-01';
  const invalidOwes = {
    expected: { trip: { alex: '734' } },
    debtorPatterns: { alex: 'alex' },
  };
  result = await request(base, '/api/v1/owes-config', mutationOptions(invalidKey, invalidOwes));
  record('setOwes malformed cents', result, { expectStatus: 400, expectCode: 'INVALID_REQUEST' });
  assert.equal(result.response.status, 400);
  assert.equal(result.body.code, 'INVALID_REQUEST');
  assert.ok(Array.isArray(result.body.issues));
  assert.equal(String(JSON.stringify(result.body)).includes('surprise'), false);
  assert.deepEqual(markerLines(marker), []);

  const replayOwes = await request(base, '/api/v1/owes-config', mutationOptions(invalidKey, invalidOwes));
  assert.equal(replayOwes.response.status, 400);
  assert.equal(replayOwes.body.code, 'INVALID_REQUEST');
  assert.equal(replayOwes.body.error, result.body.error);
  assert.deepEqual(replayOwes.body.issues, result.body.issues);
  assert.deepEqual(markerLines(marker), []);

  result = await request(base, `/api/v1/operations/${invalidKey}`, {
    headers: { 'X-Finance-Token': 'test-api-token' },
  });
  assert.equal(result.body.data.status, 'failed');
  assert.equal(result.body.data.phase, 'failed');
  assert.equal(result.body.data.outcome, 'failed');
  assert.deepEqual(result.body.data.error?.issues, replayOwes.body.issues);

  const validKey = 'setOwes-valid-01';
  result = await request(base, '/api/v1/owes-config', mutationOptions(validKey, {
    expected: { trip: { alex: 734 } },
    debtorPatterns: { alex: 'alex' },
  }));
  record('setOwes valid', result, { expectStatus: 200 });
  assert.equal(result.response.status, 200);
  assert.deepEqual(markerLines(marker), ['setOwes:debtorPatterns,expected']);

  const bodyLimitKey = 'body-limit-01';
  result = await request(base, '/api/v1/reconciliation/enabled', {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      'X-Finance-Token': 'test-api-token',
      'Idempotency-Key': bodyLimitKey,
    },
    body: JSON.stringify({ enabled: true, padding: 'x'.repeat(DEFAULT_MAX_JSON_BYTES) }),
  });
  record('413 default json limit', result, { expectStatus: 413, expectCode: 'PAYLOAD_TOO_LARGE' });
  assert.equal(result.response.status, 413);
  assert.equal(result.body.code, 'PAYLOAD_TOO_LARGE');

  const boundaryEncoded = Buffer.alloc(RECEIPT_MAX_DECODED_BYTES).toString('base64');
  assert.equal(boundaryEncoded.length, RECEIPT_MAX_BASE64_CHARS);
  const boundaryReceipt = {
    txnId: 'txn-boundary',
    accountId: 'account-id',
    transactionDate: '2026-07-13',
    imageBase64: boundaryEncoded,
    mime: 'image/png',
    source: 'camera',
  };
  const overReceipt = {
    ...boundaryReceipt,
    imageBase64: Buffer.alloc(RECEIPT_MAX_DECODED_BYTES + 1).toString('base64'),
  };
  result = await request(base, '/api/v1/receipts', mutationOptions('receipt-over-01', overReceipt));
  record('413 receipt encoded +1', result, { expectStatus: 413, expectCode: 'PAYLOAD_TOO_LARGE' });
  assert.equal(result.response.status, 413);
  assert.equal(result.body.code, 'PAYLOAD_TOO_LARGE');
  assert.deepEqual(markerLines(marker), ['setOwes:debtorPatterns,expected']);

  const decodedPayload = pngBase64(RECEIPT_MAX_DECODED_BYTES - 16);
  result = await request(base, '/api/v1/receipts', mutationOptions('receipt-boundary-01', {
    ...boundaryReceipt,
    imageBase64: boundaryEncoded,
  }));
  record('receipt exact 25MiB accepted', result, { expectStatus: 200 });
  assert.equal(result.response.status, 200);
  assert.match(markerLines(marker).join('\n'), /addReceipt:txn-boundary/);

  result = await request(base, '/api/v1/receipts', mutationOptions('receipt-encoded-over-01', overReceipt));
  record('413 receipt decoded +1', result, { expectStatus: 413, expectCode: 'PAYLOAD_TOO_LARGE' });
  assert.equal(result.response.status, 413);

  const legacyRefreshReject = await request(base, '/api/refresh?surprise=1', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', Cookie: '' },
  });
  record('legacy refresh rejects query', legacyRefreshReject, { expectStatus: 400, expectCode: 'INVALID_REQUEST' });

  const legacyBankSyncBody = await request(base, '/api/bank-sync', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ surprise: true }),
  });
  record('legacy bank-sync rejects body', legacyBankSyncBody, { expectStatus: 400, expectCode: 'INVALID_REQUEST' });

  t.diagnostic(JSON.stringify({
    receiptExact25MiB: {
      decodedBytes: RECEIPT_MAX_DECODED_BYTES,
      encodedChars: RECEIPT_MAX_BASE64_CHARS,
      formula: '4 * ceil(decoded/3)',
      boundaryEncodedLength: boundaryEncoded.length,
      overDecodedBytes: RECEIPT_MAX_DECODED_BYTES + 1,
    },
  }, null, 2));

  assert.ok(RECEIPT_MAX_JSON_BYTES > RECEIPT_MAX_BASE64_CHARS);

  const beforeDemo = markerLines(marker).length;
  result = await request(base, '/api/v1/budgets', {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      'X-Demo-Mode': '1',
      'Idempotency-Key': 'demo-unknown-field-01',
    },
    body: JSON.stringify({ categoryId: 'food', amount: 12.34, extra: true }),
  });
  record('demo v1 unknown field before handler', result, { expectStatus: 400, expectCode: 'INVALID_REQUEST' });
  assert.equal(result.response.status, 400);
  assert.equal(result.body.code, 'INVALID_REQUEST');
  assert.equal(markerLines(marker).length, beforeDemo);

  for (const entry of matrix) {
    if (entry.expectStatus != null) assert.equal(entry.status, entry.expectStatus, entry.case);
    if (entry.expectCode != null) assert.equal(entry.code, entry.expectCode, entry.case);
    if (entry.status >= 400) {
      assert.match(entry.contentType, /application\/json/, `${entry.case} content-type`);
      assert.equal(typeof entry.requestId, 'string', `${entry.case} requestId`);
    }
  }

  t.diagnostic(JSON.stringify(matrix, null, 2));
});
