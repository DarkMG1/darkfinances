const test = require('node:test');
const assert = require('node:assert/strict');
const {
  pickActiveMutationSource,
  retryActiveMutationSource,
  pickMutationAnnounce,
} = require('../src/lib/mutation-banner-coordinator');

function outcome(kind) {
  return { kind, recoverable: true, summary: kind, announce: kind, action: { kind: 'retry_same_key', label: 'Retry' } };
}

function source(key, state, retry) {
  return {
    key,
    outcome: state.outcome,
    announce: state.announce,
    activitySeq: state.activitySeq,
    retry: retry || (() => { state.retries += 1; }),
  };
}

test('retry dispatches only the source whose outcome is displayed', () => {
  const form = { outcome: null, retries: 0, activitySeq: 1 };
  const deleteAction = { outcome: outcome('offline'), retries: 0, activitySeq: 2 };
  const sources = [
    source('form', form),
    source('delete', deleteAction),
  ];

  const picked = pickActiveMutationSource(sources);
  assert.equal(picked.activeKey, 'delete');
  assert.equal(retryActiveMutationSource(sources, picked.activeKey), true);
  assert.equal(form.retries, 0);
  assert.equal(deleteAction.retries, 1);
});

test('success clears prior source so a later failure retries only the new action', () => {
  const form = { outcome: null, retries: 0, activitySeq: 1 };
  const deleteAction = { outcome: outcome('admission_retry'), retries: 0, activitySeq: 2 };
  const sources = [
    source('form', form),
    source('delete', deleteAction),
  ];

  const picked = pickActiveMutationSource(sources);
  assert.equal(picked.activeKey, 'delete');

  retryActiveMutationSource(sources, picked.activeKey);
  assert.equal(form.retries, 0);
  assert.equal(deleteAction.retries, 1);
});

test('later activation success suppresses earlier sibling error and announce', () => {
  const form = { outcome: outcome('offline'), announce: 'form offline', retries: 0, activitySeq: 1 };
  const deleteAction = { outcome: null, announce: 'Delete goal succeeded.', retries: 0, activitySeq: 2 };
  const sources = [source('form', form), source('delete', deleteAction)];
  const picked = pickActiveMutationSource(sources);
  assert.equal(picked.activeKey, null);
  assert.equal(picked.outcome, null);
  assert.equal(pickMutationAnnounce(sources), 'Delete goal succeeded.');
});

test('later activation with error beats earlier retained error', () => {
  const form = { outcome: outcome('validation'), announce: 'form validation', retries: 0, activitySeq: 1 };
  const deleteAction = { outcome: outcome('offline'), announce: 'offline', retries: 0, activitySeq: 2 };
  const sources = [source('form', form), source('delete', deleteAction)];
  const picked = pickActiveMutationSource(sources);
  assert.equal(picked.activeKey, 'delete');
  retryActiveMutationSource(sources, picked.activeKey);
  assert.equal(form.retries, 0);
  assert.equal(deleteAction.retries, 1);
});

test('all pair combinations retry only the failing source after the other succeeded', () => {
  const keys = ['form', 'delete'];
  for (const failKey of keys) {
    const states = {
      form: { outcome: null, retries: 0, activitySeq: 1 },
      delete: { outcome: null, retries: 0, activitySeq: 2 },
    };
    states[failKey].outcome = outcome('offline');
    states[failKey].activitySeq = failKey === 'form' ? 3 : 4;
    const sources = keys.map((key) => source(key, states[key]));
    const picked = pickActiveMutationSource(sources);
    assert.equal(picked.activeKey, failKey, `${failKey} fail while other succeeded`);
    retryActiveMutationSource(sources, picked.activeKey);
    assert.equal(states[keys.find((k) => k !== failKey)].retries, 0);
    assert.equal(states[failKey].retries, 1);
    states[failKey].retries = 0;
  }
});

test('triple-action screen retries only the displayed failure', () => {
  const states = {
    add: { outcome: null, retries: 0, activitySeq: 1 },
    delete: { outcome: null, retries: 0, activitySeq: 2 },
    apply: { outcome: outcome('server_unavailable'), retries: 0, activitySeq: 3 },
  };
  const sources = ['add', 'delete', 'apply'].map((key) => source(key, states[key]));
  const picked = pickActiveMutationSource(sources);
  assert.equal(picked.activeKey, 'apply');
  retryActiveMutationSource(sources, picked.activeKey);
  assert.deepEqual([states.add.retries, states.delete.retries, states.apply.retries], [0, 0, 1]);
});

