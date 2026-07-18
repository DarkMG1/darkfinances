'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const os = require('os');
const path = require('path');
const {
  REFERENCE_STEPS,
  rewriteTransactionDeletionReferences,
} = require('../lib/transaction-deletion-references');
const {
  canonicalTransactionSnapshot,
  createTransactionDeletionSaga,
  transactionDeletionFingerprint,
} = require('../lib/transaction-deletion-saga');

const original = Object.freeze({
  id: 'delete-parent',
  account: 'account',
  date: '2026-07-10',
  amount: -1000,
  payee: 'payee',
  notes: 'delete me',
  cleared: true,
  imported_id: null,
  imported_payee: null,
  category: null,
  is_parent: true,
  subtransactions: [
    {
      id: 'delete-leg-a',
      parent_id: 'delete-parent',
      amount: -400,
      category: 'category-a',
      notes: 'leg a',
      payee: 'payee-a',
    },
    {
      id: 'delete-leg-b',
      parent_id: 'delete-parent',
      amount: -600,
      category: 'category-b',
      notes: 'leg b',
      payee: 'payee-b',
    },
  ],
});

const unrelated = Object.freeze({
  id: 'unrelated-parent',
  account: 'account',
  date: original.date,
  amount: -1000,
  payee: original.payee,
  notes: original.notes,
  cleared: original.cleared,
  imported_id: null,
  imported_payee: null,
  category: 'unrelated-category',
  is_parent: false,
  subtransactions: [],
});

function writeJson(file, value) {
  fs.writeFileSync(file, `${JSON.stringify(value, null, 2)}\n`);
}

function readJson(file) {
  return JSON.parse(fs.readFileSync(file, 'utf8'));
}

function makeHarness({ applyThenThrowDelete = false } = {}) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'darkfinances-delete-faults-'));
  const paths = {
    actual: path.join(dir, 'actual.json'),
    effects: path.join(dir, 'effects.json'),
    sagas: path.join(dir, 'transaction-deletion-sagas.json'),
    receipts: path.join(dir, 'receipts.json'),
    receiptDir: path.join(dir, 'receipts'),
    links: path.join(dir, 'links.json'),
    suggestions: path.join(dir, 'suggestions.json'),
    reconciliation: path.join(dir, 'reconciliation.json'),
    phantomSeen: path.join(dir, 'phantom-seen.json'),
    reviewState: path.join(dir, 'review-state.json'),
  };
  fs.mkdirSync(paths.receiptDir);
  writeJson(paths.actual, {
    rows: [original, unrelated],
    accounts: [
      { id: 'account', name: 'Account', closed: false, offbudget: false },
      { id: 'closed-account', name: 'Closed', closed: true, offbudget: false },
      { id: 'offbudget-account', name: 'Off Budget', closed: false, offbudget: true },
    ],
    applyThenThrowDelete,
    deleteThrowFired: false,
    counts: { delete: 0, sync: 0 },
  });
  writeJson(paths.effects, { unlink: 0 });
  writeJson(paths.receipts, {
    schemaVersion: 1,
    unknown: { keep: true },
    byTxn: {
      [original.id]: [
        { id: 'deleted-only', txnId: original.id, file: 'deleted.jpg', auditAt: 'original' },
        { id: 'shared-target', txnId: original.id, file: 'shared.jpg' },
      ],
      [unrelated.id]: [
        { id: 'shared-survivor', txnId: unrelated.id, file: 'shared.jpg', legacy: null },
      ],
    },
  });
  fs.writeFileSync(path.join(paths.receiptDir, 'deleted.jpg'), 'deleted-only receipt bytes');
  fs.writeFileSync(path.join(paths.receiptDir, 'shared.jpg'), 'shared receipt bytes');
  writeJson(paths.links, {
    schemaVersion: 1,
    unknown: 'keep',
    links: [
      {
        inflow: { id: original.id, amount: 10 },
        expense: { id: unrelated.id, amount: -10 },
        amount: 10,
        createdAt: 'remove',
      },
      {
        inflow: null,
        expense: { id: unrelated.id, amount: -20 },
        amount: 20,
        createdAt: 'legacy-null',
      },
    ],
  });
  writeJson(paths.suggestions, {
    schemaVersion: 1,
    unknown: { keep: true },
    dismissed: [original.subtransactions[0].id, null, unrelated.id],
    confirmed: {
      [`sg_${original.id}`]: { inflowId: original.id, amount: 10, at: 'remove' },
      [`sg_${unrelated.id}`]: {
        inflowId: unrelated.id,
        amount: 20,
        at: 'keep',
        allocations: [
          { amount: 4, expense: { id: original.subtransactions[1].id, amount: -4 } },
          { amount: 16, expense: { id: 'other-expense', amount: -16 }, auditAt: 'keep' },
        ],
      },
      legacy: { inflowId: null, allocations: null, at: 'legacy-null' },
    },
  });
  writeJson(paths.reconciliation, {
    schemaVersion: 1,
    enabled: true,
    unknown: 'keep',
    months: {
      '2026-07': {
        done: true,
        doneAt: 'keep',
        items: {
          [original.id]: 'remove',
          [unrelated.id]: 'keep',
        },
      },
      legacy: null,
    },
  });
  writeJson(paths.phantomSeen, {
    schemaVersion: 1,
    unknown: 42,
    seen: {
      [original.subtransactions[0].id]: { firstSeen: 'remove' },
      [unrelated.id]: { firstSeen: 'keep', legacy: null },
    },
  });
  writeJson(paths.reviewState, {
    schemaVersion: 2,
    contentVersion: 1,
    dispositions: {
      [`uncategorized:id:${original.id}`]: {
        disposition: 'acknowledge',
        at: '2026-07-01T00:00:00.000Z',
        contentHash: 'a'.repeat(64),
        kind: 'uncategorized',
      },
    },
    legacyDispositions: {},
  });
  return { dir, paths };
}

