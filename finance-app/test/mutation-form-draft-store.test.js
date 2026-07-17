const test = require('node:test');
const assert = require('node:assert/strict');
const {
  clearMutationFormDraft,
  getMutationFormDraft,
  purgeMutationFormDrafts,
  setMutationFormDraft,
} = require('../src/lib/mutation-form-draft-store');

test('draft store is scoped and purged per profile', () => {
  setMutationFormDraft('scope-a', 'add-transaction', { amount: '12.00' });
  setMutationFormDraft('scope-b', 'add-transaction', { amount: '99.00' });
  assert.deepEqual(getMutationFormDraft('scope-a', 'add-transaction'), { amount: '12.00' });
  purgeMutationFormDrafts('scope-a');
  assert.equal(getMutationFormDraft('scope-a', 'add-transaction'), null);
  assert.deepEqual(getMutationFormDraft('scope-b', 'add-transaction'), { amount: '99.00' });
  clearMutationFormDraft('scope-b', 'add-transaction');
  assert.equal(getMutationFormDraft('scope-b', 'add-transaction'), null);
});

test('purge all clears every scope when scope omitted', () => {
  setMutationFormDraft('x', 'form', { a: 1 });
  setMutationFormDraft('y', 'form', { b: 2 });
  purgeMutationFormDrafts();
  assert.equal(getMutationFormDraft('x', 'form'), null);
  assert.equal(getMutationFormDraft('y', 'form'), null);
});
