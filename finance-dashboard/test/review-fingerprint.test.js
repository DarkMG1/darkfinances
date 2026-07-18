const test = require('node:test');
const assert = require('node:assert/strict');

const {
  REVIEW_CONTENT_VERSION,
  canonicalReviewContent,
  enrichReviewTask,
  parseReviewTaskId,
  reviewTaskContentHash,
  reviewTaskStableKey,
  txnAnchor,
} = require('../lib/review-task-fingerprint');

test('txnAnchor prefers imported identity over raw id', () => {
  const anchor = txnAnchor({ id: 'txn-1', imported_id: 'bank-abc' }, 'uncategorized');
  assert.equal(anchor, 'uncategorized:imported:bank-abc');
});

test('review task id binds stableKey and contentHash', () => {
  const task = enrichReviewTask({
    kind: 'uncategorized',
    transaction: { id: 'txn-1', imported_id: 'bank-abc', amount: -42.5, payee: 'Coffee #123', date: '2026-07-01', accountId: 'acct-1', categoryId: '', cleared: true },
    date: '2026-07-01',
    amount: 42.5,
  });
  assert.match(task.id, /^uncategorized:uncategorized:imported:bank-abc@[a-f0-9]{64}$/);
  assert.equal(task.stableKey, 'uncategorized:uncategorized:imported:bank-abc');
  assert.equal(task.contentVersion, REVIEW_CONTENT_VERSION);
  assert.equal(task.contentHash, reviewTaskContentHash(task));
});

test('amount change changes contentHash but not imported stableKey', () => {
  const baseTxn = { id: 'txn-1', imported_id: 'bank-abc', amount: -42.5, payee: 'Coffee', date: '2026-07-01', accountId: 'acct-1', categoryId: '', cleared: true };
  const first = enrichReviewTask({ kind: 'large_charge', transaction: baseTxn, date: '2026-07-01', amount: 42.5 }, { largeThreshold: 200 });
  const second = enrichReviewTask({ kind: 'large_charge', transaction: { ...baseTxn, amount: -99 }, date: '2026-07-01', amount: 99 }, { largeThreshold: 200 });
  assert.equal(first.stableKey, second.stableKey);
  assert.notEqual(first.contentHash, second.contentHash);
});

test('price_change hash tracks pct/from/to only', () => {
  const first = enrichReviewTask({
    kind: 'price_change',
    key: 'netflix',
    priceChange: { from: 15.99, to: 17.99, pct: 12.5 },
    amount: 17.99,
  });
  const second = enrichReviewTask({
    kind: 'price_change',
    key: 'netflix',
    priceChange: { from: 15.99, to: 18.99, pct: 18.8 },
    amount: 18.99,
  });
  assert.equal(first.stableKey, second.stableKey);
  assert.notEqual(first.contentHash, second.contentHash);
  assert.match(first.stableKey, /^price:netflix$/);
});

test('reconciliation hash tracks remaining and total', () => {
  const first = enrichReviewTask({ kind: 'reconciliation', month: '2026-06', remaining: 3, total: 10, amount: 3 });
  const second = enrichReviewTask({ kind: 'reconciliation', month: '2026-06', remaining: 2, total: 10, amount: 2 });
  assert.equal(first.stableKey, second.stableKey);
  assert.notEqual(first.contentHash, second.contentHash);
});

test('parseReviewTaskId distinguishes legacy and bound ids', () => {
  const bound = parseReviewTaskId(`uncategorized:uncategorized:id:txn-1@${'a'.repeat(64)}`);
  assert.equal(bound.legacy, false);
  assert.equal(bound.stableKey, 'uncategorized:uncategorized:id:txn-1');
  const legacy = parseReviewTaskId('uncategorized:txn-1');
  assert.equal(legacy.legacy, true);
  assert.equal(legacy.legacyKey, 'uncategorized:txn-1');
});

test('canonicalReviewContent excludes locale strings', () => {
  const content = canonicalReviewContent({
    kind: 'uncategorized',
    date: '2026-07-01',
    amount: 10,
    transaction: { id: '1', amount: -10, payee: 'Café René', date: '2026-07-01', accountId: 'a1', categoryId: 'c1' },
  });
  assert.equal(content.payeeKey, 'caf ren');
  assert.equal(content.kind, 'uncategorized');
  assert.ok(!Object.prototype.hasOwnProperty.call(content, 'title'));
});