function readStores(harness) {
  const { paths } = harness;
  return {
    receipts: readJson(paths.receipts),
    links: readJson(paths.links),
    suggestions: readJson(paths.suggestions),
    reconciliation: readJson(paths.reconciliation),
    phantomSeen: readJson(paths.phantomSeen),
    reviewState: readJson(paths.reviewState),
  };
}

function actualAdapter(harness) {
  const { paths } = harness;
  return {
    async getAccounts() {
      return structuredClone(readJson(paths.actual).accounts);
    },
    async getTransactions(accountId, start, end) {
      return readJson(paths.actual).rows
        .filter((row) => row.account === accountId && row.date >= start && row.date <= end)
        .map((row) => structuredClone(row));
    },
    async deleteTransaction(id) {
      const state = readJson(paths.actual);
      state.counts.delete += 1;
      state.rows = state.rows.filter((row) => String(row.id) !== String(id));
      const shouldThrow = state.applyThenThrowDelete && !state.deleteThrowFired;
      if (shouldThrow) state.deleteThrowFired = true;
      writeJson(paths.actual, state);
      if (shouldThrow) throw new Error('Actual delete response lost');
    },
    async sync() {
      const state = readJson(paths.actual);
      state.counts.sync += 1;
      writeJson(paths.actual, state);
    },
  };
}

function makeManager(harness, options = {}) {
  const { paths } = harness;
  const storePath = {
    receipts: paths.receipts,
    links: paths.links,
    suggestions: paths.suggestions,
    reconciliation: paths.reconciliation,
    phantomSeen: paths.phantomSeen,
    reviewState: paths.reviewState,
  };
  const plan = (targetIds) => {
    const result = rewriteTransactionDeletionReferences(readStores(harness), targetIds);
    for (const file of result.receiptFilesToDelete) {
      if (!file || path.basename(file) !== file) throw new Error('invalid receipt file reference');
    }
    return {
      stats: result.stats,
      receiptFilesToDelete: result.receiptFilesToDelete,
    };
  };
  return createTransactionDeletionSaga({
    sagaPath: paths.sagas,
    referenceSteps: REFERENCE_STEPS,
    planReferences: plan,
    applyReferenceStep(step, targetIds) {
      const current = readStores(harness);
      const next = rewriteTransactionDeletionReferences(current, targetIds).stores[step];
      if (JSON.stringify(current[step]) !== JSON.stringify(next)) writeJson(storePath[step], next);
    },
    referencesConverged(targetIds) {
      const current = readStores(harness);
      const next = rewriteTransactionDeletionReferences(current, targetIds);
      return REFERENCE_STEPS.every(
        (step) => JSON.stringify(current[step]) === JSON.stringify(next.stores[step]),
      );
    },
    receiptFileState(file) {
      if (!file || path.basename(file) !== file) throw new Error('invalid receipt file reference');
      const receipts = readJson(paths.receipts);
      const referenced = Object.values(receipts.byTxn)
        .some((list) => list.some((receipt) => receipt?.file === file));
      return {
        exists: fs.existsSync(path.join(paths.receiptDir, file)),
        referenced,
      };
    },
    unlinkReceiptFile(file) {
      const receipts = readJson(paths.receipts);
      const referenced = Object.values(receipts.byTxn)
        .some((list) => list.some((receipt) => receipt?.file === file));
      if (referenced) throw new Error('refusing to unlink a referenced receipt');
      const receiptPath = path.join(paths.receiptDir, file);
      if (fs.existsSync(receiptPath)) {
        fs.unlinkSync(receiptPath);
        const effects = readJson(paths.effects);
        effects.unlink += 1;
        writeJson(paths.effects, effects);
      }
    },
    ...options,
  });
}

