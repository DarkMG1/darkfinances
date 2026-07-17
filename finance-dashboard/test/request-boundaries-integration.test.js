const test = require('node:test');
const assert = require('node:assert/strict');
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