test('reconcile-style pair retries close-month failure without replaying item toggle', () => {
  const toggle = { outcome: null, retries: 0, activitySeq: 1 };
  const close = { outcome: outcome('admission_retry'), retries: 0, activitySeq: 2 };
  const sources = [source('toggle', toggle), source('close', close)];
  const picked = pickActiveMutationSource(sources);
  assert.equal(picked.activeKey, 'close');
  retryActiveMutationSource(sources, picked.activeKey);
  assert.equal(toggle.retries, 0);
  assert.equal(close.retries, 1);
});

test('split pair retries unsplit failure without replaying save split', () => {
  const split = { outcome: null, retries: 0, activitySeq: 1 };
  const unsplit = { outcome: outcome('offline'), retries: 0, activitySeq: 2 };
  const sources = [source('split', split), source('unsplit', unsplit)];
  const picked = pickActiveMutationSource(sources);
  assert.equal(picked.activeKey, 'unsplit');
  retryActiveMutationSource(sources, picked.activeKey);
  assert.equal(split.retries, 0);
  assert.equal(unsplit.retries, 1);
});

test('when two actions both have outcomes the later activity owns the banner', () => {
  const form = { outcome: outcome('validation'), retries: 0, activitySeq: 1 };
  const deleteAction = { outcome: outcome('offline'), retries: 0, activitySeq: 2 };
  const sources = [source('form', form), source('delete', deleteAction)];
  const picked = pickActiveMutationSource(sources);
  assert.equal(picked.activeKey, 'delete');
  retryActiveMutationSource(sources, picked.activeKey);
  assert.equal(form.retries, 0);
  assert.equal(deleteAction.retries, 1);
});

test('reimbursement pair retries dismiss failure without replaying confirm', () => {
  const confirm = { outcome: null, retries: 0, activitySeq: 1 };
  const dismiss = { outcome: outcome('offline'), retries: 0, activitySeq: 2 };
  const sources = [source('confirm', confirm), source('dismiss', dismiss)];
  const picked = pickActiveMutationSource(sources);
  assert.equal(picked.activeKey, 'dismiss');
  retryActiveMutationSource(sources, picked.activeKey);
  assert.equal(confirm.retries, 0);
  assert.equal(dismiss.retries, 1);
});

test('429 and offline failures retry only the failing action for every pair combination', () => {
  const keys = ['form', 'delete'];
  for (const failKind of ['offline', 'admission_retry']) {
    for (const failKey of keys) {
      const states = {
        form: { outcome: null, retries: 0, lastVars: null, activitySeq: 1 },
        delete: { outcome: null, retries: 0, lastVars: null, activitySeq: 2 },
      };
      states[failKey].outcome = outcome(failKind);
      states[failKey].lastVars = { id: failKey };
      states[failKey].activitySeq = failKey === 'form' ? 3 : 4;
      const sources = keys.map((key) => ({
        key,
        outcome: states[key].outcome,
        activitySeq: states[key].activitySeq,
        retry: () => {
          states[key].retries += 1;
          assert.equal(states[key].lastVars?.id, key, `${key} retry must reuse its own variables`);
        },
      }));
      const picked = pickActiveMutationSource(sources);
      assert.equal(picked.activeKey, failKey, `${failKind}: ${failKey} owns banner`);
      retryActiveMutationSource(sources, picked.activeKey);
      assert.equal(states[keys.find((k) => k !== failKey)].retries, 0);
      assert.equal(states[failKey].retries, 1);
    }
  }
});

test('rules triple retries only apply after add and delete succeeded', () => {
  const states = {
    add: { outcome: null, retries: 0, activitySeq: 1 },
    delete: { outcome: null, retries: 0, activitySeq: 2 },
    apply: { outcome: outcome('server_unavailable'), retries: 0, activitySeq: 3 },
  };
  const sources = ['add', 'delete', 'apply'].map((key) => source(key, states[key]));
  const picked = pickActiveMutationSource(sources);
  assert.equal(picked.activeKey, 'apply');
  retryActiveMutationSource(sources, picked.activeKey);
  assert.deepEqual([states.add.retries, states.delete.retries, states.apply.retries], [0, 0, 1]);
});