function faultSchedule(rules) {
  const entries = rules.map((rule) => ({ mode: 'crash', ...rule, fired: false }));
  const injector = async (point) => {
    const entry = entries.find((candidate) => !candidate.fired && candidate.point === point);
    if (!entry) return;
    entry.fired = true;
    const message = entry.message || `injected fault at ${point}`;
    const error = new Error(message);
    if (entry.mode === 'crash') error.sagaInterruption = true;
    throw error;
  };
  injector.entries = entries;
  return injector;
}

function sagaState(harness) {
  if (!fs.existsSync(harness.paths.sagas)) return { schemaVersion: 1, sagas: {} };
  return readJson(harness.paths.sagas);
}

function latestSaga(harness) {
  return Object.values(sagaState(harness).sagas)
    .sort((left, right) => String(right.updatedAt).localeCompare(String(left.updatedAt)))[0] || null;
}

function actualState(harness) {
  return readJson(harness.paths.actual);
}

function fileState(harness) {
  return Object.fromEntries(
    fs.readdirSync(harness.paths.receiptDir)
      .sort()
      .map((file) => [file, fs.readFileSync(path.join(harness.paths.receiptDir, file), 'utf8')]),
  );
}

function assertNoDeletedReferences(harness) {
  const current = readStores(harness);
  const rewritten = rewriteTransactionDeletionReferences(current, [
    original.id,
    ...original.subtransactions.map((leg) => leg.id),
  ]);
  for (const step of REFERENCE_STEPS) assert.deepEqual(current[step], rewritten.stores[step]);
}

function assertUnrelatedEvidence(harness) {
  const stores = readStores(harness);
  assert.deepEqual(stores.receipts.unknown, { keep: true });
  assert.deepEqual(stores.receipts.byTxn[unrelated.id], [
    { id: 'shared-survivor', txnId: unrelated.id, file: 'shared.jpg', legacy: null },
  ]);
  assert.deepEqual(stores.links, {
    schemaVersion: 1,
    unknown: 'keep',
    links: [{
      inflow: null,
      expense: { id: unrelated.id, amount: -20 },
      amount: 20,
      createdAt: 'legacy-null',
    }],
  });
  assert.deepEqual(stores.suggestions.dismissed, [null, unrelated.id]);
  assert.deepEqual(stores.suggestions.confirmed[`sg_${unrelated.id}`], {
    inflowId: unrelated.id,
    amount: 20,
    at: 'keep',
    allocations: [
      { amount: 16, expense: { id: 'other-expense', amount: -16 }, auditAt: 'keep' },
    ],
  });
  assert.deepEqual(stores.suggestions.confirmed.legacy, {
    inflowId: null,
    allocations: null,
    at: 'legacy-null',
  });
  assert.equal(stores.reconciliation.months['2026-07'].doneAt, 'keep');
  assert.deepEqual(stores.reconciliation.months['2026-07'].items, {
    [unrelated.id]: 'keep',
  });
  assert.equal(stores.reconciliation.months.legacy, null);
  assert.deepEqual(stores.phantomSeen.seen, {
    [unrelated.id]: { firstSeen: 'keep', legacy: null },
  });
  assert.equal(stores.phantomSeen.unknown, 42);
}

function assertUntouched(harness, before) {
  assert.deepEqual(actualState(harness), before.actual);
  assert.deepEqual(readStores(harness), before.stores);
  assert.deepEqual(fileState(harness), before.files);
  assert.equal(Object.keys(sagaState(harness).sagas).length, 0);
}

