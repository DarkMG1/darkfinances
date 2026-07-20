const test = require('node:test');
const assert = require('node:assert/strict');

const {
  REVIEW_CONTENT_VERSION,
  buildImportedIdCounts,
  canonicalReviewContent,
  enrichReviewTask,
  entityAnchor,
  hashPayload,
  parseReviewTaskId,
  reviewTaskContentHash,
  reviewTaskStableKey,
  stableKeyDigest,
} = require('../lib/review-task-fingerprint');
const { buildReviewTaskIndex } = require('../lib/review-disposition');

const ctx = (txns) => ({ importedIdCounts: buildImportedIdCounts(txns), transactions: txns });

test('entityAnchor uses imported only when unique', () => {
  const txns = [
    { id: 'a', imported_id: 'dup' },
    { id: 'b', imported_id: 'dup' },
  ];
  const context = ctx(txns);
  assert.equal(entityAnchor(txns[0], context), 'id:a:ambiguousImport:dup');
  assert.equal(entityAnchor({ id: 'solo', imported_id: 'unique-1' }, ctx([{ id: 'solo', imported_id: 'unique-1' }])), 'imported:unique-1');
});

test('split leg stable identity excludes content fields', () => {
  const parent = { id: 'p1', imported_id: 'bank-1' };
  const legA = { id: 'leg-a', parentId: 'p1', isLeg: true, amount: -10, categoryId: 'c1', payee: 'A', imported_id: 'bank-1', date: '2026-07-01', accountId: 'a1' };
  const legB = { ...legA, amount: -20, categoryId: 'c2', payee: 'B' };
  const context = ctx([parent, legA, legB]);
  const taskA = enrichReviewTask({ kind: 'uncategorized', date: '2026-07-01', amount: 10, transaction: legA }, context);
  const taskB = enrichReviewTask({ kind: 'uncategorized', date: '2026-07-01', amount: 20, transaction: legB }, context);
  assert.equal(taskA.stableKey, taskB.stableKey);
  assert.notEqual(taskA.contentHash, taskB.contentHash);
  assert.match(taskA.stableKey, /:leg-a$/);
});

test('split legs stay distinct when parent and imported overlap', () => {
  const parent = { id: 'p1', imported_id: 'bank-1' };
  const legA = { id: 'leg-a', parentId: 'p1', isLeg: true, amount: -10, categoryId: 'c1', payee: 'A', imported_id: 'bank-1' };
  const legB = { id: 'leg-b', parentId: 'p1', isLeg: true, amount: -20, categoryId: 'c2', payee: 'B', imported_id: 'bank-1' };
  const context = ctx([parent, legA, legB]);
  assert.notEqual(entityAnchor(legA, context), entityAnchor(legB, context));
});

test('stable key uses single kind prefix and public id uses full digests', () => {
  const txns = [{ id: 'txn-1', imported_id: 'bank-abc', amount: -42.5, payee: 'Coffee #123', date: '2026-07-01', accountId: 'acct-1', categoryId: '', cleared: true }];
  const task = enrichReviewTask({
    kind: 'uncategorized',
    transaction: txns[0],
    date: '2026-07-01',
    amount: 42.5,
  }, ctx(txns));
  assert.match(task.stableKey, /^uncategorized:imported:bank-abc$/);
  assert.equal(task.contentVersion, REVIEW_CONTENT_VERSION);
  assert.equal(task.contentHash, reviewTaskContentHash(task, ctx(txns)));
  assert.equal(task.id, `${stableKeyDigest(task.stableKey)}@${task.contentHash}`);
  assert.equal(task.id.length, 64 + 1 + 64);
});

test('payee prefers payeeId and keeps hash tokens', () => {
  const withId = canonicalReviewContent({
    kind: 'uncategorized',
    date: '2026-07-01',
    amount: 10,
    transaction: { id: '1', payeeId: 'pid-1', payee: 'Store #123', amount: -10, date: '2026-07-01', accountId: 'a1', categoryId: '' },
  }, ctx([{ id: '1', payeeId: 'pid-1' }]));
  assert.deepEqual(withId.payee, { kind: 'payeeId', value: 'pid-1' });
  const text = canonicalReviewContent({
    kind: 'uncategorized',
    date: '2026-07-01',
    amount: 10,
    transaction: { id: '2', payee: 'Café #123 René', amount: -10, date: '2026-07-01', accountId: 'a1', categoryId: '' },
  }, ctx([{ id: '2' }]));
  assert.equal(text.payee.value, 'cafe #123 rene');
});

test('missing_receipt hash tracks categoryId', () => {
  const txn = { id: '1', amount: -80, date: '2026-07-01', accountId: 'a1', categoryId: 'c1' };
  const first = enrichReviewTask({ kind: 'missing_receipt', date: '2026-07-01', amount: 80, transaction: txn }, ctx([txn]));
  const second = enrichReviewTask({ kind: 'missing_receipt', date: '2026-07-01', amount: 80, transaction: { ...txn, categoryId: 'c2' } }, ctx([{ ...txn, categoryId: 'c2' }]));
  assert.equal(first.stableKey, second.stableKey);
  assert.notEqual(first.contentHash, second.contentHash);
});

test('reconciliation hash tracks unresolved identity set not counts alone', () => {
  const base = {
    kind: 'reconciliation',
    month: '2026-06',
    unresolvedItems: [{ id: 'a', amount: 10 }, { id: 'b', amount: 20 }],
  };
  const sameCount = enrichReviewTask({ ...base, remaining: 2, total: 10 });
  const different = enrichReviewTask({ ...base, unresolvedItems: [{ id: 'a', amount: 10 }, { id: 'c', amount: 20 }], remaining: 2, total: 10 });
  assert.equal(sameCount.stableKey, different.stableKey);
  assert.notEqual(sameCount.contentHash, different.contentHash);
});

test('parseReviewTaskId resolves digest ids through task index', () => {
  const txns = [{ id: 'txn-1', amount: -10, date: '2026-07-01', accountId: 'a1', categoryId: '' }];
  const task = enrichReviewTask({ kind: 'pending', date: '2026-07-01', amount: 10, transaction: txns[0] }, ctx(txns));
  const parsed = parseReviewTaskId(task.id, buildReviewTaskIndex([task]));
  assert.equal(parsed.legacy, false);
  assert.equal(parsed.stableKey, task.stableKey);
  assert.equal(parsed.contentHash, task.contentHash);
});

test('hash permutations are order-independent for reconciliation unresolved set', () => {
  const firstTask = enrichReviewTask({
    kind: 'reconciliation',
    month: '2026-06',
    unresolvedItems: [{ id: 'b', amount: 20 }, { id: 'a', amount: 10 }],
  });
  const secondTask = enrichReviewTask({
    kind: 'reconciliation',
    month: '2026-06',
    unresolvedItems: [{ id: 'a', amount: 10 }, { id: 'b', amount: 20 }],
  });
  assert.equal(firstTask.contentHash, secondTask.contentHash);
});
