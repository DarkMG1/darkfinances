const test = require('node:test');
const assert = require('node:assert/strict');
const {
  clearMutationFormDraft,
  getMutationFormDraft,
  purgeMutationFormDrafts,
  sanitizeDraftValues,
  setMutationFormDraft,
  MAX_DRAFTS_PER_SCOPE,
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

test('sanitize recursively strips nested sensitive keys and base64-like values', () => {
  const sanitized = sanitizeDraftValues({
    payee: 'Coffee',
    meta: {
      receipt: { image: 'abc' },
      note: 'ok',
    },
    payload: 'data:image/png;base64,abc123',
    blob: `${'A'.repeat(300)}`,
  });
  assert.deepEqual(sanitized, { payee: 'Coffee', meta: { note: 'ok' } });
});

test('draft store enforces per-scope LRU bound deterministically', () => {
  purgeMutationFormDrafts('scope-lru');
  for (let i = 0; i < MAX_DRAFTS_PER_SCOPE + 5; i += 1) {
    setMutationFormDraft('scope-lru', `form-${i}`, { n: i }, 1);
  }
  assert.equal(getMutationFormDraft('scope-lru', 'form-0', 1), null);
  assert.equal(getMutationFormDraft('scope-lru', 'form-4', 1), null);
  assert.deepEqual(getMutationFormDraft('scope-lru', `form-${MAX_DRAFTS_PER_SCOPE + 4}`, 1), { n: MAX_DRAFTS_PER_SCOPE + 4 });
  purgeMutationFormDrafts('scope-lru');
});

test('purge all clears every scope when scope omitted', () => {
  setMutationFormDraft('x', 'form', { a: 1 }, 1);
  setMutationFormDraft('y', 'form', { b: 2 }, 1);
  purgeMutationFormDrafts();
  assert.equal(getMutationFormDraft('x', 'form', 1), null);
  assert.equal(getMutationFormDraft('y', 'form', 1), null);
  clearMutationFormDraft('demo', 'form', 0);
});