function assertCompleted(harness) {
  const actual = actualState(harness);
  const targetIds = new Set([original.id, ...original.subtransactions.map((leg) => leg.id)]);
  const liveIds = actual.rows.flatMap((row) => [
    String(row.id),
    ...(row.subtransactions || []).map((leg) => String(leg.id)),
  ]);
  assert.ok(liveIds.every((id) => !targetIds.has(id)), 'parent and every leg are absent');
  assert.equal(actual.rows.filter((row) => row.id === unrelated.id).length, 1);
  assertNoDeletedReferences(harness);
  assertUnrelatedEvidence(harness);
  assert.deepEqual(fileState(harness), { 'shared.jpg': 'shared receipt bytes' });
  const saga = latestSaga(harness);
  assert.equal(saga.phase, 'completed');
  assert.equal(saga.auditOutcome.outcome, 'deleted');
  assert.equal(saga.auditOutcome.parentId, original.id);
  assert.deepEqual(saga.auditOutcome.legIds, original.subtransactions.map((leg) => leg.id));
  assert.equal(saga.lastError, null);
}

async function beginDelete(harness, faultInjector) {
  return makeManager(harness).remove(actualAdapter(harness), {
    accountId: 'account',
    date: original.date,
    transaction: structuredClone(original),
    faultInjector,
  });
}

async function recoverRepeatedly(harness, faultInjector) {
  for (let attempt = 0; attempt < 3; attempt += 1) {
    try {
      await makeManager(harness).recover(actualAdapter(harness), { faultInjector });
    } catch (_) {}
  }
  await makeManager(harness).recover(actualAdapter(harness));
  const before = {
    actual: actualState(harness),
    saga: sagaState(harness),
    effects: readJson(harness.paths.effects),
  };
  await makeManager(harness).recover(actualAdapter(harness));
  await makeManager(harness).recover(actualAdapter(harness));
  assert.deepEqual(actualState(harness), before.actual, 'terminal recovery does no Actual work');
  assert.deepEqual(sagaState(harness), before.saga, 'terminal recovery does not rewrite saga state');
  assert.deepEqual(readJson(harness.paths.effects), before.effects, 'terminal recovery does not unlink again');
}

const localBoundaries = [
  'initial-saga-write',
  'delete-intent-checkpoint',
  'delete-revalidation',
  'actual-deletion',
  'delete-verification',
  'actual-deleted-checkpoint',
  'post-delete-verification',
  'reference-plan-checkpoint',
  ...REFERENCE_STEPS.flatMap((step) => [
    `reference-${step}-pending-checkpoint`,
    `reference-${step}-write`,
    `reference-${step}-checkpoint`,
  ]),
  'references-deleted-checkpoint',
  'pre-sync-verification',
  'sync-pending-checkpoint',
];

const syncedBoundaries = [
  'sync',
  'post-sync-verification',
  'receipt-cleanup-checkpoint',
  'receipt-0-pending-checkpoint',
  'receipt-0-unlink',
  'receipt-0-checkpoint',
  'saga-terminal-write',
];

test('deletion converges across every local durable boundary', async (t) => {
  for (const boundary of localBoundaries) {
    for (const side of ['before', 'after']) {
      await t.test(`${side}:${boundary}`, async () => {
        const harness = makeHarness();
        t.after(() => fs.rmSync(harness.dir, { recursive: true, force: true }));
        const before = {
          actual: actualState(harness),
          stores: readStores(harness),
          files: fileState(harness),
        };
        const injector = faultSchedule([{ point: `${side}:${boundary}` }]);
        await assert.rejects(beginDelete(harness, injector));
        assert.ok(injector.entries.every((entry) => entry.fired), 'fault boundary was reached');
        if (boundary === 'initial-saga-write' && side === 'before') {
          assertUntouched(harness, before);
          await makeManager(harness).recover(actualAdapter(harness));
          assertUntouched(harness, before);
          return;
        }
        assert.ok(fs.existsSync(path.join(harness.paths.receiptDir, 'deleted.jpg')));
        await recoverRepeatedly(harness, injector);
        assertCompleted(harness);
      });
    }
  }
});

test('deletion converges across sync, receipt cleanup, and terminal boundaries', async (t) => {
  for (const boundary of syncedBoundaries) {
    for (const side of ['before', 'after']) {
      await t.test(`${side}:${boundary}`, async () => {
        const harness = makeHarness();
        t.after(() => fs.rmSync(harness.dir, { recursive: true, force: true }));
        await beginDelete(harness);
        assert.equal(latestSaga(harness).phase, 'sync_pending');
        assert.ok(fs.existsSync(path.join(harness.paths.receiptDir, 'deleted.jpg')));
        const injector = faultSchedule([{ point: `${side}:${boundary}` }]);
        await assert.rejects(
          makeManager(harness).recover(actualAdapter(harness), { faultInjector: injector }),
        );
        assert.ok(injector.entries.every((entry) => entry.fired), 'fault boundary was reached');
        await recoverRepeatedly(harness, injector);
        assertCompleted(harness);
      });
    }
  }
});

