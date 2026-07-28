'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const {
  AppError,
  GENERIC_INTERNAL_CODE,
  GENERIC_INTERNAL_MESSAGE,
  ImportedTransactionError,
  RequestValidationError,
  SplitLegDeleteError,
  SplitParentNotFoundError,
  TransactionNotFoundError,
  classifyError,
} = require('../lib/errors');
const { apiErrorBody } = require('../lib/request-envelope');
const { RuntimeStateError: RuntimeStoreError } = require('../lib/runtime-state-store');

const req = { requestId: 'req-test-001' };

function legacyEnvelope(error) {
  const classified = classifyError(error);
  return {
    error: classified.expose ? classified.message : 'Request failed',
    code: classified.code,
    requestId: req.requestId,
  };
}

function versionedEnvelope(error) {
  return apiErrorBody(error, req).body;
}

const LEAKY_MESSAGES = [
  'invalid SQL path /tmp/receipts',
  'required field accountId missing from payload',
  'SELECT * FROM accounts WHERE id invalid',
  'unsafe debtor pattern for alex',
  'transaction not found in ledger shard 7',
  'splitwise snapshot is stale since 2026-07-01',
  'Bank-imported transactions can’t be deleted — only ones you added manually.',
];

for (const [label, factory] of [
  ['Error', (message) => new Error(message)],
  ['RuntimeStateError', (message) => new RuntimeStoreError(message, { code: 'RUNTIME_STATE_INVALID_SHAPE' })],
  ['generic object', (message) => ({ message, code: 'SURPRISE' })],
]) {
  for (const message of LEAKY_MESSAGES) {
    test(`unknown ${label} does not expose "${message.slice(0, 24)}..."`, () => {
      const error = factory(message);
      const legacy = legacyEnvelope(error);
      const versioned = versionedEnvelope(error);
      for (const body of [legacy, versioned]) {
        assert.equal(body.error, 'Request failed');
        assert.equal(body.code, label === 'RuntimeStateError' ? 'RUNTIME_STATE_ERROR' : GENERIC_INTERNAL_CODE);
        assert.equal(String(JSON.stringify(body)).includes('invalid'), false, 'invalid leaked');
        assert.equal(String(JSON.stringify(body)).includes('required'), false, 'required leaked');
        assert.equal(String(JSON.stringify(body)).includes('SQL'), false, 'SQL leaked');
        assert.equal(String(JSON.stringify(body)).includes(message), false, 'raw message leaked');
      }
    });
  }
}

function envelopeBody(error) {
  return apiErrorBody(error, req).body;
}

test('explicit safe validation errors remain useful on both envelopes', () => {
  const error = new RequestValidationError('bounded invalid request', [{
    path: 'amount',
    message: 'money value must use whole cents',
  }]);
  const body = envelopeBody(error);
  assert.equal(body.code, 'INVALID_REQUEST');
  assert.equal(body.error, 'bounded invalid request');
  assert.ok(Array.isArray(body.issues));
  assert.equal(body.issues[0].path, 'amount');
});

test('explicit AppError messages pass through unchanged', () => {
  const error = new AppError('Account not found', {
    code: 'ACCOUNT_NOT_FOUND',
    status: 404,
    expose: true,
  });
  for (const body of [legacyEnvelope(error), versionedEnvelope(error)]) {
    assert.equal(body.code, 'ACCOUNT_NOT_FOUND');
    assert.equal(body.error, 'Account not found');
  }
});

test('explicit domain AppErrors preserve intentional client status and codes', () => {
  for (const [error, code, message, status] of [
    [new TransactionNotFoundError(), 'NOT_FOUND', 'Transaction not found', 404],
    [new ImportedTransactionError(), 'IMPORTED_TRANSACTION', 'Bank-imported transactions can\u2019t be deleted \u2014 only ones you added manually.', 409],
    [new SplitLegDeleteError(), 'INVALID_REQUEST', 'Split legs cannot be deleted independently', 400],
    [new SplitParentNotFoundError(), 'NOT_FOUND', 'Split parent not found', 404],
  ]) {
    const classified = classifyError(error);
    assert.equal(classified.status, status);
    assert.equal(classified.expose, true);
    for (const body of [legacyEnvelope(error), versionedEnvelope(error)]) {
      assert.equal(body.code, code);
      assert.equal(body.error, message);
    }
  }
});

test('unknown exceptions classify to generic internal message', () => {
  const classified = classifyError(new Error('surprise internal detail'));
  assert.equal(classified.message, GENERIC_INTERNAL_MESSAGE);
  assert.equal(classified.code, GENERIC_INTERNAL_CODE);
  assert.equal(classified.expose, false);
});

test('RuntimeStateError classifies to generic internal message', () => {
  const classified = classifyError(new RuntimeStoreError('passkey credentials file path is required', {
    code: 'RUNTIME_STATE_READ_FAILED',
  }));
  assert.equal(classified.message, GENERIC_INTERNAL_MESSAGE);
  assert.equal(classified.code, 'RUNTIME_STATE_ERROR');
  assert.equal(classified.expose, false);
});
