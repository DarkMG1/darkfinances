const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const path = require('path');

const { buildImportedIdCounts, enrichReviewTask } = require('../lib/review-task-fingerprint');
const {
  applyReviewDisposition,
  buildReviewTaskIndex,
  filterVisibleReviewTasks,
  normalizeReviewState,
  rewriteReviewDispositionsForDeletion,
  rewriteReviewDispositionsForReplacement,
} = require('../lib/review-disposition');
const { rewriteTransactionReplacementReferences } = require('../lib/transaction-replacement-references');
const { rewriteTransactionDeletionReferences } = require('../lib/transaction-deletion-references');

const dataModuleSource = fs.readFileSync(path.join(__dirname, '..', 'dataModule.js'), 'utf8');

function ctx(txns) {
  return { importedIdCounts: buildImportedIdCounts(txns), transactions: txns };
}

test('TRANSACTION_REFERENCE_STEPS includes reviewState', () => {
  assert.match(dataModuleSource, /'reviewState'/);
});

test('content-equivalent replacement preserves acknowledge disposition', () => {
  const txn = { id: 'old-id', imported_id: 'bank-import-1', amount: -100, payee: 'Merchant', date: '2026-07-09', accountId: 'acct-1', categoryId: '', cleared: false };
  const afterTxn = { id: 'new-id', imported_id: 'bank-import-1', amount: -100, payee: 'Merchant', date: '2026-07-09', accountId: 'acct-1', categoryId: '', cleared: false };
  const before = enrichReviewTask({ kind: 'uncategorized', priority: 95, title: 'Categorize', subtitle: 'Merchant', action: 'categorize', amount: 100, date: '2026-07-09', transaction: txn }, ctx([txn]));
  const after = enrichReviewTask({ kind: 'uncategorized', priority: 95, title: 'Categorize', subtitle: 'Merchant', action: 'categorize', amount: 100, date: '2026-07-09', transaction: afterTxn }, ctx([afterTxn]));
  assert.equal(before.stableKey, after.stableKey);
  assert.equal(before.contentHash, after.contentHash);

  let state = applyReviewDisposition(normalizeReviewState({ schemaVersion: 2, contentVersion: 1, dispositions: {}, legacyDispositions: {} }), {
    id: before.id,
    disposition: 'acknowledge',
    contentHash: before.contentHash,
  }, { taskIndex: buildReviewTaskIndex([before]) }).state;

  const rewritten = rewriteReviewDispositionsForReplacement(state, { 'old-id': 'new-id' }, { tasksBefore: [before], tasksAfter: [after] }).reviewState;
  assert.equal(filterVisibleReviewTasks([after], rewritten).length, 0);
});

test('replacement with amount change drops disposition and reopens task', () => {
  const txn = { id: 'old-id', imported_id: 'bank-import-2', amount: -100, payee: 'Merchant', date: '2026-07-09', accountId: 'acct-1', categoryId: '', cleared: false };
  const before = enrichReviewTask({ kind: 'large_charge', priority: 70, title: 'Large', subtitle: 'Merchant', action: 'open_transaction', amount: 100, date: '2026-07-09', transaction: txn }, { ...ctx([txn]), largeThreshold: 50 });
  const after = enrichReviewTask({ kind: 'large_charge', priority: 70, title: 'Large', subtitle: 'Merchant', action: 'open_transaction', amount: 200, date: '2026-07-09', transaction: { ...txn, id: 'new-id', amount: -200 } }, { ...ctx([{ ...txn, id: 'new-id', amount: -200 }]), largeThreshold: 50 });
  let state = applyReviewDisposition(normalizeReviewState({ schemaVersion: 2, contentVersion: 1, dispositions: {}, legacyDispositions: {} }), {
    id: before.id,
    disposition: 'acknowledge',
    contentHash: before.contentHash,
  }, { taskIndex: buildReviewTaskIndex([before]) }).state;
  const rewritten = rewriteReviewDispositionsForReplacement(state, { 'old-id': 'new-id' }, { tasksBefore: [before], tasksAfter: [after] }).reviewState;
  assert.equal(Object.keys(rewritten.dispositions).length, 0);
  assert.equal(filterVisibleReviewTasks([after], rewritten).length, 1);
});