test('receipt bytes remain until sync succeeds', async (t) => {
  const harness = makeHarness();
  t.after(() => fs.rmSync(harness.dir, { recursive: true, force: true }));
  await beginDelete(harness);
  assert.equal(actualState(harness).counts.sync, 0);
  assert.equal(latestSaga(harness).phase, 'sync_pending');
  assert.ok(fs.existsSync(path.join(harness.paths.receiptDir, 'deleted.jpg')));
  assert.ok(fs.existsSync(path.join(harness.paths.receiptDir, 'shared.jpg')));
  assertNoDeletedReferences(harness);

  await makeManager(harness).recover(actualAdapter(harness));
  assertCompleted(harness);
  assert.equal(actualState(harness).counts.sync, 1);
});

test('apply-then-throw Actual deletion is verified by exact saved id and not repeated', async (t) => {
  const harness = makeHarness({ applyThenThrowDelete: true });
  t.after(() => fs.rmSync(harness.dir, { recursive: true, force: true }));
  await assert.rejects(beginDelete(harness), /response lost/);
  assert.equal(actualState(harness).counts.delete, 1);
  assert.equal(latestSaga(harness).phase, 'delete_pending');
  await recoverRepeatedly(harness);
  assert.equal(actualState(harness).counts.delete, 1);
  assertCompleted(harness);
});

test('a failed sync leaves sync_pending and receipt bytes intact', async (t) => {
  const harness = makeHarness();
  t.after(() => fs.rmSync(harness.dir, { recursive: true, force: true }));
  await beginDelete(harness);
  const api = actualAdapter(harness);
  api.sync = async () => {
    const state = readJson(harness.paths.actual);
    state.counts.sync += 1;
    writeJson(harness.paths.actual, state);
    throw new Error('sync unavailable');
  };
  await assert.rejects(makeManager(harness).recover(api), /sync unavailable/);
  assert.equal(latestSaga(harness).phase, 'sync_pending');
  assert.ok(fs.existsSync(path.join(harness.paths.receiptDir, 'deleted.jpg')));
  await recoverRepeatedly(harness);
  assertCompleted(harness);
});

test('one failed saga does not strand an independent sync-ready deletion', async (t) => {
  const harness = makeHarness();
  t.after(() => fs.rmSync(harness.dir, { recursive: true, force: true }));
  await beginDelete(harness);

  const state = sagaState(harness);
  const ready = Object.values(state.sagas)[0];
  const staleSnapshot = canonicalTransactionSnapshot({ ...unrelated, amount: -999 });
  state.sagas.blocked = {
    id: 'blocked',
    recordVersion: 1,
    status: 'started',
    phase: 'delete_pending',
    accountId: 'account',
    date: unrelated.date,
    target: {
      parentId: unrelated.id,
      legIds: [],
      ids: [unrelated.id],
      snapshot: staleSnapshot,
      fingerprint: transactionDeletionFingerprint(staleSnapshot),
    },
    startedAt: '2026-07-10T00:00:00.000Z',
    updatedAt: '2026-07-10T00:00:00.000Z',
  };
  writeJson(harness.paths.sagas, state);

  await assert.rejects(
    makeManager(harness).recover(actualAdapter(harness)),
    /financial shape changed/,
  );

  const recovered = sagaState(harness).sagas;
  assert.equal(recovered[ready.id].phase, 'completed');
  assert.equal(recovered.blocked.phase, 'delete_pending');
  assert.equal(actualState(harness).counts.sync, 1);
  assert.equal(fs.existsSync(path.join(harness.paths.receiptDir, 'deleted.jpg')), false);
  assert.equal(fs.existsSync(path.join(harness.paths.receiptDir, 'shared.jpg')), true);
});

