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

test('scope digests containing colons or URL-like strings use consistent bucket keys', () => {
  const urlScope = 'https://host.example:8443/profile';
  purgeMutationFormDrafts(urlScope);
  setMutationFormDraft(urlScope, 'add-transaction', { amount: '12.50' }, 1);
  assert.deepEqual(getMutationFormDraft(urlScope, 'add-transaction', 1), { amount: '12.50' });
  clearMutationFormDraft(urlScope, 'add-transaction', 1);
  assert.equal(getMutationFormDraft(urlScope, 'add-transaction', 1), null);

  const colonScope = 'tenant:region:abc';
  purgeMutationFormDrafts(colonScope);
  setMutationFormDraft(colonScope, 'events-create', { name: 'Trip' }, 2);
  assert.deepEqual(getMutationFormDraft(colonScope, 'events-create', 2), { name: 'Trip' });
  clearMutationFormDraft(colonScope, null, 2);
  assert.equal(getMutationFormDraft(colonScope, 'events-create', 2), null);
});

test('LRU eviction uses full scope digest bucket not split prefix', () => {
  const scopeA = 'https://a.example:1/x';
  const scopeB = 'https://a.example:2/y';
  purgeMutationFormDrafts();
  setMutationFormDraft(scopeA, 'form-a', { n: 1 }, 1);
  setMutationFormDraft(scopeB, 'form-b', { n: 2 }, 1);
  assert.deepEqual(getMutationFormDraft(scopeA, 'form-a', 1), { n: 1 });
  assert.deepEqual(getMutationFormDraft(scopeB, 'form-b', 1), { n: 2 });
  purgeMutationFormDrafts(scopeA);
  assert.equal(getMutationFormDraft(scopeA, 'form-a', 1), null);
  assert.deepEqual(getMutationFormDraft(scopeB, 'form-b', 1), { n: 2 });
  purgeMutationFormDrafts(scopeB);
});
