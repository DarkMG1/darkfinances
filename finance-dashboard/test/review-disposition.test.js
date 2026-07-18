const test = require('node:test');
const assert = require('node:assert/strict');

const { enrichReviewTask, buildImportedIdCounts } = require('../lib/review-task-fingerprint');
const {
  applyReviewDisposition,
  buildReviewTaskIndex,
  countMigrationRequired,
  filterVisibleReviewTasks,
  isReviewTaskVisible,
  normalizeReviewState,
  preflightReviewDispositionAdmission,
  pruneExpiredReviewSnoozes,
  ReviewDispositionLegacyRefetchError,
  ReviewDispositionStaleError,
  ReviewDispositionUnknownError,
} = require('../lib/review-disposition');

function ctx(txns) {
  return { importedIdCounts: buildImportedIdCounts(txns), transactions: txns };
}

function sampleTask(overrides = {}) {
  const txns = [{ id: 'txn-1', imported_id: 'bank-abc', amount: -12, payee: 'Coffee', date: '2026-07-01', accountId: 'acct-1', categoryId: '', cleared: true }];
  return enrichReviewTask({
    kind: 'uncategorized',
    priority: 95,
    title: 'Categorize',
    subtitle: 'Coffee',
    action: 'categorize',
    amount: 12,
    date: '2026-07-01',
    transaction: txns[0],
    ...overrides,
  }, ctx(txns));
}

function emptyState() {
  return normalizeReviewState({ schemaVersion: 2, contentVersion: 1, dispositions: {}, legacyDispositions: {} });
}

test('ack hides equivalent content by stableKey', () => {
  const task = sampleTask();
  const index = buildReviewTaskIndex([task]);
  const applied = applyReviewDisposition(emptyState(), { id: task.id, disposition: 'acknowledge', contentHash: task.contentHash }, { taskIndex: index });
  assert.equal(filterVisibleReviewTasks([task], applied.state).length, 0);
});

test('legacy without proven contentHash never hides current task', () => {
  const task = sampleTask();
  const state = normalizeReviewState({
    schemaVersion: 2,
    contentVersion: 1,
    dispositions: {},
    legacyDispositions: {
      'uncategorized:txn-1': { disposition: 'acknowledge', at: '2026-07-01T00:00:00.000Z' },
    },
  });
  assert.equal(isReviewTaskVisible(task, state, Date.now(), buildReviewTaskIndex([task])), true);
  assert.ok(countMigrationRequired(state) >= 1);
});

test('legacy write requires current contentHash', () => {
  const task = sampleTask();
  const index = buildReviewTaskIndex([task]);
  assert.throws(
    () => preflightReviewDispositionAdmission(emptyState(), { id: 'uncategorized:txn-1', disposition: 'acknowledge' }, { taskIndex: index }),
    ReviewDispositionLegacyRefetchError,
  );
  assert.doesNotThrow(() => preflightReviewDispositionAdmission(emptyState(), {
    id: 'uncategorized:txn-1',
    disposition: 'acknowledge',
    contentHash: task.contentHash,
  }, { taskIndex: index }));
});

test('stale bound id rejects with 409', () => {
  const task = sampleTask();
  const staleId = `${task.id.slice(0, 64)}@${'b'.repeat(64)}`;
  const index = buildReviewTaskIndex([task]);
  assert.throws(
    () => preflightReviewDispositionAdmission(emptyState(), { id: staleId, disposition: 'acknowledge' }, { taskIndex: index }),
    ReviewDispositionStaleError,
  );
});

test('unknown disposition id rejects with 404', () => {
  assert.throws(
    () => preflightReviewDispositionAdmission(emptyState(), { id: 'uncategorized:missing', disposition: 'acknowledge', contentHash: 'a'.repeat(64) }, {
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
    contentHash: task.contentHash,
  }, { taskIndex: index, now: Date.parse('2026-07-01T10:00:00.000Z') });
  assert.equal(isReviewTaskVisible(task, applied.state, Date.parse('2026-07-01T11:00:00.000Z'), index), false);
  assert.equal(isReviewTaskVisible(task, applied.state, Date.parse('2026-07-01T13:00:00.000Z'), index), true);
});

test('snooze expiry is durably pruned on mutation write path only', () => {
  const task = sampleTask();
  const index = buildReviewTaskIndex([task]);
  const until = new Date('2026-07-01T12:00:00.000Z').toISOString();
  const state = applyReviewDisposition(emptyState(), { id: task.id, disposition: 'snooze', until, contentHash: task.contentHash }, {
    taskIndex: index,
    now: Date.parse('2026-07-01T10:00:00.000Z'),
  }).state;
  assert.ok(state.dispositions[task.stableKey]);
  const pruned = pruneExpiredReviewSnoozes(state, Date.parse('2026-07-01T13:00:00.000Z'));
  assert.equal(pruned.changed, true);
  assert.equal(pruned.state.dispositions[task.stableKey], undefined);
});

test('v1 legacy bucket preserved losslessly without truncation', () => {
  const legacyDispositions = {};
  for (let i = 0; i < 6000; i += 1) {
    legacyDispositions[`uncategorized:txn-${i}`] = { disposition: 'acknowledge', at: '2026-07-01T00:00:00.000Z' };
  }
  const migrated = normalizeReviewState({ schemaVersion: 1, dispositions: legacyDispositions });
  assert.equal(Object.keys(migrated.legacyDispositions).length, 6000);
  assert.deepEqual(migrated.dispositions, {});
});

test('uncertain legacy mapping fails open (shows task)', () => {
  const task = sampleTask();
  const state = normalizeReviewState({
    schemaVersion: 2,
    contentVersion: 1,
    dispositions: {},
    legacyDispositions: {
      'uncategorized:orphan-txn': { disposition: 'acknowledge', at: '2026-07-01T00:00:00.000Z', contentHash: 'a'.repeat(64) },
    },
  });
  assert.equal(isReviewTaskVisible(task, state, Date.now(), buildReviewTaskIndex([task])), true);
});
