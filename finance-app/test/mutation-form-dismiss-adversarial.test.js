const test = require('node:test');
const assert = require('node:assert/strict');
const {
  nextDismissRequest,
  shouldApplyFormDismiss,
} = require('../src/lib/mutation-form-dismiss');

test('stale discard alert no-ops when identity changed before confirm', () => {
  const seqRef = { value: 0 };
  const identityAtRequest = 'demo:0:budget-cat-1';
  const nonce = nextDismissRequest(seqRef);
  const currentIdentity = 'demo:0:budget-cat-2';
  assert.equal(
    shouldApplyFormDismiss({ identity: identityAtRequest, nonce }, currentIdentity, seqRef),
    false,
  );
});

test('superseded discard request no-ops when newer dismiss opened', () => {
  const seqRef = { value: 0 };
  const identity = 'demo:0:goals-new';
  const staleNonce = nextDismissRequest(seqRef);
  nextDismissRequest(seqRef);
  assert.equal(shouldApplyFormDismiss({ identity, nonce: staleNonce }, identity, seqRef), false);
  assert.equal(shouldApplyFormDismiss({ identity, nonce: seqRef.value }, identity, seqRef), true);
});

test('identity bump invalidates in-flight discard token', () => {
  const seqRef = { value: 0 };
  const identityA = 'demo:0:form-a';
  const nonce = nextDismissRequest(seqRef);
  seqRef.value += 1;
  assert.equal(shouldApplyFormDismiss({ identity: identityA, nonce }, identityA, seqRef), false);
});
