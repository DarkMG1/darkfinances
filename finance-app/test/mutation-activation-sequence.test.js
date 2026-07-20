const test = require('node:test');
const assert = require('node:assert/strict');
const {
  nextMutationActivationSeq,
  resetMutationActivationSequence,
} = require('../src/lib/mutation-activation-sequence');
const {
  pickActiveMutationSource,
  pickMutationAnnounce,
} = require('../src/lib/mutation-banner-coordinator');

function outcome(kind) {
  return { kind, recoverable: true, summary: kind, announce: kind, action: { kind: 'retry_same_key', label: 'Retry' } };
}

function source(key, activitySeq, state, retry) {
  return {
    key,
    outcome: state.outcome,
    announce: state.announce,
    activitySeq,
    retry: retry || (() => { state.retries += 1; }),
  };
}

test('shared activation sequence is monotonic across sibling dispatches', () => {
  resetMutationActivationSequence();
  const confirmSeq = nextMutationActivationSeq();
  const retrySeq = nextMutationActivationSeq();
  const dismissSeq = nextMutationActivationSeq();
  assert.equal(confirmSeq, 1);
  assert.equal(retrySeq, 2);
  assert.equal(dismissSeq, 3);

  const confirm = { outcome: outcome('offline'), announce: 'confirm offline', retries: 0 };
  const dismiss = { outcome: null, announce: 'Dismiss succeeded.', retries: 0 };
  const picked = pickActiveMutationSource([
    source('confirm', confirmSeq, confirm),
    source('dismiss', dismissSeq, dismiss),
  ]);
  assert.equal(picked.activeKey, null);
  assert.equal(pickMutationAnnounce([
    source('confirm', confirmSeq, confirm),
    source('dismiss', dismissSeq, dismiss),
  ]), 'Dismiss succeeded.');
});

test('confirm retry seq 2 then dismiss first-use keeps dismiss authoritative', () => {
  resetMutationActivationSequence();
  const confirmFailSeq = nextMutationActivationSeq();
  const confirmRetrySeq = nextMutationActivationSeq();
  const dismissSeq = nextMutationActivationSeq();
  assert.ok(dismissSeq > confirmRetrySeq);

  const confirm = { outcome: outcome('offline'), announce: 'confirm offline', retries: 0 };
  const dismiss = { outcome: null, announce: 'Dismiss suggestion succeeded.', retries: 0 };
  const sources = [
    source('confirm', confirmRetrySeq, confirm),
    source('dismiss', dismissSeq, dismiss),
  ];
  assert.equal(pickActiveMutationSource(sources).activeKey, null);
  assert.equal(pickMutationAnnounce(sources), 'Dismiss suggestion succeeded.');
  assert.equal(confirmFailSeq, 1);
});

test('arbitrary 100:1 activation histories keep latest source authoritative', () => {
  resetMutationActivationSequence();
  const confirm = { outcome: outcome('offline'), announce: 'stale confirm', retries: 0 };
  const dismiss = { outcome: null, announce: 'fresh dismiss', retries: 0 };
  let confirmSeq = 0;
  for (let i = 0; i < 100; i += 1) confirmSeq = nextMutationActivationSeq();
  const dismissSeq = nextMutationActivationSeq();
  assert.equal(dismissSeq, 101);
  const picked = pickActiveMutationSource([
    source('confirm', confirmSeq, confirm),
    source('dismiss', dismissSeq, dismiss),
  ]);
  assert.equal(picked.activeKey, null);
  assert.equal(pickMutationAnnounce([
    source('confirm', confirmSeq, confirm),
    source('dismiss', dismissSeq, dismiss),
  ]), 'fresh dismiss');
});