test('post-sync terminalization continues past an independent invalid saga', async (t) => {
  const harness = makeHarness();
  t.after(() => fs.rmSync(harness.dir, { recursive: true, force: true }));
  await beginDelete(harness);

  const state = sagaState(harness);
  const ready = Object.values(state.sagas)[0];
  const snapshot = canonicalTransactionSnapshot(unrelated);
  const blocked = {
    id: 'blocked',
    recordVersion: 1,
    status: 'started',
    phase: 'sync_pending',
    accountId: 'account',
    date: unrelated.date,
    target: {
      parentId: unrelated.id,
      legIds: [],
      ids: [unrelated.id],
      snapshot,
      fingerprint: transactionDeletionFingerprint(snapshot),
    },
    referencePlan: {
      version: 1,
      targetIds: [unrelated.id],
      steps: [...REFERENCE_STEPS],
      completedSteps: [...REFERENCE_STEPS],
      stats: {
        receipts: 0,
        links: 0,
        suggestions: 0,
        reconciliation: 0,
        phantomSeen: 0,
        reviewState: 0,
      },
      receiptFiles: [],
    },
    startedAt: '2026-07-10T00:00:00.000Z',
    updatedAt: '2026-07-10T00:00:00.000Z',
  };
  writeJson(harness.paths.sagas, {
    schemaVersion: 1,
    sagas: { blocked, [ready.id]: ready },
  });

  await assert.rejects(
    makeManager(harness).markSynced(actualAdapter(harness)),
    /checkpointed transaction ids remain present/,
  );

  const recovered = sagaState(harness).sagas;
  assert.equal(recovered.blocked.phase, 'sync_pending');
  assert.equal(recovered[ready.id].phase, 'completed');
  assert.equal(actualState(harness).counts.sync, 0);
  assert.equal(fs.existsSync(path.join(harness.paths.receiptDir, 'deleted.jpg')), false);
  assert.equal(fs.existsSync(path.join(harness.paths.receiptDir, 'shared.jpg')), true);
});

test('changed financial shape after admission fails closed without deleting', async (t) => {
  const harness = makeHarness();
  t.after(() => fs.rmSync(harness.dir, { recursive: true, force: true }));
  const fault = faultSchedule([{ point: 'after:initial-saga-write' }]);
  await assert.rejects(beginDelete(harness, fault));
  const actual = actualState(harness);
  actual.rows.find((row) => row.id === original.id).amount = -999;
  writeJson(harness.paths.actual, actual);

  await assert.rejects(
    makeManager(harness).recover(actualAdapter(harness)),
    /financial shape changed/,
  );
  assert.equal(actualState(harness).counts.delete, 0);
  assert.equal(latestSaga(harness).phase, 'delete_pending');
  assert.ok(fs.existsSync(path.join(harness.paths.receiptDir, 'deleted.jpg')));
});

test('an exact transaction moved to another date remains owned and untouched', async (t) => {
  const harness = makeHarness();
  t.after(() => fs.rmSync(harness.dir, { recursive: true, force: true }));
  const before = {
    stores: readStores(harness),
    files: fileState(harness),
  };
  const fault = faultSchedule([{ point: 'after:initial-saga-write' }]);
  await assert.rejects(beginDelete(harness, fault));

  const actual = actualState(harness);
  actual.rows.find((row) => row.id === original.id).date = '2026-07-11';
  writeJson(harness.paths.actual, actual);

  for (let attempt = 0; attempt < 3; attempt += 1) {
    await assert.rejects(
      makeManager(harness).recover(actualAdapter(harness)),
      /financial shape changed/,
    );
  }

  const recovered = actualState(harness);
  assert.equal(recovered.counts.delete, 0);
  assert.equal(recovered.counts.sync, 0);
  assert.equal(recovered.rows.find((row) => row.id === original.id).date, '2026-07-11');
  assert.equal(latestSaga(harness).phase, 'delete_pending');
  assert.deepEqual(readStores(harness), before.stores);
  assert.deepEqual(fileState(harness), before.files);
});

test('a split deletion target moved to a closed account fails closed with all evidence intact', async (t) => {
  const harness = makeHarness();
  t.after(() => fs.rmSync(harness.dir, { recursive: true, force: true }));
  const before = {
    stores: readStores(harness),
    files: fileState(harness),
  };
  const fault = faultSchedule([{ point: 'after:initial-saga-write' }]);
  await assert.rejects(beginDelete(harness, fault));

  const actual = actualState(harness);
  actual.rows.find((row) => row.id === original.id).account = 'closed-account';
  writeJson(harness.paths.actual, actual);

  for (let attempt = 0; attempt < 3; attempt += 1) {
    await assert.rejects(
      makeManager(harness).recover(actualAdapter(harness)),
      /ids found outside deletion account: delete-leg-a,delete-leg-b,delete-parent/,
    );
  }

  const recovered = actualState(harness);
  const moved = recovered.rows.find((row) => row.id === original.id);
  assert.equal(moved.account, 'closed-account');
  assert.deepEqual(moved.subtransactions.map((leg) => leg.id), ['delete-leg-a', 'delete-leg-b']);
  assert.equal(recovered.counts.delete, 0);
  assert.equal(recovered.counts.sync, 0);
  assert.equal(latestSaga(harness).phase, 'delete_pending');
  assert.deepEqual(readStores(harness), before.stores);
  assert.deepEqual(fileState(harness), before.files);
});

