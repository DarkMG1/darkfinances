const test = require('node:test');
const assert = require('node:assert/strict');
const { mapMutationApiError, mapClientValidationOutcome } = require('../src/lib/mutation-form-errors');
const { OUTCOME_UNKNOWN_MESSAGE } = require('../src/lib/request-operation-state');

function err(overrides) {
  return { error: overrides.message || 'failed', status: overrides.status, code: overrides.code, ...overrides };
}

test('validation maps contract issues to field errors', () => {
  const mapped = mapMutationApiError(err({
    status: 400,
    code: 'INVALID_REQUEST',
    message: 'Invalid transaction: amount invalid',
    issues: [{ path: 'amount', message: 'money value must use whole cents' }],
  }), { fieldOrder: ['amount'], mutationLabel: 'Add transaction' });
  assert.equal(mapped.kind, 'validation');
  assert.equal(mapped.recoverable, true);
  assert.equal(mapped.fieldErrors.amount, 'money value must use whole cents');
  assert.equal(mapped.firstField, 'amount');
  assert.match(mapped.summary, /highlighted fields/i);
});

test('offline is recoverable with retry same key action', () => {
  const mapped = mapMutationApiError({ name: 'TypeError', message: 'Network request failed' });
  assert.equal(mapped.kind, 'offline');
  assert.equal(mapped.action.kind, 'retry_same_key');
  assert.match(mapped.summary, /offline/i);
  assert.doesNotMatch(mapped.summary, /idempotency/i);
});

test('timeout retains recoverable retry semantics', () => {
  const mapped = mapMutationApiError(err({ status: 408, code: 'TIMEOUT', message: 'timed out' }));
  assert.equal(mapped.kind, 'timeout');
  assert.equal(mapped.retryable, true);
  assert.equal(mapped.action.label, 'Retry');
});

test('sync unknown and operation not found stay recoverable', () => {
  for (const code of ['OUTCOME_UNKNOWN', 'OPERATION_NOT_FOUND']) {
    const mapped = mapMutationApiError(err({
      status: 409,
      code,
      message: code === 'OUTCOME_UNKNOWN' ? OUTCOME_UNKNOWN_MESSAGE : 'missing',
    }));
    assert.equal(mapped.kind, 'sync_unknown');
    assert.equal(mapped.action.kind, 'retry_same_key');
  }
});

test('409 stale triggers refetch not retry label minting keys', () => {
  const mapped = mapMutationApiError(err({ status: 409, code: 'STALE_UPSTREAM_DATA', message: 'stale version' }));
  assert.equal(mapped.kind, 'conflict_stale');
  assert.equal(mapped.requiresRefetch, true);
  assert.equal(mapped.action.kind, 'refetch');
  assert.doesNotMatch(JSON.stringify(mapped), /idempotency key/i);
});

test('409 saga in progress is retryable with refetch', () => {
  const mapped = mapMutationApiError(err({ status: 409, code: 'TRANSACTION_REPLACEMENT_IN_PROGRESS', message: 'in progress' }));
  assert.equal(mapped.kind, 'conflict_saga');
  assert.equal(mapped.action.kind, 'retry_same_key');
});

test('429 admission overloaded mentions retry not new keys', () => {
  const mapped = mapMutationApiError(err({
    status: 429,
    code: 'ADMISSION_OVERLOADED',
    message: 'busy',
    requiresIdempotencyKeyReuse: true,
  }));
  assert.equal(mapped.kind, 'admission_retry');
  assert.match(mapped.summary, /Retry/i);
  assert.doesNotMatch(mapped.summary, /new key/i);
});

test('401 auth failure is recoverable without retry action', () => {
  const mapped = mapMutationApiError(err({ status: 401, code: 'UNAUTHENTICATED', message: 'session expired' }));
  assert.equal(mapped.kind, 'auth');
  assert.equal(mapped.action, null);
});

test('503 server unavailable is retryable', () => {
  const mapped = mapMutationApiError(err({ status: 503, code: 'ADMISSION_UNAVAILABLE', message: 'down' }));
  assert.equal(mapped.kind, 'server_unavailable');
  assert.equal(mapped.retryable, true);
});

test('terminal 4xx is not recoverable', () => {
  const mapped = mapMutationApiError(err({ status: 404, code: 'NOT_FOUND', message: 'missing' }));
  assert.equal(mapped.kind, 'terminal');
  assert.equal(mapped.recoverable, false);
});

test('client validation outcome focuses first invalid field', () => {
  const mapped = mapClientValidationOutcome({ amount: 'Required', date: 'Bad' }, ['amount', 'date']);
  assert.equal(mapped.kind, 'client_validation');
  assert.equal(mapped.firstField, 'amount');
});

test('profile lock maps to sync unknown retry guidance', () => {
  const mapped = mapMutationApiError(err({
    status: 409,
    code: 'UNRESOLVED_OPERATION_PROFILE_LOCK',
    message: 'blocked',
  }));
  assert.equal(mapped.kind, 'sync_unknown');
  assert.equal(mapped.action.kind, 'retry_same_key');
});