test('replacement saga reference step rewrites reviewState store', () => {
  const beforeTxn = { id: 'old-id', imported_id: 'bank-1', amount: -100, date: '2026-07-09', accountId: 'a1', categoryId: '' };
  const afterTxn = { id: 'new-id', imported_id: 'bank-1', amount: -100, date: '2026-07-09', accountId: 'a1', categoryId: '' };
  const before = enrichReviewTask({ kind: 'uncategorized', priority: 95, title: 'Categorize', subtitle: 'Merchant', action: 'categorize', amount: 100, date: '2026-07-09', transaction: beforeTxn }, ctx([beforeTxn]));
  const state = normalizeReviewState({
    schemaVersion: 2,
    contentVersion: 1,
    dispositions: {
      [before.stableKey]: {
        disposition: 'acknowledge',
        at: '2026-07-01T00:00:00.000Z',
        contentHash: before.contentHash,
        kind: 'uncategorized',
        stableKey: before.stableKey,
      },
    },
    legacyDispositions: {},
  });
  const after = enrichReviewTask({ kind: 'uncategorized', priority: 95, title: 'Categorize', subtitle: 'Merchant', action: 'categorize', amount: 100, date: '2026-07-09', transaction: afterTxn }, ctx([afterTxn]));
  const result = rewriteTransactionReplacementReferences({ reviewState: state }, { 'old-id': 'new-id' }, { tasksBefore: [before], tasksAfter: [after] });
  assert.ok(result.stores.reviewState.dispositions[after.stableKey]);
  assert.equal(result.stores.reviewState.dispositions[after.stableKey].disposition, 'acknowledge');
});

test('deletion removes disposition matched by imported_id when txn id differs', () => {
  const txn = { id: 'actual-txn-id', imported_id: 'bank-import-unique', amount: -10, date: '2026-07-01', accountId: 'a1', categoryId: '' };
  const task = enrichReviewTask({ kind: 'uncategorized', date: '2026-07-01', amount: 10, transaction: txn }, ctx([txn]));
  assert.match(task.stableKey, /imported:bank-import-unique/);
  let state = applyReviewDisposition(normalizeReviewState({ schemaVersion: 2, contentVersion: 1, dispositions: {}, legacyDispositions: {} }), {
    id: task.id,
    disposition: 'acknowledge',
    contentHash: task.contentHash,
  }, { taskIndex: buildReviewTaskIndex([task]) }).state;
  const deleted = rewriteReviewDispositionsForDeletion(state, {
    snapshot: {
      id: 'actual-txn-id',
      imported_id: 'bank-import-unique',
      subtransactions: [],
    },
  }).reviewState;
  assert.deepEqual(deleted.dispositions, {});
});

test('deletion removes disposition for deleted anchor and imported id', () => {
  const txn = { id: 'txn-del', imported_id: 'import-del', amount: -10, date: '2026-07-01', accountId: 'a1', categoryId: '' };
  const task = enrichReviewTask({ kind: 'pending', date: '2026-07-01', amount: 10, transaction: txn }, ctx([txn]));
  let state = applyReviewDisposition(normalizeReviewState({ schemaVersion: 2, contentVersion: 1, dispositions: {}, legacyDispositions: {} }), {
    id: task.id,
    disposition: 'acknowledge',
    contentHash: task.contentHash,
  }, { taskIndex: buildReviewTaskIndex([task]) }).state;
  const deleted = rewriteReviewDispositionsForDeletion(state, { transactions: [txn] }).reviewState;
  assert.deepEqual(deleted.dispositions, {});
});

