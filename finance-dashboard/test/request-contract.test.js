const test = require('node:test');
const assert = require('node:assert/strict');
const { RequestValidationError } = require('../lib/errors');
const { PayloadTooLargeError } = require('../lib/bounded-json');
const { parse, schemas } = require('../lib/validation');
const {
  assertReceiptEncodedWithinLimits,
  validateLegacyMutationRequest,
} = require('../lib/request-contract');
const {
  RECEIPT_MAX_BASE64_CHARS,
  RECEIPT_MAX_DECODED_BYTES,
  exactBase64DecodedBytes,
} = require('../lib/receipt-limits');

test('owesConfig rejects unknown top-level and nested fields', () => {
  assert.throws(
    () => parse(schemas.owesConfig, { expected: { trip: { alex: 100 } }, surprise: true }),
    RequestValidationError,
  );
  assert.throws(
    () => parse(schemas.owesConfig, {
      manualTrips: { alex: [{ event: 'trip', amount: 1, extra: true }] },
    }),
    RequestValidationError,
  );
  assert.doesNotThrow(() => parse(schemas.owesConfig, {
    expected: { trip: { alex: 100 } },
    debtorPatterns: { alex: 'alex' },
    tripStart: { trip: '2026-06-01' },
    swNet: [],
    settledExt: [],
    autoReimbTags: ['roommate'],
    eventStatus: { trip: 'open' },
    autoDetectExcludeEvents: [],
    manualTrips: { alex: [{ event: 'trip', amount: 12.34 }] },
  }));
});

test('receipt schema rejects invalid mime and base64 before decode allocation', () => {
  assert.throws(
    () => parse(schemas.receipt, {
      txnId: 't1',
      accountId: 'a1',
      transactionDate: '2026-07-09',
      imageBase64: 'not!!!base64',
      mime: 'image/png',
    }),
    RequestValidationError,
  );
  const oversized = 'A'.repeat(RECEIPT_MAX_BASE64_CHARS + 1);
  assert.throws(
    () => assertReceiptEncodedWithinLimits(oversized),
    PayloadTooLargeError,
  );
  const boundary = Buffer.alloc(RECEIPT_MAX_DECODED_BYTES).toString('base64');
  assert.equal(boundary.length, RECEIPT_MAX_BASE64_CHARS);
  assert.doesNotThrow(() => assertReceiptEncodedWithinLimits(boundary));
  assert.throws(
    () => assertReceiptEncodedWithinLimits(Buffer.alloc(RECEIPT_MAX_DECODED_BYTES + 1).toString('base64')),
    PayloadTooLargeError,
  );
});

test('legacy mutation contract validates receipts without echoing raw bytes in errors', () => {
  const secret = 'A'.repeat(64);
  const req = {
    method: 'POST',
    path: '/api/receipts',
    params: {},
    query: {},
    body: {
      txnId: 't1',
      accountId: 'a1',
      transactionDate: '2026-07-09',
      imageBase64: secret,
      mime: 'text/html',
    },
  };
  assert.throws(() => validateLegacyMutationRequest(req), RequestValidationError);
  try {
    validateLegacyMutationRequest(req);
  } catch (error) {
    assert.match(error.message, /receipt/i);
    assert.equal(String(error.message).includes(secret), false);
    assert.ok(Array.isArray(error.issues));
    for (const issue of error.issues) {
      assert.equal(String(issue.message).includes(secret), false);
    }
  }
});

test('legacy refresh rejects unexpected query parameters', () => {
  const req = {
    method: 'POST',
    path: '/api/refresh',
    params: {},
    query: { surprise: '1' },
    body: {},
  };
  assert.throws(() => validateLegacyMutationRequest(req), RequestValidationError);
});

test('confirm repayment binds from/to query dates', () => {
  assert.doesNotThrow(() => validateLegacyMutationRequest({
    method: 'POST',
    path: '/api/repayments/r1/confirm',
    params: { id: 'r1' },
    query: { from: '2026-06-01', to: '2026-06-30' },
    body: { id: 'r1' },
  }));
  assert.throws(() => validateLegacyMutationRequest({
    method: 'POST',
    path: '/api/repayments/r1/confirm',
    params: { id: 'r1' },
    query: { from: 'not-a-date' },
    body: {},
  }), RequestValidationError);
});

