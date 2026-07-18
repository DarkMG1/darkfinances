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

test('split-leg repeated edits reuse one stable key without orphan dispositions', () => {
  const parent = { id: 'p1', imported_id: 'bank-1', amount: -30, date: '2026-07-01', accountId: 'a1', categoryId: 'c1' };
  const legBase = { id: 'leg-a', parentId: 'p1', isLeg: true, imported_id: 'bank-leg-a', date: '2026-07-01', accountId: 'a1' };
  const legV1 = { ...legBase, amount: -10, categoryId: 'c1', payee: 'A' };
  const legV2 = { ...legBase, amount: -20, categoryId: 'c2', payee: 'B' };
  const makeTask = (leg) => enrichReviewTask({
    kind: 'uncategorized',
    date: '2026-07-01',
    amount: Math.abs(leg.amount),
    transaction: leg,
  }, ctx([parent, leg]));
  const taskV1 = makeTask(legV1);
  const taskV2 = makeTask(legV2);
  const taskV1Again = makeTask({ ...legV1 });
  assert.equal(taskV1.stableKey, taskV2.stableKey);
  assert.notEqual(taskV1.contentHash, taskV2.contentHash);
  assert.equal(taskV1.contentHash, taskV1Again.contentHash);

  let state = emptyState();
  state = applyReviewDisposition(state, {
    id: taskV1.id,
    disposition: 'acknowledge',
    contentHash: taskV1.contentHash,
  }, { taskIndex: buildReviewTaskIndex([taskV1]) }).state;
  assert.equal(Object.keys(state.dispositions).length, 1);
  assert.equal(filterVisibleReviewTasks([taskV1], state).length, 0);

  assert.equal(filterVisibleReviewTasks([taskV2], state, Date.now(), buildReviewTaskIndex([taskV2])).length, 1);

  state = applyReviewDisposition(state, {
    id: taskV2.id,
    disposition: 'acknowledge',
    contentHash: taskV2.contentHash,
  }, { taskIndex: buildReviewTaskIndex([taskV2]) }).state;
  assert.equal(Object.keys(state.dispositions).length, 1);
  assert.equal(state.dispositions[taskV1.stableKey].contentHash, taskV2.contentHash);

  state = applyReviewDisposition(state, {
    id: taskV1Again.id,
    disposition: 'acknowledge',
    contentHash: taskV1Again.contentHash,
  }, { taskIndex: buildReviewTaskIndex([taskV1Again]) }).state;
  assert.equal(Object.keys(state.dispositions).length, 1);
  assert.equal(filterVisibleReviewTasks([taskV1Again], state).length, 0);
  assert.equal(state.dispositions[taskV1.stableKey].contentHash, taskV1Again.contentHash);
});

test('v1 legacy bucket preserves opaque hidden strings exactly', () => {
  const legacyDispositions = {
    'uncategorized:txn-1': 'hidden',
    'large_charge:txn-2': { disposition: 'snooze', until: '2099-01-01T00:00:00.000Z', at: '2026-07-01T00:00:00.000Z' },
  };
  for (let i = 0; i < 5998; i += 1) {
    legacyDispositions[`pending:txn-${i + 3}`] = i % 2 === 0 ? 'acknowledge' : 'hidden';
  }
  const migrated = normalizeReviewState({ schemaVersion: 1, dispositions: legacyDispositions });
  assert.equal(Object.keys(migrated.legacyDispositions).length, 6000);
  assert.equal(migrated.legacyDispositions['uncategorized:txn-1'], 'hidden');
  assert.equal(migrated.legacyDispositions['pending:txn-4'], 'hidden');
  const roundTrip = JSON.parse(JSON.stringify(migrated));
  assert.deepEqual(roundTrip.legacyDispositions, migrated.legacyDispositions);
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