test('replacement idMap rewrites split leg raw ids in stable keys', () => {
  const parent = { id: 'parent-old', imported_id: 'bank-1', amount: -10, date: '2026-07-01', accountId: 'a1', categoryId: '' };
  const leg = { id: 'leg-old', parentId: 'parent-old', isLeg: true, amount: -10, categoryId: 'c1', date: '2026-07-01', accountId: 'a1' };
  const parentNew = { ...parent, id: 'parent-new' };
  const legNew = { ...leg, id: 'leg-new', parentId: 'parent-new' };
  const before = enrichReviewTask({ kind: 'uncategorized', date: '2026-07-01', amount: 10, transaction: leg }, ctx([parent, leg]));
  const after = enrichReviewTask({ kind: 'uncategorized', date: '2026-07-01', amount: 10, transaction: legNew }, ctx([parentNew, legNew]));
  assert.match(before.stableKey, /:leg-old$/);
  assert.match(after.stableKey, /:leg-new$/);
  let state = applyReviewDisposition(normalizeReviewState({ schemaVersion: 2, contentVersion: 1, dispositions: {}, legacyDispositions: {} }), {
    id: before.id,
    disposition: 'acknowledge',
    contentHash: before.contentHash,
  }, { taskIndex: buildReviewTaskIndex([before]) }).state;
  const rewritten = rewriteReviewDispositionsForReplacement(state, {
    'parent-old': 'parent-new',
    'leg-old': 'leg-new',
  }, { tasksBefore: [before], tasksAfter: [after] }).reviewState;
  assert.equal(filterVisibleReviewTasks([after], rewritten).length, 0);
  assert.match(Object.keys(rewritten.dispositions)[0], /:leg-new$/);
});

test('deletion reference integration removes reviewState entries', () => {
  const txn = { id: 'txn-x', amount: -10, date: '2026-07-01', accountId: 'a1', categoryId: '' };
  const task = enrichReviewTask({ kind: 'missing_receipt', date: '2026-07-01', amount: 10, transaction: txn }, ctx([txn]));
  const state = applyReviewDisposition(normalizeReviewState({ schemaVersion: 2, contentVersion: 1, dispositions: {}, legacyDispositions: {} }), {
    id: task.id,
    disposition: 'dismiss',
    contentHash: task.contentHash,
  }, { taskIndex: buildReviewTaskIndex([task]) }).state;
  const result = rewriteTransactionDeletionReferences({
    receipts: { byTxn: {} },
    links: { links: [] },
    suggestions: { confirmed: {}, dismissed: [] },
    reconciliation: { enabled: false, months: {} },
    phantomSeen: { seen: {} },
    reviewState: state,
  }, ['txn-x']);
  assert.equal(Object.keys(result.stores.reviewState.dispositions).length, 0);
  assert.equal(result.stats.reviewState, 1);
});

test('replacement collision on distinct evidence fails closed', () => {
  const txnA = { id: 'old-a', amount: -100, date: '2026-07-09', accountId: 'a1', categoryId: '' };
  const txnB = { id: 'old-b', amount: -100, date: '2026-07-09', accountId: 'a1', categoryId: '' };
  const afterTxn = { id: 'new-id', amount: -100, date: '2026-07-09', accountId: 'a1', categoryId: '' };
  const beforeA = enrichReviewTask({ kind: 'uncategorized', date: '2026-07-09', amount: 100, transaction: txnA }, ctx([txnA]));
  const beforeB = enrichReviewTask({ kind: 'uncategorized', date: '2026-07-09', amount: 100, transaction: txnB }, ctx([txnB]));
  const after = enrichReviewTask({ kind: 'uncategorized', date: '2026-07-09', amount: 100, transaction: afterTxn }, ctx([afterTxn]));
  const state = normalizeReviewState({
    schemaVersion: 2,
    contentVersion: 1,
    dispositions: {
      [beforeA.stableKey]: { disposition: 'acknowledge', at: '2026-07-01T00:00:00.000Z', contentHash: after.contentHash, kind: 'uncategorized' },
      [beforeB.stableKey]: { disposition: 'dismiss', at: '2026-07-01T00:00:00.000Z', contentHash: after.contentHash, kind: 'uncategorized' },
    },
    legacyDispositions: {},
  });
  assert.throws(
    () => rewriteReviewDispositionsForReplacement(state, { 'old-a': 'new-id', 'old-b': 'new-id' }, {
      tasksBefore: [beforeA, beforeB],
      tasksAfter: [after],
    }),
    /overwrite distinct evidence/,
  );
});