test('delete transaction accepts mobile query+body surfaces', () => {
  assert.doesNotThrow(() => validateLegacyMutationRequest({
    method: 'DELETE',
    path: '/api/transactions/txn-1',
    params: { id: 'txn-1' },
    query: { accountId: 'acct-1', date: '2026-07-09' },
    body: { id: 'txn-1', accountId: 'acct-1', date: '2026-07-09' },
  }));
  assert.throws(() => validateLegacyMutationRequest({
    method: 'DELETE',
    path: '/api/transactions/txn-1',
    params: { id: 'txn-1' },
    query: { accountId: 'acct-1', date: '2026-07-09' },
    body: { id: 'txn-1', accountId: 'acct-1', date: '2026-07-09', extra: true },
  }), RequestValidationError);
});

test('phantom cleanup rejects non-empty body as query-only mutation', () => {
  const { parsePhantomCleanupRequest } = require('../lib/request-contract');
  assert.doesNotThrow(() => parsePhantomCleanupRequest({
    method: 'POST',
    path: '/api/v1/phantom/cleanup',
    params: {},
    query: { dryRun: '1' },
    body: {},
  }));
  assert.throws(() => parsePhantomCleanupRequest({
    method: 'POST',
    path: '/api/v1/phantom/cleanup',
    params: {},
    query: { dryRun: '1' },
    body: { surprise: true },
  }), RequestValidationError);
});

test('no-payload mutations reject unexpected query parameters', () => {
  const { validateMutationRequest } = require('../lib/request-contract');
  for (const path of ['/api/v1/bank-sync', '/api/v1/rules/apply', '/api/v1/splitwise/sync-shares', '/api/v1/refresh']) {
    assert.throws(() => validateMutationRequest({
      method: 'POST',
      path,
      params: {},
      query: { surprise: '1' },
      body: {},
    }), RequestValidationError, path);
  }
});

test('recurring mark uses identical validation labels in contract and handler', () => {
  const { validateMutationRequest } = require('../lib/request-contract');
  const bad = { payee: 'Netflix', surprise: true };
  let contractError;
  assert.throws(
    () => validateMutationRequest({
      method: 'POST',
      path: '/api/v1/recurring/mark',
      params: {},
      query: {},
      body: bad,
    }),
    (error) => {
      contractError = error;
      return error instanceof RequestValidationError;
    },
  );
  let handlerError;
  assert.throws(
    () => parse(schemas.markRecurring, bad, 'recurring mark'),
    (error) => {
      handlerError = error;
      return error instanceof RequestValidationError;
    },
  );
  assert.match(contractError.message, /recurring mark/i);
  assert.equal(contractError.message, handlerError.message);
});

test('recurring override uses identical validation labels in contract and handler', () => {
  const { parseRecurringOverrideRequest, validateMutationRequest } = require('../lib/request-contract');
  const bad = { status: 'active', surprise: true };
  let contractError;
  assert.throws(
    () => validateMutationRequest({
      method: 'POST',
      path: '/api/v1/recurring/netflix-monthly/override',
      params: { key: 'netflix-monthly' },
      query: {},
      body: bad,
    }),
    (error) => {
      contractError = error;
      return error instanceof RequestValidationError;
    },
  );
  let handlerError;
  assert.throws(
    () => parseRecurringOverrideRequest({
      method: 'POST',
      path: '/api/v1/recurring/netflix-monthly/override',
      params: { key: 'netflix-monthly' },
      query: {},
      body: bad,
    }),
    (error) => {
      handlerError = error;
      return error instanceof RequestValidationError;
    },
  );
  assert.match(contractError.message, /recurring override/i);
  assert.equal(contractError.message, handlerError.message);
});

test('params-only delete routes reject unexpected query parameters', () => {
  const { validateMutationRequest } = require('../lib/request-contract');
  const cases = [
    { path: '/api/v1/receipts/receipt-1', params: { id: 'receipt-1' } },
    { path: '/api/v1/rules/rule-1', params: { id: 'rule-1' } },
    { path: '/api/v1/events/trip-2026', params: { slug: 'trip-2026' } },
    { path: '/api/v1/goals/goal-1', params: { id: 'goal-1' } },
    { path: '/api/v1/manual-assets/asset-1', params: { id: 'asset-1' } },
  ];
  for (const entry of cases) {
    assert.throws(() => validateMutationRequest({
      method: 'DELETE',
      path: entry.path,
      params: entry.params,
      query: { surprise: '1' },
      body: {},
    }), RequestValidationError, entry.path);
  }
});

test('exact base64 decoded bytes handles padding', () => {
  assert.equal(exactBase64DecodedBytes('YQ=='), 1);
  assert.equal(exactBase64DecodedBytes('YWI='), 2);
  assert.equal(exactBase64DecodedBytes('YWFh'), 3);
});
