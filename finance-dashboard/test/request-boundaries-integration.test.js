const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const path = require('path');
const { RequestValidationError } = require('../lib/errors');
const { parse, schemas } = require('../lib/validation');
const {
  RECEIPT_MAX_BASE64_CHARS,
  RECEIPT_MAX_DECODED_BYTES,
  assertReceiptEncodedWithinLimits,
  exactBase64DecodedBytes,
  stripBase64Envelope,
} = require('../lib/receipt-limits');
const { PayloadTooLargeError } = require('../lib/bounded-json');
const { startEphemeralDashboardServer } = require('./helpers/ephemeral-dashboard-server');

const BOUNDARY_PRELOAD = `
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

async function postRaw(base, pathname, key, body) {
  const response = await fetch(`${base}${pathname}`, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      'Idempotency-Key': key,
      'X-Finance-Token': 'test-api-token',
    },
    body,
  });
  return { response, body: await response.json() };
}

test('encoded max uses 4 * ceil(decoded/3)', () => {
  assert.equal(RECEIPT_MAX_BASE64_CHARS, Math.ceil(RECEIPT_MAX_DECODED_BYTES / 3) * 4);
});

test('exact 25 MiB decoded payload passes encoded gate', () => {
  const exact = Buffer.alloc(RECEIPT_MAX_DECODED_BYTES, 0x41);
  const encoded = exact.toString('base64');
  assert.equal(encoded.length, RECEIPT_MAX_BASE64_CHARS);
  assert.equal(exactBase64DecodedBytes(encoded), RECEIPT_MAX_DECODED_BYTES);
  assert.doesNotThrow(() => assertReceiptEncodedWithinLimits(encoded));
});

test('+1 decoded byte rejects before dangerous write', () => {
  const over = Buffer.alloc(RECEIPT_MAX_DECODED_BYTES + 1, 0x41).toString('base64');
  assert.throws(() => assertReceiptEncodedWithinLimits(over), PayloadTooLargeError);
});

test('padding-aware decoded estimate handles mod-3 remainder classes', () => {
  for (const size of [1, 2, 3, 4, 5, 1024, 1025, 1026]) {
    const encoded = Buffer.alloc(size, 0x41).toString('base64');
    assert.equal(exactBase64DecodedBytes(encoded), size, `size ${size}`);
  }
});

test('data URI prefix is stripped consistently before size checks', () => {
  const payload = Buffer.from('hello').toString('base64');
  const withPrefix = `data:image/png;base64,${payload}`;
  assert.equal(stripBase64Envelope(withPrefix), payload);
  assert.doesNotThrow(() => assertReceiptEncodedWithinLimits(withPrefix));
  const over = Buffer.alloc(RECEIPT_MAX_DECODED_BYTES + 1).toString('base64');
  assert.throws(
    () => assertReceiptEncodedWithinLimits(`data:image/png;base64,${over}`),
    PayloadTooLargeError,
  );
});

test('real dataModule decodeImageBase64 enforces decoded boundary', () => {
  const dataModulePath = require.resolve('../dataModule.js');
  delete require.cache[dataModulePath];
  const data = require('../dataModule.js');
  const exact = Buffer.alloc(RECEIPT_MAX_DECODED_BYTES, 0x41);
  const encoded = exact.toString('base64');
  const decoded = data.decodeImageBase64(encoded);
  assert.equal(decoded.length, RECEIPT_MAX_DECODED_BYTES);
  const over = Buffer.alloc(RECEIPT_MAX_DECODED_BYTES + 1, 0x41).toString('base64');
  assert.throws(() => data.decodeImageBase64(over), /too large/i);
});

test('receipt schema strips data URI before length validation', () => {
  const exact = Buffer.alloc(RECEIPT_MAX_DECODED_BYTES).toString('base64');
  const withPrefix = `data:image/png;base64,${exact}`;
  const parsed = parse(schemas.receipt, {
    txnId: 't1',
    accountId: 'a1',
    transactionDate: '2026-07-09',
    imageBase64: withPrefix,
    mime: 'image/png',
  }, 'receipt');
  assert.equal(parsed.imageBase64, exact);
  const over = Buffer.alloc(RECEIPT_MAX_DECODED_BYTES + 1).toString('base64');
  assert.throws(
    () => parse(schemas.receipt, {
      txnId: 't1',
      accountId: 'a1',
      transactionDate: '2026-07-09',
      imageBase64: `data:image/png;base64,${over}`,
      mime: 'image/png',
    }, 'receipt'),
    RequestValidationError,
  );
});

test('real dataModule decodeImageBase64 accepts exact 25MiB data URI payload', () => {
  const dataModulePath = require.resolve('../dataModule.js');
  delete require.cache[dataModulePath];
  const data = require('../dataModule.js');
  const exact = Buffer.alloc(RECEIPT_MAX_DECODED_BYTES, 0x41);
  const encoded = exact.toString('base64');
  const withPrefix = `data:image/png;base64,${encoded}`;
  const decoded = data.decodeImageBase64(withPrefix);
  assert.equal(decoded.length, RECEIPT_MAX_DECODED_BYTES);
  const over = Buffer.alloc(RECEIPT_MAX_DECODED_BYTES + 1, 0x41).toString('base64');
  assert.throws(
    () => data.decodeImageBase64(`data:image/png;base64,${over}`),
    /too large/i,
  );
});

test('real dataModule money path rejects unknown owes-config fields', () => {
  assert.throws(
    () => parse(schemas.owesConfig, { expected: { trip: { alex: 100 } }, surprise: true }),
    RequestValidationError,
  );
});

test('pre-body admission preserves parser versus journaled validation boundaries', async (t) => {
  const { base, dir } = await startEphemeralDashboardServer(t, {
    tempPrefix: 'darkfinances-pre-body-validation-boundary-',
    preloadBody: BOUNDARY_PRELOAD,
  });
  const malformedKey = 'boundary-malformed-json';
  const validationKey = 'boundary-schema-invalid';

  const malformed = await postRaw(base, '/api/v1/budgets', malformedKey, '{');
  assert.equal(malformed.response.status, 400);
  assert.equal(malformed.body.code, 'INVALID_REQUEST');

  const invalidBody = JSON.stringify({
    month: 'not-a-month',
    categoryId: 'category-id',
    amount: 10,
  });
  const invalid = await postRaw(base, '/api/v1/budgets', validationKey, invalidBody);
  assert.equal(invalid.response.status, 400);
  assert.equal(invalid.body.code, 'INVALID_REQUEST');
  const replay = await postRaw(base, '/api/v1/budgets', validationKey, invalidBody);
  assert.equal(replay.response.status, 400);
  assert.equal(replay.body.code, 'INVALID_REQUEST');

  const healthResponse = await fetch(`${base}/api/v1/ping`, {
    headers: { 'X-Finance-Token': 'test-api-token' },
  });
  const health = await healthResponse.json();
  assert.equal(healthResponse.status, 200);
  assert.equal(health.data.requestAdmission.lanes.mutation.globalPending, 0);
  assert.equal(health.data.requestAdmission.lanes.mutation.globalRunning, 0);
  assert.equal(health.data.requestAdmission.lanes.mutation.waiters, 0);

  const journalPath = path.join(dir, 'operation-journal.json');
  const operations = JSON.parse(fs.readFileSync(journalPath, 'utf8')).operations;
  assert.equal(operations[malformedKey], undefined);
  assert.equal(operations[validationKey].status, 'failed');
  assert.equal(operations[validationKey].phase, 'failed');
  assert.equal(operations[validationKey].knownBeforeApply, true);
});
