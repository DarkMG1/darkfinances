'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');

const { buildImportedIdCounts, enrichReviewTask } = require('../lib/review-task-fingerprint');
const {
  applyReviewDisposition,
  buildReviewTaskIndex,
  compareAndSwapReviewStateMaintenance,
  filterVisibleReviewTasks,
  invalidateReviewDispositionsForTargets,
  normalizeReviewState,
  preflightReviewDispositionAdmission,
  reviewStateRevision,
  rewriteReviewDispositionsForDeletion,
  rewriteReviewDispositionsForReplacement,
} = require('../lib/review-disposition');

function ctx(txns) {
  return { importedIdCounts: buildImportedIdCounts(txns), transactions: txns };
}

test('duplicate imported ids use raw id anchors with distinct hashes', () => {
  const txns = [
    { id: 'raw-1', imported_id: 'dup', amount: -10, date: '2026-07-01', accountId: 'a1', categoryId: '' },
    { id: 'raw-2', imported_id: 'dup', amount: -20, date: '2026-07-01', accountId: 'a1', categoryId: '' },
  ];
  const first = enrichReviewTask({ kind: 'pending', date: '2026-07-01', amount: 10, transaction: txns[0] }, ctx(txns));
  const second = enrichReviewTask({ kind: 'pending', date: '2026-07-01', amount: 20, transaction: txns[1] }, ctx(txns));
  assert.notEqual(first.stableKey, second.stableKey);
  assert.notEqual(first.contentHash, second.contentHash);
});

test('compare-and-swap snooze cleanup refuses concurrent disposition overwrite', () => {
  const state = normalizeReviewState({
    schemaVersion: 2,
    contentVersion: 1,
    dispositions: {
      'pending:id:txn-1': {
        disposition: 'acknowledge',
        at: '2026-07-01T00:00:00.000Z',
        contentHash: 'a'.repeat(64),
      },
    },
    legacyDispositions: {},
  });
  const revision = reviewStateRevision(state);
  const result = compareAndSwapReviewStateMaintenance(state, {
    expectedRevision: revision,
    expiredSnoozeKeys: [{ bucket: 'dispositions', key: 'pending:id:txn-1', disposition: 'snooze', until: '2020-01-01T00:00:00.000Z' }],
  });
  assert.equal(result.changed, false);
  assert.equal(result.state.dispositions['pending:id:txn-1'].disposition, 'acknowledge');
});

test('lifecycle invalidation clears disposition when task evidence disappears', () => {
  const txns = [{ id: 'txn-1', amount: -12, payee: 'Coffee', date: '2026-07-01', accountId: 'acct-1', categoryId: '', cleared: true }];
  const task = enrichReviewTask({ kind: 'missing_receipt', date: '2026-07-01', amount: 12, transaction: txns[0] }, ctx(txns));
  const index = buildReviewTaskIndex([task]);
  let state = applyReviewDisposition(emptyState(), { id: task.id, disposition: 'acknowledge', contentHash: task.contentHash }, { taskIndex: index }).state;
  ({ reviewState: state } = invalidateReviewDispositionsForTargets(state, { targetIds: ['txn-1'] }));
  assert.equal(Object.keys(state.dispositions).length, 0);
});

test('preflight admission performs zero writes', () => {
  const txns = [{ id: 'txn-1', amount: -12, date: '2026-07-01', accountId: 'a1', categoryId: '' }];
  const task = enrichReviewTask({ kind: 'uncategorized', date: '2026-07-01', amount: 12, transaction: txns[0] }, ctx(txns));
  const before = emptyState();
  preflightReviewDispositionAdmission(before, { id: task.id, disposition: 'acknowledge', contentHash: task.contentHash }, {
    taskIndex: buildReviewTaskIndex([task]),
  });
  assert.deepEqual(before, emptyState());
});

function emptyState() {
  return normalizeReviewState({ schemaVersion: 2, contentVersion: 1, dispositions: {}, legacyDispositions: {} });
}
