const test = require('node:test');
const assert = require('node:assert/strict');
const {
  clearMutationFormDraft,
  getMutationFormDraft,
  purgeMutationFormDrafts,
  sanitizeDraftValues,
  setMutationFormDraft,
} = require('../src/lib/mutation-form-draft-store');

test('draft store is scoped by profile generation and purged per profile', () => {
  setMutationFormDraft('scope-a', 'add-transaction', { amount: '12.00' }, 1);
  setMutationFormDraft('scope-a', 'add-transaction', { amount: '99.00' }, 2);
  assert.deepEqual(getMutationFormDraft('scope-a', 'add-transaction', 1), { amount: '12.00' });
  assert.deepEqual(getMutationFormDraft('scope-a', 'add-transaction', 2), { amount: '99.00' });
  purgeMutationFormDrafts('scope-a');
  assert.equal(getMutationFormDraft('scope-a', 'add-transaction', 1), null);
  assert.equal(getMutationFormDraft('scope-a', 'add-transaction', 2), null);
});

test('draft store strips sensitive receipt and token fields', () => {
  const sanitized = sanitizeDraftValues({
    payee: 'Coffee',
    imageBase64: 'secret-payload',
    receiptId: 'r-1',
    token: 'abc',
  });
  assert.deepEqual(sanitized, { payee: 'Coffee' });
  setMutationFormDraft('scope-a', 'receipt-form', {
    notes: 'hello',
    imageBase64: 'abc',
  }, 3);
  assert.deepEqual(getMutationFormDraft('scope-a', 'receipt-form', 3), { notes: 'hello' });
});

test('purge all clears every scope when scope omitted', () => {
  setMutationFormDraft('x', 'form', { a: 1 }, 1);
  setMutationFormDraft('y', 'form', { b: 2 }, 1);
  purgeMutationFormDrafts();
  assert.equal(getMutationFormDraft('x', 'form', 1), null);
  assert.equal(getMutationFormDraft('y', 'form', 1), null);
  clearMutationFormDraft('demo', 'form', 0);
});
