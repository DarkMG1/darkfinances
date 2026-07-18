const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const os = require('os');
const path = require('path');

const { enrichReviewTask } = require('../lib/review-task-fingerprint');
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

test('TRANSACTION_REFERENCE_STEPS includes reviewState', () => {
  assert.match(dataModuleSource, /'reviewState'/);
  assert.match(dataModuleSource, /TRANSACTION_REFERENCE_STEPS[\s\S]*reviewState/);
});

test('content-equivalent replacement preserves acknowledge disposition', () => {
  const txn = {
    id: 'old-id',
    imported_id: 'bank-import-1',
    amount: -100,
    payee: 'Merchant',
    date: '2026-07-09',
    accountId: 'acct-1',
    categoryId: '',
    cleared: false,
  };
  const before = enrichReviewTask({
    kind: 'uncategorized',
    priority: 95,
    title: 'Categorize',
    subtitle: 'Merchant',
    action: 'categorize',
    amount: 100,
    date: '2026-07-09',
    transaction: txn,
  });
  const after = enrichReviewTask({
    ...before,
    transaction: { ...txn, id: 'new-id' },
  });
  assert.equal(before.stableKey, after.stableKey);
  assert.equal(before.contentHash, after.contentHash);

  let state = normalizeReviewState({ schemaVersion: 2, contentVersion: 1, dispositions: {}, legacyDispositions: {} });
  state = applyReviewDisposition(state, { id: before.id, disposition: 'acknowledge' }, {
    taskIndex: buildReviewTaskIndex([before]),
  }).state;

  const rewritten = rewriteReviewDispositionsForReplacement(state, { 'old-id': 'new-id' }, {
    tasksBefore: [before],
    tasksAfter: [after],
  }).reviewState;

  const visible = filterVisibleReviewTasks([after], rewritten);
  assert.equal(visible.length, 0);
});

test('replacement with amount change drops disposition and reopens task', () => {
  const txn = {
    id: 'old-id',
    imported_id: 'bank-import-2',
    amount: -100,
    payee: 'Merchant',
    date: '2026-07-09',
    accountId: 'acct-1',
    categoryId: '',
    cleared: false,
  };
  const before = enrichReviewTask({ kind: 'large_charge', priority: 70, title: 'Large', subtitle: 'Merchant', action: 'open_transaction', amount: 100, date: '2026-07-09', transaction: txn }, { largeThreshold: 50 });
  const after = enrichReviewTask({ kind: 'large_charge', priority: 70, title: 'Large', subtitle: 'Merchant', action: 'open_transaction', amount: 200, date: '2026-07-09', transaction: { ...txn, amount: -200 } }, { largeThreshold: 50 });

  let state = applyReviewDisposition(normalizeReviewState({ schemaVersion: 2, contentVersion: 1, dispositions: {}, legacyDispositions: {} }), {
    id: before.id,
    disposition: 'acknowledge',
  }, { taskIndex: buildReviewTaskIndex([before]) }).state;

  const rewritten = rewriteReviewDispositionsForReplacement(state, { 'old-id': 'new-id' }, {
    tasksBefore: [before],
    tasksAfter: [after],
  }).reviewState;

  assert.equal(Object.keys(rewritten.dispositions).length, 0);
  assert.equal(filterVisibleReviewTasks([after], rewritten).length, 1);
});

test('replacement saga reference step rewrites reviewState store', () => {
  const state = normalizeReviewState({
    schemaVersion: 2,
    contentVersion: 1,
    dispositions: {
      'uncategorized:uncategorized:id:old-id': {
        disposition: 'acknowledge',
        at: '2026-07-01T00:00:00.000Z',
        contentHash: 'a'.repeat(64),
        kind: 'uncategorized',
      },
    },
    legacyDispositions: {},
  });
  const result = rewriteTransactionReplacementReferences({ reviewState: state }, { 'old-id': 'new-id' });
  assert.ok(result.stores.reviewState.dispositions['uncategorized:uncategorized:id:new-id']);
  assert.equal(result.stats.reviewState, 1);
});

test('deletion removes disposition for deleted anchor', () => {
  const state = normalizeReviewState({
    schemaVersion: 2,
    contentVersion: 1,
    dispositions: {
      'pending:pending:id:txn-del': { disposition: 'acknowledge', at: '2026-07-01T00:00:00.000Z', contentHash: 'a'.repeat(64), kind: 'pending' },
    },
    legacyDispositions: {
      'uncategorized:txn-del': { disposition: 'acknowledge', at: '2026-07-01T00:00:00.000Z' },
    },
  });
  const deleted = rewriteReviewDispositionsForDeletion(state, ['txn-del']).reviewState;
  assert.deepEqual(deleted.dispositions, {});
  assert.deepEqual(deleted.legacyDispositions, {});
});

test('deletion reference integration removes reviewState entries', () => {
  const state = normalizeReviewState({
    schemaVersion: 2,
    contentVersion: 1,
    dispositions: {
      'missing_receipt:missing_receipt:id:txn-x': {
        disposition: 'dismiss',
        at: '2026-07-01T00:00:00.000Z',
        contentHash: 'b'.repeat(64),
        kind: 'missing_receipt',
      },
    },
    legacyDispositions: {},
  });
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
  const state = normalizeReviewState({
    schemaVersion: 2,
    contentVersion: 1,
    dispositions: {
      'repayment:sg_inflow-a': {
        disposition: 'acknowledge',
        at: '2026-07-01T00:00:00.000Z',
        contentHash: 'a'.repeat(64),
        kind: 'repayment',
      },
      'repayment:sg_inflow-b': {
        disposition: 'dismiss',
        at: '2026-07-01T00:00:00.000Z',
        contentHash: 'b'.repeat(64),
        kind: 'repayment',
      },
    },
    legacyDispositions: {},
  });
  assert.throws(
    () => rewriteReviewDispositionsForReplacement(state, { 'inflow-a': 'merged', 'inflow-b': 'merged' }, {
      tasksBefore: [],
      tasksAfter: [],
    }),
    /overwrite distinct evidence/,
  );
});
