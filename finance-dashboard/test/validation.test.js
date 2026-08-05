const test = require('node:test');
const assert = require('node:assert/strict');
const { RequestValidationError } = require('../lib/errors');
const { parse, schemas, validDateOnly } = require('../lib/validation');

test('date-only validation rejects impossible and timezone-bearing dates', () => {
  assert.equal(validDateOnly('2026-02-28'), true);
  assert.equal(validDateOnly('2026-02-30'), false);
  assert.equal(validDateOnly('2026-07-09T00:00:00Z'), false);
});

test('transaction creation rejects unknown fields and zero amounts', () => {
  assert.throws(
    () => parse(schemas.createTransaction, { accountId: 'a1', amount: 0 }),
    RequestValidationError
  );
  assert.throws(
    () => parse(schemas.createTransaction, { accountId: 'a1', amount: -12, surprise: true }),
    RequestValidationError
  );
});

test('owesConfig rejects unknown fields', () => {
  assert.throws(
    () => parse(schemas.owesConfig, { expected: { trip: { alex: 100 } }, extra: true }),
    RequestValidationError,
  );
});

test('split validation bounds legs and accepts exact signed values', () => {
  const value = parse(schemas.splitTransaction, {
    id: 'txn-from-endpoint-builder',
    accountId: 'a1',
    date: '2026-07-09',
    legs: [
      { amount: -5, categoryId: 'c1' },
      { amount: -7.34, categoryId: 'c2', notes: 'share' },
    ],
  });
  assert.equal(value.legs.length, 2);
  assert.throws(
    () => parse(schemas.splitTransaction, { accountId: 'a1', date: '2026-07-09', legs: [{ amount: -1 }] }),
    RequestValidationError
  );
});

test('path identifiers included by the native mutation client remain compatible', () => {
  assert.equal(parse(schemas.recurringOverride, { key: 'merchant', hidden: true }).hidden, true);
  assert.equal(parse(schemas.recurringOverride, {
    forced: true,
    isBill: true,
    categoryId: 'loan-payment',
  }).categoryId, 'loan-payment');
  assert.equal(parse(schemas.accountOverride, { id: 'account', name: 'Checking' }).name, 'Checking');
  assert.deepEqual(parse(schemas.accountOverride, {
    creditLiabilityCoverage: 'statement',
    paymentRecurringKey: 'card-pay',
    statement: {
      balanceCents: -10000,
      paymentDueDate: '2026-08-01',
      observedAt: '2026-07-01T00:00:00.000Z',
    },
  }).paymentRecurringKey, 'card-pay');
  assert.equal(parse(schemas.setCategory, {
    id: 'txn',
    categoryId: 'category',
    isLeg: false,
    accountId: 'account',
    date: '2026-07-09',
  }).categoryId, 'category');
});

test('destructive transaction requests require an account and real date', () => {
  assert.throws(() => parse(schemas.deleteTransactionQuery, {}), RequestValidationError);
  assert.throws(
    () => parse(schemas.deleteTransactionQuery, { accountId: 'a1', date: '2026-13-01' }),
    RequestValidationError
  );
  assert.deepEqual(
    parse(schemas.deleteTransactionQuery, { accountId: 'a1', date: '2026-07-09' }),
    { accountId: 'a1', date: '2026-07-09' }
  );
});

test('receipt validation permits only bounded raster image types', () => {
  assert.throws(
    () => parse(schemas.receipt, { txnId: 't1', accountId: 'a1', transactionDate: '2026-07-09', imageBase64: 'abc', mime: 'text/html' }),
    RequestValidationError
  );
  const value = parse(schemas.receipt, {
    txnId: 't1',
    accountId: 'a1',
    transactionDate: '2026-07-09',
    imageBase64: 'abc',
    mime: 'image/jpeg',
    source: 'camera',
  });
  assert.equal(value.mime, 'image/jpeg');
});

test('bounded list queries coerce supported pagination and OCR values', () => {
  assert.deepEqual(
    parse(schemas.receiptsListQuery, {
      txnId: 'txn-1',
      limit: '10',
      offset: '20',
      includeOcr: 'true',
    }),
    { txnId: 'txn-1', limit: 10, offset: 20, includeOcr: true },
  );
  assert.deepEqual(
    parse(schemas.eventsListQuery, { limit: '100', offset: '0' }),
    { limit: 100, offset: 0 },
  );
  assert.deepEqual(
    parse(schemas.rulesListQuery, { limit: 1, offset: 1_000_000 }),
    { limit: 1, offset: 1_000_000 },
  );
  assert.equal(
    parse(schemas.receiptsListQuery, { includeOcr: 'false' }).includeOcr,
    false,
  );
});

test('bounded list queries reject oversized, negative, malformed, and unknown values', () => {
  for (const [schema, value] of [
    [schemas.receiptsListQuery, { limit: '101' }],
    [schemas.eventsListQuery, { limit: '0' }],
    [schemas.rulesListQuery, { offset: '-1' }],
    [schemas.rulesListQuery, { offset: '1000001' }],
    [schemas.eventsListQuery, { limit: '1.5' }],
    [schemas.receiptsListQuery, { includeOcr: 'yes' }],
    [schemas.eventsListQuery, { unknown: '1' }],
  ]) {
    assert.throws(() => parse(schema, value), RequestValidationError);
  }
});
