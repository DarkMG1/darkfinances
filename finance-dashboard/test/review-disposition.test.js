const test = require('node:test');
const assert = require('node:assert/strict');

const { enrichReviewTask } = require('../lib/review-task-fingerprint');
const {
  applyReviewDisposition,
  buildReviewTaskIndex,
  filterVisibleReviewTasks,
  isReviewTaskVisible,
  normalizeReviewState,
  pruneExpiredReviewSnoozes,
  ReviewDispositionStaleError,
  ReviewDispositionUnknownError,
} = require('../lib/review-disposition');

function sampleTask(overrides = {}) {
  return enrichReviewTask({
    kind: 'uncategorized',
    priority: 95,
    title: 'Categorize',
    subtitle: 'Coffee',
    action: 'categorize',
    amount: 12,
    date: '2026-07-01',
    transaction: {
      id: 'txn-1',
      imported_id: 'bank-abc',
      amount: -12,
      payee: 'Coffee',
      date: '2026-07-01',
      accountId: 'acct-1',
      categoryId: '',
      cleared: true,
    },
    ...overrides,
  });
}

test('ack hides equivalent content by stableKey', () => {
  const task = sampleTask();
  const index = buildReviewTaskIndex([task]);
  const applied = applyReviewDisposition(emptyState(), {
    id: task.id,
    disposition: 'acknowledge',
  }, { taskIndex: index });
  const visible = filterVisibleReviewTasks([task], applied.state);
  assert.equal(visible.length, 0);
});

test('amount change reopens large_charge', () => {
  const hidden = sampleTask({ kind: 'large_charge', amount: 250, transaction: { id: 'txn-1', imported_id: 'bank-abc', amount: -250, payee: 'Hotel', date: '2026-07-01', accountId: 'a1', categoryId: 'c1', cleared: true } });
  const changed = enrichReviewTask({ ...hidden, amount: 400, transaction: { ...hidden.transaction, amount: -400 } }, { largeThreshold: 200 });
  const index = buildReviewTaskIndex([hidden]);
  const state = applyReviewDisposition(emptyState(), { id: hidden.id, disposition: 'acknowledge' }, { taskIndex: index }).state;
  assert.equal(isReviewTaskVisible(changed, state, Date.now(), buildReviewTaskIndex([changed])), true);
});

test('legacy id maps to current task without stale hash and stores stableKey', () => {
  const task = sampleTask();
  const index = buildReviewTaskIndex([task]);
  const applied = applyReviewDisposition(emptyState(), {
    id: 'uncategorized:txn-1',
    disposition: 'acknowledge',
  }, { taskIndex: index });
  assert.ok(applied.state.dispositions[task.stableKey]);
  assert.equal(applied.state.dispositions[task.stableKey].contentHash, task.contentHash);
});

test('stale bound id rejects with 409', () => {
  const task = sampleTask();
  const staleId = `${task.stableKey}@${'b'.repeat(64)}`;
  const index = buildReviewTaskIndex([task]);
  assert.throws(
    () => applyReviewDisposition(emptyState(), { id: staleId, disposition: 'acknowledge' }, { taskIndex: index }),
    ReviewDispositionStaleError,
  );
});

test('unknown disposition id rejects with 409', () => {
  assert.throws(
    () => applyReviewDisposition(emptyState(), { id: 'uncategorized:missing', disposition: 'acknowledge' }, {
      taskIndex: buildReviewTaskIndex([]),
    }),
    ReviewDispositionUnknownError,
  );
});

test('snooze hides until expiry then shows immediately without read-side write', () => {
  const task = sampleTask();
  const index = buildReviewTaskIndex([task]);
  const until = new Date('2026-07-01T12:00:00.000Z').toISOString();
  const applied = applyReviewDisposition(emptyState(), {
    id: task.id,
    disposition: 'snooze',
    until,
  }, { taskIndex: index, now: Date.parse('2026-07-01T10:00:00.000Z') });
  assert.equal(isReviewTaskVisible(task, applied.state, Date.parse('2026-07-01T11:00:00.000Z'), index), false);
  assert.equal(isReviewTaskVisible(task, applied.state, Date.parse('2026-07-01T13:00:00.000Z'), index), true);
  assert.ok(applied.state.dispositions[task.stableKey]);
});

test('snooze expiry is durably pruned on write path', () => {
  const task = sampleTask();
  const index = buildReviewTaskIndex([task]);
  const until = new Date('2026-07-01T12:00:00.000Z').toISOString();
  let state = applyReviewDisposition(emptyState(), { id: task.id, disposition: 'snooze', until }, {
    taskIndex: index,
    now: Date.parse('2026-07-01T10:00:00.000Z'),
  }).state;
  const pruned = pruneExpiredReviewSnoozes(state, Date.parse('2026-07-01T13:00:00.000Z'));
  assert.equal(pruned.changed, true);
  assert.equal(pruned.state.dispositions[task.stableKey], undefined);
});

test('v1 legacy bucket preserved in bounded migration', () => {
  const migrated = normalizeReviewState({
    schemaVersion: 1,
    dispositions: {
      'uncategorized:txn-1': { disposition: 'acknowledge', at: '2026-07-01T00:00:00.000Z' },
      'fp-1': 'hidden',
    },
  });
  assert.equal(migrated.schemaVersion, 2);
  assert.deepEqual(migrated.dispositions, {});
  assert.ok(migrated.legacyDispositions['uncategorized:txn-1']);
  assert.equal(migrated.legacyDispositions['fp-1'].disposition, 'acknowledge');
});

test('uncertain legacy mapping fails open (shows task)', () => {
  const task = sampleTask();
  const state = normalizeReviewState({
    schemaVersion: 2,
    contentVersion: 1,
    dispositions: {},
    legacyDispositions: {
      'uncategorized:orphan-txn': { disposition: 'acknowledge', at: '2026-07-01T00:00:00.000Z' },
    },
  });
  assert.equal(isReviewTaskVisible(task, state, Date.now(), buildReviewTaskIndex([task])), true);
});

function emptyState() {
  return normalizeReviewState({ schemaVersion: 2, contentVersion: 1, dispositions: {}, legacyDispositions: {} });
}
