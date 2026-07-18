'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');

const {
  canonicalReviewContent,
  enrichReviewTask,
  reviewTaskContentHash,
  reviewTaskStableKey,
} = require('../lib/review-task-fingerprint');
const {
  MAX_LEGACY_DISPOSITIONS,
  applyReviewDisposition,
  boundLegacyBucket,
  buildReviewTaskIndex,
  collectExpiredSnoozeKeys,
  filterVisibleReviewTasks,
  isReviewTaskVisible,
  normalizeReviewState,
  pruneExpiredReviewSnoozes,
} = require('../lib/review-disposition');

function txn(overrides = {}) {
  return {
    id: 'txn-1',
    imported_id: 'bank-import-1',
    amount: -10.5,
    payee: '  Cafe   Latte ',
    date: '2026-07-01',
    accountId: 'acct-1',
    categoryId: '',
    cleared: true,
    ...overrides,
  };
}

test('canonical hash is stable for payee normalization and exact cents', () => {
  const first = canonicalReviewContent({
    kind: 'uncategorized',
    date: '2026-07-01',
    amount: 10.5,
    transaction: txn(),
  });
  const second = canonicalReviewContent({
    kind: 'uncategorized',
    date: '2026-07-01',
    amount: 10.5,
    transaction: txn({ payee: 'cafe latte' }),
  });
  assert.deepEqual(first, second);
  assert.equal(reviewTaskContentHash({ kind: 'uncategorized', transaction: txn() }), reviewTaskContentHash({ kind: 'uncategorized', transaction: txn({ payee: 'cafe latte' }) }));
});

test('duplicate-looking txns with imported vs raw id diverge stable keys', () => {
  const imported = enrichReviewTask({ kind: 'pending', date: '2026-07-01', amount: 10, transaction: txn({ id: 'raw-1', imported_id: 'bank-1' }) });
  const rawOnly = enrichReviewTask({ kind: 'pending', date: '2026-07-01', amount: 10, transaction: txn({ id: 'raw-1', imported_id: null }) });
  assert.notEqual(imported.stableKey, rawOnly.stableKey);
  assert.notEqual(imported.contentHash, rawOnly.contentHash);
});

test('resolved task that disappears and returns with same content stays hidden', () => {
  const task = enrichReviewTask({ kind: 'missing_receipt', date: '2026-07-01', amount: 80, transaction: txn({ amount: -80 }) });
  const index = buildReviewTaskIndex([task]);
  const state = applyReviewDisposition(normalizeReviewState({ schemaVersion: 2, contentVersion: 1, dispositions: {}, legacyDispositions: {} }), {
    id: task.id,
    disposition: 'resolved',
  }, { taskIndex: index }).state;
  assert.equal(filterVisibleReviewTasks([task], state).length, 0);
  assert.equal(isReviewTaskVisible(task, state, Date.now(), index), false);
});

test('resolved task that returns with changed amount reopens', () => {
  const hidden = enrichReviewTask({ kind: 'missing_receipt', date: '2026-07-01', amount: 80, transaction: txn({ amount: -80 }) });
  const changed = enrichReviewTask({ kind: 'missing_receipt', date: '2026-07-01', amount: 120, transaction: txn({ amount: -120 }) });
  const index = buildReviewTaskIndex([hidden]);
  const state = applyReviewDisposition(normalizeReviewState({ schemaVersion: 2, contentVersion: 1, dispositions: {}, legacyDispositions: {} }), {
    id: hidden.id,
    disposition: 'resolved',
  }, { taskIndex: index }).state;
  assert.equal(reviewTaskStableKey(hidden), reviewTaskStableKey(changed));
  assert.equal(isReviewTaskVisible(changed, state, Date.now(), buildReviewTaskIndex([changed])), true);
});

test('snooze maintenance collects expired keys without mutating read snapshot', () => {
  const state = normalizeReviewState({
    schemaVersion: 2,
    contentVersion: 1,
    dispositions: {
      'pending:pending:imported:bank-1': {
        disposition: 'snooze',
        until: '2020-01-01T00:00:00.000Z',
      },
    },
    legacyDispositions: {},
  });
  const expired = collectExpiredSnoozeKeys(state, Date.parse('2026-07-01T00:00:00.000Z'));
  assert.equal(expired.length, 1);
  assert.ok(state.dispositions['pending:pending:imported:bank-1']);
  const pruned = pruneExpiredReviewSnoozes(state, Date.parse('2026-07-01T00:00:00.000Z'));
  assert.equal(pruned.changed, true);
  assert.equal(pruned.state.dispositions['pending:pending:imported:bank-1'], undefined);
});

test('legacy bucket is bounded without dropping newest records', () => {
  const legacyDispositions = {};
  for (let i = 0; i < MAX_LEGACY_DISPOSITIONS + 10; i += 1) {
    legacyDispositions[`uncategorized:txn-${i}`] = {
      disposition: 'acknowledge',
      at: new Date(Date.UTC(2026, 0, 1, 0, 0, i)).toISOString(),
    };
  }
  const bounded = boundLegacyBucket(legacyDispositions);
  assert.equal(Object.keys(bounded).length, MAX_LEGACY_DISPOSITIONS);
  assert.ok(bounded[`uncategorized:txn-${MAX_LEGACY_DISPOSITIONS + 9}`]);
  assert.equal(bounded['uncategorized:txn-0'], undefined);
});

test('optional body contentHash rejects stale race with 409 class', () => {
  const task = enrichReviewTask({ kind: 'uncategorized', date: '2026-07-01', amount: 10, transaction: txn() });
  const index = buildReviewTaskIndex([task]);
  assert.throws(
    () => applyReviewDisposition(normalizeReviewState({ schemaVersion: 2, contentVersion: 1, dispositions: {}, legacyDispositions: {} }), {
      id: task.id,
      disposition: 'acknowledge',
      contentHash: 'b'.repeat(64),
    }, { taskIndex: index }),
    (error) => error.name === 'ReviewDispositionStaleError' && error.status === 409,
  );
});
