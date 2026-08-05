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
const {
  apiErrorBody,
  redactSensitiveErrorText,
  sendApiError,
} = require('../lib/request-envelope');
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

test('5xx diagnostics redact credentials before logging and stay generic for clients', () => {
  const sensitive = 'sensitive-value';
  const error = new Error(
    `Bearer ${sensitive} Authorization: Basic ${sensitive} `
    + `password=${sensitive} token=${sensitive} https://user:${sensitive}@example.test/private`,
  );
  const response = {
    headersSent: false,
    writableEnded: false,
    statusCode: null,
    body: null,
    status(statusCode) {
      this.statusCode = statusCode;
      return this;
    },
    json(body) {
      this.body = body;
      return this;
    },
  };
  const logged = [];
  const originalConsoleError = console.error;
  console.error = (...values) => logged.push(values.join(' '));
  try {
    sendApiError(req, response, error);
  } finally {
    console.error = originalConsoleError;
  }

  assert.equal(response.statusCode, 500);
  assert.equal(response.body.error, 'Request failed');
  assert.equal(response.body.code, GENERIC_INTERNAL_CODE);
  assert.equal(logged.length, 1);
  assert.doesNotMatch(logged[0], new RegExp(sensitive));
  assert.match(logged[0], /Bearer \[redacted\]/);
  assert.match(logged[0], /Authorization:\s*\[redacted\]/);
  assert.match(logged[0], /password=\[redacted\]/);
  assert.match(logged[0], /token=\[redacted\]/);
  assert.match(logged[0], /https:\/\/\[redacted\]@example\.test/);
});

test('redacted diagnostics are length bounded', () => {
  const redacted = redactSensitiveErrorText(`token=sensitive-value ${'x'.repeat(10_000)}`);
  assert.equal(redacted.length, 4_096);
  assert.doesNotMatch(redacted, /sensitive-value/);
});
