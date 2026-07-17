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
  assert.equal(parse(schemas.accountOverride, { id: 'account', name: 'Checking' }).name, 'Checking');
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