test('a checkpointed split leg outside the deletion account blocks absent-parent cleanup', async (t) => {
  const harness = makeHarness();
  t.after(() => fs.rmSync(harness.dir, { recursive: true, force: true }));
  const before = {
    stores: readStores(harness),
    files: fileState(harness),
  };
  const fault = faultSchedule([{ point: 'after:initial-saga-write' }]);
  await assert.rejects(beginDelete(harness, fault));

  const actual = actualState(harness);
  actual.rows = actual.rows.filter((row) => row.id !== original.id);
  actual.rows.push({
    ...structuredClone(unrelated),
    id: 'foreign-parent',
    account: 'offbudget-account',
    subtransactions: [{
      ...structuredClone(original.subtransactions[0]),
      parent_id: 'foreign-parent',
    }],
  });
  writeJson(harness.paths.actual, actual);

  await assert.rejects(
    makeManager(harness).recover(actualAdapter(harness)),
    /ids found outside deletion account: delete-leg-a/,
  );
  assert.equal(actualState(harness).counts.delete, 0);
  assert.equal(latestSaga(harness).phase, 'delete_pending');
  assert.deepEqual(readStores(harness), before.stores);
  assert.deepEqual(fileState(harness), before.files);
});

test('an unrelated cross-account financial lookalike never substitutes for durable ids', async (t) => {
  const harness = makeHarness();
  t.after(() => fs.rmSync(harness.dir, { recursive: true, force: true }));
  const fault = faultSchedule([{ point: 'after:initial-saga-write' }]);
  await assert.rejects(beginDelete(harness, fault));

  const lookalike = structuredClone(original);
  lookalike.id = 'foreign-lookalike';
  lookalike.account = 'closed-account';
  lookalike.subtransactions = lookalike.subtransactions.map((leg, index) => ({
    ...leg,
    id: `foreign-lookalike-leg-${index + 1}`,
    parent_id: lookalike.id,
  }));
  const actual = actualState(harness);
  actual.rows.push(lookalike);
  writeJson(harness.paths.actual, actual);

  await recoverRepeatedly(harness);
  assertCompleted(harness);
  assert.deepEqual(
    actualState(harness).rows.find((row) => row.id === lookalike.id),
    lookalike,
  );
});

test('account enumeration and cross-account query failures leave deletion nonterminal', async (t) => {
  for (const failure of ['enumeration', 'query']) {
    await t.test(failure, async () => {
      const harness = makeHarness();
      t.after(() => fs.rmSync(harness.dir, { recursive: true, force: true }));
      const before = {
        stores: readStores(harness),
        files: fileState(harness),
      };
      const fault = faultSchedule([{ point: 'after:initial-saga-write' }]);
      await assert.rejects(beginDelete(harness, fault));
      const api = actualAdapter(harness);
      if (failure === 'enumeration') {
        api.getAccounts = async () => { throw new Error('enumeration unavailable'); };
      } else {
        const query = api.getTransactions;
        api.getTransactions = async (accountId, start, end) => {
          if (accountId === 'closed-account') throw new Error('closed account unavailable');
          return query(accountId, start, end);
        };
      }

      for (let attempt = 0; attempt < 2; attempt += 1) {
        await assert.rejects(
          makeManager(harness).recover(api),
          failure === 'enumeration'
            ? /unable to enumerate Actual accounts/
            : /unable to query Actual account closed-account/,
        );
      }
      const recovered = actualState(harness);
      assert.equal(recovered.counts.delete, 0);
      assert.equal(recovered.counts.sync, 0);
      assert.equal(latestSaga(harness).phase, 'delete_pending');
      assert.deepEqual(readStores(harness), before.stores);
      assert.deepEqual(fileState(harness), before.files);
    });
  }
});

test('a same-date financial decoy never substitutes for absent checkpointed ids', async (t) => {
  const harness = makeHarness();
  t.after(() => fs.rmSync(harness.dir, { recursive: true, force: true }));
  const fault = faultSchedule([{ point: 'after:initial-saga-write' }]);
  await assert.rejects(beginDelete(harness, fault));

  const decoy = structuredClone(original);
  decoy.id = 'same-date-decoy';
  decoy.subtransactions = decoy.subtransactions.map((leg, index) => ({
    ...leg,
    id: `same-date-decoy-leg-${index + 1}`,
    parent_id: decoy.id,
  }));
  const actual = actualState(harness);
  actual.rows = [decoy, unrelated];
  writeJson(harness.paths.actual, actual);

  await recoverRepeatedly(harness);
  assertCompleted(harness);
  const recovered = actualState(harness);
  assert.equal(recovered.counts.delete, 0);
  assert.equal(recovered.rows.some((row) => row.id === decoy.id), true);
  assert.equal(recovered.rows.some((row) => row.id === original.id), false);
});

test('active deletion ownership blocks parent and legs but terminal and unrelated records do not', () => {
  const harness = makeHarness();
  try {
    writeJson(harness.paths.sagas, {
      schemaVersion: 1,
      sagas: {
        active: {
          id: 'active',
          recordVersion: 1,
          phase: 'references_pending',
          status: 'started',
          accountId: 'account',
          target: {
            parentId: original.id,
            legIds: original.subtransactions.map((leg) => leg.id),
            ids: [original.id, ...original.subtransactions.map((leg) => leg.id)],
          },
        },
        terminal: {
          id: 'terminal',
          recordVersion: 1,
          phase: 'completed',
          status: 'completed',
          accountId: 'account',
          target: { parentId: 'terminal-id', legIds: [], ids: ['terminal-id'] },
        },
      },
    });
    const manager = makeManager(harness);
    for (const id of [original.id, ...original.subtransactions.map((leg) => leg.id)]) {
      assert.throws(
        () => manager.assertAvailable({ accountId: 'account', ids: [id] }),
        (error) => error.code === 'TRANSACTION_DELETION_IN_PROGRESS' && error.status === 409,
      );
    }
    assert.doesNotThrow(
      () => manager.assertAvailable({ accountId: 'account', ids: ['unrelated-id'] }),
    );
    assert.doesNotThrow(
      () => manager.assertAvailable({ accountId: 'account', ids: ['terminal-id'] }),
    );
    assert.doesNotThrow(
      () => manager.assertAvailable({ accountId: 'other-account', ids: [original.id] }),
    );
  } finally {
    fs.rmSync(harness.dir, { recursive: true, force: true });
  }
});

test('nonterminal records survive pruning beyond one hundred terminal outcomes', async (t) => {
  const harness = makeHarness();
  t.after(() => fs.rmSync(harness.dir, { recursive: true, force: true }));
  const sagas = {
    retained: {
      id: 'retained',
      recordVersion: 1,
      phase: 'delete_pending',
      status: 'started',
      accountId: 'other-account',
      target: { parentId: 'retained-parent', legIds: [], ids: ['retained-parent'] },
      updatedAt: '2000-01-01T00:00:00.000Z',
    },
  };
  for (let index = 0; index < 105; index += 1) {
    const id = `terminal-${index}`;
    sagas[id] = {
      id,
      recordVersion: 1,
      phase: 'completed',
      status: 'completed',
      accountId: 'other-account',
      target: { parentId: id, legIds: [], ids: [id] },
      terminalAt: new Date(Date.UTC(2026, 0, 1, 0, 0, index)).toISOString(),
      updatedAt: new Date(Date.UTC(2026, 0, 1, 0, 0, index)).toISOString(),
    };
  }
  writeJson(harness.paths.sagas, { schemaVersion: 1, sagas });
  const fault = faultSchedule([{ point: 'after:initial-saga-write' }]);
  await assert.rejects(beginDelete(harness, fault));
  const state = sagaState(harness);
  assert.ok(state.sagas.retained, 'old nonterminal record survives');
  assert.ok(latestSaga(harness), 'new nonterminal record survives');
  assert.equal(
    Object.values(state.sagas).filter((saga) => saga.phase === 'completed').length,
    100,
  );
});

test('persisted deletion errors are bounded and redact credentials', async (t) => {
  const harness = makeHarness();
  t.after(() => fs.rmSync(harness.dir, { recursive: true, force: true }));
  const secret = 'super-secret-value';
  const fault = faultSchedule([{
    point: 'before:actual-deletion',
    mode: 'error',
    message: `Bearer ${secret} password=${secret} token=${secret} ${'x'.repeat(500)}`,
  }]);
  await assert.rejects(beginDelete(harness, fault));
  const stored = latestSaga(harness).lastError;
  assert.ok(stored.message.length <= 160);
  assert.doesNotMatch(JSON.stringify(stored), new RegExp(secret));
  assert.match(stored.message, /\[redacted\]/);
});
