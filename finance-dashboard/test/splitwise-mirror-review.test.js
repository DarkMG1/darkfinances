'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const os = require('os');
const path = require('path');
const { startSplitwiseHttpServer } = require('./helpers/splitwise-http-ephemeral-server');
const { categoryIdentityFingerprint } = require('../lib/bulk-operation-fingerprint');
const {
  verifyCreateMirrorIdentity,
  mirrorIntentFromItem,
  mirrorIdentityFingerprint,
  durableImportedId,
  owesSnapshotMaxAgeMs,
  snapshotBinding,
  validateReviewedDuplicateLiveState,
  observedDuplicateSet,
  SplitwiseMirrorAmbiguousError,
  SplitwiseMirrorAdmissionError,
  SplitwiseMirrorSnapshotError,
  DEFAULT_OWES_SNAPSHOT_MAX_AGE_MS,
} = require('../lib/splitwise-mirror');
const {
  BulkOperationOutcomeUnknownError,
  BulkOperationStateError,
  createBulkOperationSaga,
} = require('../lib/bulk-operation-saga');
const { classifyOwesTruth, validateSplitwiseMirrorSnapshot } = require('../dataModule');

class SagaInterruption extends Error {
  constructor(message) {
    super(message);
    this.name = 'SagaInterruption';
  }
}

const ENV_KEYS = [
  'OWES_TRUTH_PATH',
  'SPLITWISE_MIRROR_RESOLUTIONS_PATH',
  'BULK_OPERATION_SAGAS_PATH',
  'TRANSACTION_DELETION_SAGAS_PATH',
  'PERSONAL_CONFIG_PATH',
  'OWES_SNAPSHOT_MAX_AGE_MS',
  'SPLITWISE_CURRENCY',
  'ACTUAL_API_PATH',
];

const savedBaselineEnv = Object.fromEntries(ENV_KEYS.map((key) => [key, process.env[key]]));
const nowIso = '2026-07-10T02:30:00.000Z';
const today = '2026-07-10';

function restoreBaselineEnv() {
  for (const key of ENV_KEYS) {
    const value = savedBaselineEnv[key];
    if (value === undefined) delete process.env[key];
    else process.env[key] = value;
  }
}

function faultSchedule(entries) {
  const queue = entries.map((entry) => ({ ...entry, fired: false }));
  const injector = async (point, context) => {
    const entry = queue.find((candidate) => !candidate.fired && candidate.point === point);
    if (!entry) return;
    entry.fired = true;
    if (typeof entry.hook === 'function') await entry.hook(context);
    if (entry.hookOnly) return;
    if (entry.mode === 'error') throw new Error(entry.message || `injected error at ${point}`);
    throw new SagaInterruption(`injected crash at ${point}`);
  };
  injector.queue = queue;
  return injector;
}

function writeJson(file, value) {
  fs.writeFileSync(file, `${JSON.stringify(value, null, 2)}\n`);
}

function readJson(file) {
  return JSON.parse(fs.readFileSync(file, 'utf8'));
}

function completeSnapshot(items = [], generatedAt = new Date().toISOString()) {
  return {
    schemaVersion: 2,
    source: 'splitwise-pairwise-test',
    generatedAt,
    manifest: {
      complete: true,
      itemizedComplete: true,
      resolvedEvents: 0,
      expectedEvents: 0,
      failedEvents: [],
      currency: 'USD',
    },
    othersPaidItems: items,
  };
}

function makeHarness({
  rows = [],
  snapshot = completeSnapshot(),
  resolutions = { schemaVersion: 1, resolutions: [] },
  accounts,
  categoryGroups,
} = {}) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'darkfinances-splitwise-review-'));
  const paths = {
    owesTruth: path.join(dir, 'owes-truth.json'),
    resolutions: path.join(dir, 'splitwise-mirror-resolutions.json'),
    bulk: path.join(dir, 'bulk-operation-sagas.json'),
    deletion: path.join(dir, 'transaction-deletion-sagas.json'),
  };
  process.env.OWES_TRUTH_PATH = paths.owesTruth;
  process.env.SPLITWISE_MIRROR_RESOLUTIONS_PATH = paths.resolutions;
  process.env.BULK_OPERATION_SAGAS_PATH = paths.bulk;
  process.env.TRANSACTION_DELETION_SAGAS_PATH = paths.deletion;
  process.env.PERSONAL_CONFIG_PATH = path.join(dir, 'personal.json');
  process.env.OWES_SNAPSHOT_MAX_AGE_MS = String(7 * 24 * 60 * 60 * 1000);
  process.env.ACTUAL_API_PATH = path.join(__dirname, 'fixtures', 'deletion-actual.js');

  writeJson(paths.owesTruth, snapshot);
  writeJson(paths.resolutions, resolutions);
  writeJson(paths.bulk, { schemaVersion: 1, sagas: {} });
  writeJson(paths.deletion, { schemaVersion: 1, sagas: {} });

  const fakeActual = require('./fixtures/deletion-actual');
  fakeActual.configure({
    rows: structuredClone(rows),
    accounts: accounts || [{
      id: 'splitwise-account',
      name: 'Splitwise',
      closed: false,
      offbudget: false,
    }],
    categoryGroups: categoryGroups || [{
      id: 'spending',
      name: 'Spending',
      is_income: false,
      categories: [{ id: 'splitwise-category', name: 'Splitwise' }],
    }],
  });

  delete require.cache[require.resolve('../dataModule')];
  const data = require('../dataModule');

  return {
    data,
    fakeActual,
    paths,
    dir,
    cleanup() {
      fs.rmSync(dir, { recursive: true, force: true });
    },
  };
}

function standardCreateHarness() {
  return makeHarness({
    snapshot: completeSnapshot([{ id: '880', myShare: 3.25, date: today, desc: 'sweep item' }]),
  });
}

test.after(() => {
  restoreBaselineEnv();
});

test('greenfield account create survives add-then-throw restart without divergent intent', async () => {
  const harness = makeHarness({
    snapshot: completeSnapshot([{ id: '901', myShare: 4.5, date: today, desc: 'greenfield expense' }]),
    accounts: [{ id: 'checking', name: 'Checking', closed: false, offbudget: false }],
    categoryGroups: [{
      id: 'spending',
      name: 'Spending',
      is_income: false,
      categories: [{ id: 'splitwise-category', name: 'Splitwise' }],
    }],
  });
  await harness.data.initApi();
  const faultInjector = faultSchedule([{ point: 'after:item-2-effect' }]);
  await assert.rejects(
    harness.data.syncSplitwiseShareExpenses({ sync: false, faultInjector }),
    (error) => error.name === 'SagaInterruption',
  );
  assert.equal(harness.fakeActual.inspect().counts.add, 1);
  const createdId = harness.fakeActual.inspect().rows[0].id;
  const result = await harness.data.syncSplitwiseShareExpenses({ sync: false });
  assert.equal(result.created, 1);
  assert.equal(harness.fakeActual.inspect().counts.add, 1);
  assert.equal(harness.fakeActual.inspect().rows[0].id, createdId);
  assert.match(harness.fakeActual.inspect().rows[0].notes, /#sw-901/);
  harness.cleanup();
});

test('greenfield category create restart assigns bootstrapped category id', async () => {
  const harness = makeHarness({
    snapshot: completeSnapshot([{ id: '902', myShare: 2, date: today, desc: 'needs category' }]),
    categoryGroups: [{
      id: 'spending',
      name: 'Spending',
      is_income: false,
      categories: [{ id: 'food', name: 'Food' }],
    }],
  });
  await harness.data.initApi();
  const faultInjector = faultSchedule([{ point: 'after:item-2-effect' }]);
  await assert.rejects(
    harness.data.syncSplitwiseShareExpenses({ sync: false, faultInjector }),
    (error) => error.name === 'SagaInterruption',
  );
  const categoryId = harness.fakeActual.inspect().categoryGroups
    .flatMap((group) => group.categories || [])
    .find((category) => category.name === 'Splitwise')?.id;
  assert.ok(categoryId);
  await harness.data.syncSplitwiseShareExpenses({ sync: false });
  const row = harness.fakeActual.inspect().rows.find((entry) => /#sw-902/.test(entry.notes || ''));
  assert.ok(row);
  assert.equal(row.category, categoryId);
  harness.cleanup();
});

test('bootstrap account TOCTOU duplicate names fail closed as outcome unknown', async () => {
  const harness = makeHarness({ snapshot: completeSnapshot([]), accounts: [] });
  await harness.data.initApi();
  const faultInjector = faultSchedule([{
    point: 'before:item-0-bootstrap-admission',
    hookOnly: true,
    hook: () => {
      harness.fakeActual.configure({
        rows: [],
        accounts: [
          { id: 'sw-a', name: 'Splitwise', closed: false, offbudget: false },
          { id: 'sw-b', name: 'Splitwise', closed: false, offbudget: false },
        ],
        categoryGroups: [{
          id: 'spending',
          name: 'Spending',
          is_income: false,
          categories: [{ id: 'food', name: 'Food' }],
        }],
      });
    },
  }]);
  await assert.rejects(
    harness.data.syncSplitwiseShareExpenses({ sync: false, faultInjector }),
    (error) => error instanceof BulkOperationOutcomeUnknownError
      && error.code === 'BULK_OPERATION_OUTCOME_UNKNOWN',
  );
  harness.cleanup();
});

test('bootstrap account duplicate injected at before-effect creates no third account', async () => {
  const harness = makeHarness({ snapshot: completeSnapshot([]), accounts: [] });
  await harness.data.initApi();
  const baselineCreateAccount = harness.fakeActual.inspect().counts.createAccount;
  const faultInjector = faultSchedule([{
    point: 'before:item-0-effect',
    hookOnly: true,
    hook: () => {
      harness.fakeActual.configure({
        preserveCounts: true,
        rows: harness.fakeActual.inspect().rows,
        categoryGroups: harness.fakeActual.inspect().categoryGroups,
        accounts: [
          { id: 'sw-a', name: 'Splitwise', closed: false, offbudget: false },
          { id: 'sw-b', name: 'Splitwise', closed: false, offbudget: false },
        ],
      });
    },
  }]);
  await assert.rejects(
    harness.data.syncSplitwiseShareExpenses({ sync: false, faultInjector }),
    (error) => error instanceof BulkOperationOutcomeUnknownError
      && error.code === 'BULK_OPERATION_OUTCOME_UNKNOWN',
  );
  assert.equal(harness.fakeActual.inspect().counts.createAccount, baselineCreateAccount);
  assert.equal(
    harness.fakeActual.inspect().accounts.filter((account) => account.name === 'Splitwise').length,
    2,
  );
  harness.cleanup();
});

test('bootstrap category TOCTOU duplicate names fail closed as outcome unknown', async () => {
  const harness = makeHarness({ snapshot: completeSnapshot([]) });
  await harness.data.initApi();
  const faultInjector = faultSchedule([{
    point: 'before:item-1-bootstrap-admission',
    hookOnly: true,
    hook: () => {
      harness.fakeActual.configure({
        rows: [],
        accounts: [{
          id: 'splitwise-account',
          name: 'Splitwise',
          closed: false,
          offbudget: false,
        }],
        categoryGroups: [
          {
            id: 'spending',
            name: 'Spending',
            is_income: false,
            categories: [{ id: 'splitwise-a', name: 'Splitwise' }],
          },
          {
            id: 'other',
            name: 'Other',
            is_income: false,
            categories: [{ id: 'splitwise-b', name: 'Splitwise' }],
          },
        ],
      });
    },
  }]);
  await assert.rejects(
    harness.data.syncSplitwiseShareExpenses({ sync: false, faultInjector }),
    (error) => error instanceof BulkOperationOutcomeUnknownError
      && error.code === 'BULK_OPERATION_OUTCOME_UNKNOWN',
  );
  harness.cleanup();
});

test('bootstrap category duplicate injected at before-effect creates no third category', async () => {
  const harness = makeHarness({
    snapshot: completeSnapshot([]),
    categoryGroups: [{
      id: 'spending',
      name: 'Spending',
      is_income: false,
      categories: [{ id: 'food', name: 'Food' }],
    }],
  });
  await harness.data.initApi();
  const baselineCreateCategory = harness.fakeActual.inspect().counts.createCategory;
  const faultInjector = faultSchedule([{
    point: 'before:item-1-effect',
    hookOnly: true,
    hook: () => {
      harness.fakeActual.configure({
        preserveCounts: true,
        rows: harness.fakeActual.inspect().rows,
        accounts: harness.fakeActual.inspect().accounts,
        categoryGroups: [
          {
            id: 'spending',
            name: 'Spending',
            is_income: false,
            categories: [{ id: 'splitwise-a', name: 'Splitwise' }],
          },
          {
            id: 'other',
            name: 'Other',
            is_income: false,
            categories: [{ id: 'splitwise-b', name: 'Splitwise' }],
          },
        ],
      });
    },
  }]);
  await assert.rejects(
    harness.data.syncSplitwiseShareExpenses({ sync: false, faultInjector }),
    (error) => error instanceof BulkOperationOutcomeUnknownError
      && error.code === 'BULK_OPERATION_OUTCOME_UNKNOWN',
  );
  assert.equal(harness.fakeActual.inspect().counts.createCategory, baselineCreateCategory);
  assert.equal(
    harness.fakeActual.inspect().categoryGroups
      .flatMap((group) => group.categories || [])
      .filter((category) => category.name === 'Splitwise').length,
    2,
  );
  harness.cleanup();
});

test('keyed mirror succeeds after null-key completed for same snapshot without duplicate ledger effects', async () => {
  const harness = standardCreateHarness();
  await harness.data.initApi();
  const nullKey = await harness.data.syncSplitwiseShareExpenses({ sync: true });
  assert.equal(nullKey.created, 1);
  const addCount = harness.fakeActual.inspect().counts.add;
  const keyed = await harness.data.syncSplitwiseShareExpenses({
    sync: true,
    operationKey: 'keyed-after-null',
  });
  assert.equal(keyed.status, 'completed');
  assert.equal(keyed.created, 0);
  assert.equal(keyed.items, 1);
  assert.equal(harness.fakeActual.inspect().counts.add, addCount);
  const replay = await harness.data.syncSplitwiseShareExpenses({
    sync: true,
    operationKey: 'keyed-after-null',
  });
  assert.equal(replay.status, 'completed');
  assert.equal(replay.created, 0);
  assert.equal(harness.fakeActual.inspect().counts.add, addCount);
  const sagas = Object.values(readJson(harness.paths.bulk).sagas);
  assert.ok(sagas.some((entry) => entry.operationKey === 'keyed-after-null' && entry.phase === 'completed'));
  assert.ok(sagas.some((entry) => !entry.operationKey && entry.phase === 'completed'));
  harness.cleanup();
});

test('null-key ignores corrupted completed sibling and creates next mirrorAttempt', async () => {
  const harness = standardCreateHarness();
  await harness.data.initApi();
  const binding = snapshotBinding(readJson(harness.paths.owesTruth));
  writeJson(harness.paths.bulk, {
    schemaVersion: 1,
    sagas: {
      corrupt: {
        id: 'corrupt-null',
        recordVersion: 1,
        kind: 'splitwise_mirror',
        operationKey: null,
        phase: 'completed',
        params: { snapshotBinding: binding, mirrorAttempt: 0 },
        plan: {
          params: { snapshotBinding: binding, accountName: 'Splitwise', snapshotItemCount: 1 },
          items: [
            { globalIndex: 0, itemType: 'splitwise_bootstrap_account' },
            { globalIndex: 1, itemType: 'splitwise_bootstrap_category' },
            { globalIndex: 2, itemType: 'splitwise_create', sourceId: '880' },
          ],
        },
        itemOutcomes: {
          0: { status: 'completed' },
          1: { status: 'completed' },
        },
        auditOutcome: { status: 'completed', applied: 2, failed: 0, skipped: 0, failedItems: [] },
        createdAt: nowIso,
        updatedAt: nowIso,
      },
    },
  });
  delete require.cache[require.resolve('../dataModule')];
  const data = require('../dataModule');
  const result = await data.syncSplitwiseShareExpenses({ sync: true });
  assert.equal(result.created, 1);
  assert.equal(result.status, 'completed');
  const sagas = readJson(harness.paths.bulk).sagas;
  const corruptSaga = Object.values(sagas).find(
    (entry) => entry.params?.mirrorAttempt === 0 && entry.id === 'corrupt-null',
  );
  assert.equal(corruptSaga?.phase, 'completed');
  assert.ok(Object.values(sagas).some(
    (entry) => entry.phase === 'completed' && entry.params?.mirrorAttempt === 1,
  ));
  harness.cleanup();
});

test('null-key mirror replays terminal result for unchanged snapshot binding', async () => {
  const harness = standardCreateHarness();
  await harness.data.initApi();
  const first = await harness.data.syncSplitwiseShareExpenses({ sync: false });
  assert.equal(first.created, 1);
  const addCount = harness.fakeActual.inspect().counts.add;
  const second = await harness.data.syncSplitwiseShareExpenses({ sync: false });
  assert.equal(second.created, 1);
  assert.equal(harness.fakeActual.inspect().counts.add, addCount);
  harness.cleanup();
});

test('null-key mirror resumes active saga when snapshot binding drifts', async () => {
  const harness = standardCreateHarness();
  await harness.data.initApi();
  const faultInjector = faultSchedule([{ point: 'after:item-2-applied-checkpoint' }]);
  await assert.rejects(
    harness.data.syncSplitwiseShareExpenses({ sync: false, faultInjector }),
    (error) => error.name === 'SagaInterruption',
  );
  writeJson(harness.paths.owesTruth, completeSnapshot([
    { id: '880', myShare: 9.99, date: today, desc: 'changed share' },
  ]));
  delete require.cache[require.resolve('../dataModule')];
  const data = require('../dataModule');
  await assert.rejects(
    data.syncSplitwiseShareExpenses({ sync: false }),
    (error) => error instanceof BulkOperationOutcomeUnknownError
      && error.code === 'BULK_OPERATION_OUTCOME_UNKNOWN',
  );
  harness.cleanup();
});

test('null-key mirror starts fresh convergence when snapshot binding changes after terminal', async () => {
  const harness = standardCreateHarness();
  await harness.data.initApi();
  await harness.data.syncSplitwiseShareExpenses({ sync: true });
  writeJson(harness.paths.owesTruth, completeSnapshot([
    { id: '881', myShare: 1.5, date: today, desc: 'new snapshot item' },
  ]));
  delete require.cache[require.resolve('../dataModule')];
  const data = require('../dataModule');
  await data.initApi();
  const result = await data.syncSplitwiseShareExpenses({ sync: false });
  assert.equal(result.created, 1);
  assert.ok(harness.fakeActual.inspect().rows.some((row) => /#sw-881/.test(row.notes || '')));
  harness.cleanup();
});

test('multiple active null-key mirror sagas are a bulk state error', async () => {
  const harness = standardCreateHarness();
  await harness.data.initApi();
  writeJson(harness.paths.bulk, {
    schemaVersion: 1,
    sagas: {
      a: {
        id: 'a',
        recordVersion: 1,
        kind: 'splitwise_mirror',
        operationKey: null,
        phase: 'items_pending',
        plan: { items: [], params: {} },
        itemOutcomes: {},
        cursor: { itemIndex: 0 },
        completedIndexes: [],
        createdAt: nowIso,
        updatedAt: nowIso,
      },
      b: {
        id: 'b',
        recordVersion: 1,
        kind: 'splitwise_mirror',
        operationKey: null,
        phase: 'plan_checkpoint',
        plan: { items: [], params: {} },
        itemOutcomes: {},
        cursor: { itemIndex: 0 },
        completedIndexes: [],
        createdAt: nowIso,
        updatedAt: nowIso,
      },
    },
  });
  delete require.cache[require.resolve('../dataModule')];
  const data = require('../dataModule');
  await assert.rejects(
    data.syncSplitwiseShareExpenses({ sync: false }),
    (error) => error instanceof BulkOperationStateError,
  );
  harness.cleanup();
});

test('completed deletion saga is rediscovered when delegation record missing after crash', async () => {
  const row = {
    id: 'del-row',
    account: 'splitwise-account',
    date: today,
    amount: -500,
    notes: 'stale #sw-502',
    cleared: true,
    category: 'splitwise-category',
    is_parent: false,
    subtransactions: [],
  };
  const harness = makeHarness({ rows: [row], snapshot: completeSnapshot([]) });
  await harness.data.initApi();
  const faultInjector = faultSchedule([{ point: 'before:item-2-delegation-recorded-checkpoint' }]);
  await assert.rejects(
    harness.data.syncSplitwiseShareExpenses({ sync: false, faultInjector }),
    (error) => error.name === 'SagaInterruption',
  );
  assert.equal(harness.fakeActual.inspect().counts.delete, 1);
  assert.ok(!harness.fakeActual.inspect().rows.some((entry) => entry.id === 'del-row'));
  const result = await harness.data.syncSplitwiseShareExpenses({ sync: false });
  assert.equal(result.pruned, 1);
  assert.equal(harness.fakeActual.inspect().counts.delete, 1);
  harness.cleanup();
});

test('unrelated completed deletion evidence does not satisfy mirror delete resume', async () => {
  const row = {
    id: 'del-row',
    account: 'splitwise-account',
    date: today,
    amount: -500,
    notes: 'stale #sw-503',
    cleared: true,
    category: 'splitwise-category',
    is_parent: false,
    subtransactions: [],
  };
  const harness = makeHarness({ rows: [], snapshot: completeSnapshot([]) });
  await harness.data.initApi();
  const emptySnapshot = completeSnapshot([]);
  const identityFingerprint = mirrorIdentityFingerprint(row, '503');
  writeJson(harness.paths.bulk, {
    schemaVersion: 1,
    sagas: {
      active: {
        id: 'active-delete',
        recordVersion: 1,
        kind: 'splitwise_mirror',
        operationKey: 'delete-resume-key',
        phase: 'items_pending',
        mirrorRuntime: {
          accountId: 'splitwise-account',
          categoryId: 'splitwise-category',
        },
        plan: {
          params: {
            accountName: 'Splitwise',
            categoryName: 'Splitwise',
            snapshotBinding: snapshotBinding(emptySnapshot),
            resolutions: [],
          },
          items: [
            { globalIndex: 0, itemType: 'splitwise_bootstrap_account', stageId: 'bootstrap_account' },
            { globalIndex: 1, itemType: 'splitwise_bootstrap_category', stageId: 'bootstrap_category' },
            {
              globalIndex: 2,
              itemType: 'splitwise_delete',
              stageId: 'delete',
              accountId: 'splitwise-account',
              txnId: 'del-row',
              sourceId: '503',
              date: today,
              identityFingerprint,
              intent: { sourceId: '503', reason: 'removed-from-snapshot' },
            },
          ],
        },
        itemOutcomes: {
          0: { status: 'completed' },
          1: { status: 'completed' },
        },
        cursor: { itemIndex: 2 },
        completedIndexes: [0, 1],
        delegatedDeletionSagaIds: {},
        createdAt: nowIso,
        updatedAt: nowIso,
      },
    },
  });
  writeJson(harness.paths.deletion, {
    schemaVersion: 1,
    sagas: {
      stale: {
        id: 'stale',
        phase: 'completed',
        accountId: 'splitwise-account',
        target: {
          parentId: 'del-row',
          snapshot: {
            id: 'del-row',
            date: today,
            amount: -500,
            notes: 'wrong identity #sw-999',
            category: 'splitwise-category',
          },
        },
        updatedAt: nowIso,
      },
    },
  });
  delete require.cache[require.resolve('../dataModule')];
  const data = require('../dataModule');
  await assert.rejects(
    data.syncSplitwiseShareExpenses({ sync: false, operationKey: 'delete-resume-key' }),
    (error) => error instanceof BulkOperationOutcomeUnknownError
      && error.code === 'BULK_OPERATION_OUTCOME_UNKNOWN',
  );
  harness.cleanup();
});

test('buildResult never reports ok for corrupted completed mirror state', async () => {
  const harness = standardCreateHarness();
  await harness.data.initApi();
  writeJson(harness.paths.bulk, {
    schemaVersion: 1,
    sagas: {
      corrupt: {
        id: 'corrupt',
        recordVersion: 1,
        kind: 'splitwise_mirror',
        operationKey: 'corrupt-key',
        phase: 'completed',
        plan: {
          params: { accountName: 'Splitwise', snapshotItemCount: 1 },
          items: [
            { globalIndex: 0, itemType: 'splitwise_bootstrap_account' },
            { globalIndex: 1, itemType: 'splitwise_bootstrap_category' },
            { globalIndex: 2, itemType: 'splitwise_create', sourceId: '880' },
          ],
        },
        itemOutcomes: {
          0: { status: 'completed' },
          1: { status: 'completed' },
        },
        auditOutcome: { status: 'completed', applied: 2, failed: 0, skipped: 0, failedItems: [] },
        createdAt: nowIso,
        updatedAt: nowIso,
      },
    },
  });
  delete require.cache[require.resolve('../dataModule')];
  const data = require('../dataModule');
  const result = data.getBulkOperationResult('corrupt-key');
  assert.equal(result.ok, false);
  assert.equal(result.status, 'in_progress');
  harness.cleanup();
});

test('existing operationKey rejects cross-kind direct run without journal binding', async () => {
  const harness = makeHarness({ snapshot: completeSnapshot([]) });
  await harness.data.initApi();
  await harness.data.applyRules({ sync: false, operationKey: 'cross-kind-key' });
  await assert.rejects(
    harness.data.syncSplitwiseShareExpenses({ sync: false, operationKey: 'cross-kind-key' }),
    (error) => error.code === 'IDEMPOTENCY_KEY_REUSED',
  );
  harness.cleanup();
});

test('keyed mirror resumes active saga before current snapshot validation', async () => {
  const harness = standardCreateHarness();
  await harness.data.initApi();
  const binding = snapshotBinding(readJson(harness.paths.owesTruth));
  writeJson(harness.paths.bulk, {
    schemaVersion: 1,
    sagas: {
      active: {
        id: 'active-keyed',
        recordVersion: 1,
        kind: 'splitwise_mirror',
        operationKey: 'keyed-active-resume',
        phase: 'items_pending',
        mirrorRuntime: { accountId: 'splitwise-account', categoryId: 'splitwise-category' },
        plan: {
          params: { accountName: 'Splitwise', categoryName: 'Splitwise', snapshotBinding: binding },
          items: [
            { globalIndex: 0, itemType: 'splitwise_bootstrap_account' },
            { globalIndex: 1, itemType: 'splitwise_bootstrap_category' },
            {
              globalIndex: 2,
              itemType: 'splitwise_create',
              stageId: 'create',
              accountId: 'splitwise-account',
              sourceId: '880',
              intent: mirrorIntentFromItem(
                { id: '880', myShare: 3.25, date: today, desc: 'sweep item' },
                'splitwise-account',
                'splitwise-category',
              ),
            },
          ],
        },
        itemOutcomes: { 0: { status: 'completed' }, 1: { status: 'completed' } },
        completedIndexes: [0, 1],
        cursor: { itemIndex: 2 },
        createdAt: nowIso,
        updatedAt: nowIso,
      },
    },
  });
  writeJson(harness.paths.owesTruth, completeSnapshot([], '2020-01-01T00:00:00.000Z'));
  await assert.rejects(
    harness.data.syncSplitwiseShareExpenses({ sync: true, operationKey: 'keyed-active-resume' }),
    (error) => error instanceof BulkOperationOutcomeUnknownError
      && error.code === 'BULK_OPERATION_OUTCOME_UNKNOWN',
  );
  harness.cleanup();
});

test('mirror-specific broken saga does not block healthy keyed mirror run', async () => {
  const harness = standardCreateHarness();
  await harness.data.initApi();
  writeJson(harness.paths.bulk, {
    schemaVersion: 1,
    sagas: {
      broken: {
        id: 'broken',
        recordVersion: 1,
        kind: 'splitwise_mirror',
        operationKey: 'broken-key',
        phase: 'unresolved',
        plan: {
          params: { accountName: 'Splitwise' },
          items: [{
            globalIndex: 0,
            itemType: 'splitwise_create',
            stageId: 'create',
            accountId: 'splitwise-account',
            sourceId: '880',
            intent: { sourceId: '880' },
          }],
        },
        itemOutcomes: {},
        cursor: { itemIndex: 0 },
        completedIndexes: [],
        createdAt: nowIso,
        updatedAt: nowIso,
      },
    },
  });
  delete require.cache[require.resolve('../dataModule')];
  const data = require('../dataModule');
  const result = await data.syncSplitwiseShareExpenses({
    sync: false,
    operationKey: 'healthy-key',
  });
  assert.equal(result.created, 1);
  harness.cleanup();
});

const identityCases = [
  {
    name: 'moved foreign account',
    setup: ({ intent, accountId }) => ({
      rows: [],
      rowsByAccount: { other: [{ id: 'moved', account: 'other', notes: intent.notes, amount: intent.amount, date: intent.date, category: intent.categoryId }] },
      opts: { checkpointedTxnId: 'moved', rowsByAccount: { other: [{ id: 'moved', account: 'other' }] } },
      accountId,
      expectReason: 'checkpointed transaction moved to foreign account',
    }),
  },
  {
    name: 'imported tag disagreement',
    setup: ({ intent, accountId }) => ({
      rows: [{ id: 'bad', imported_id: intent.importedId, notes: 'no tag', amount: intent.amount, date: intent.date, category: intent.categoryId }],
      accountId,
      expectReason: 'imported_id/tag disagreement',
    }),
  },
  {
    name: 'duplicate imported',
    setup: ({ intent, accountId }) => ({
      rows: [
        { id: 'a', imported_id: intent.importedId, notes: intent.notes, amount: intent.amount, date: intent.date, category: intent.categoryId },
        { id: 'b', imported_id: intent.importedId, notes: intent.notes, amount: intent.amount, date: intent.date, category: intent.categoryId },
      ],
      accountId,
      expectReason: 'duplicate imported_id',
    }),
  },
  {
    name: 'tag-only ambiguity',
    setup: ({ intent, accountId }) => ({
      rows: [
        { id: 't1', notes: intent.notes, amount: -100, date: intent.date, category: intent.categoryId },
        { id: 't2', notes: intent.notes, amount: -200, date: intent.date, category: intent.categoryId },
      ],
      accountId,
      expectReason: 'ambiguous tag-only rows',
    }),
  },
  {
    name: 'foreign imported on tag row',
    setup: ({ intent, accountId }) => ({
      rows: [{ id: 'foreign', notes: intent.notes, amount: intent.amount, date: intent.date, category: intent.categoryId, imported_id: 'other:imported' }],
      accountId,
      expectReason: 'tag decoy imported_id',
    }),
  },
];

for (const identityCase of identityCases) {
  test(`verifyCreateMirrorIdentity rejects ${identityCase.name}`, () => {
    const intent = mirrorIntentFromItem(
      { id: '44', myShare: 5, date: today, desc: 'identity case' },
      'splitwise-account',
      'splitwise-category',
    );
    const { rows, rowsByAccount, opts, accountId, expectReason } = identityCase.setup({
      intent,
      accountId: 'splitwise-account',
    });
    const result = verifyCreateMirrorIdentity(rows, intent, accountId, opts || {});
    assert.equal(result.ok, false);
    assert.match(result.reason, new RegExp(expectReason));
  });
}

const duplicateReviewCases = [
  {
    name: 'completed drop still live',
    completedDropTxnIds: new Set(['drop-b']),
    rows: [
      { id: 'dup-a', notes: 'first #sw-9', amount: -500, date: today, category: 'c' },
      { id: 'drop-b', notes: 'second #sw-9', amount: -700, date: today, category: 'c' },
    ],
    expectReason: 'completed duplicate drop still live',
  },
  {
    name: 'pending drop missing',
    completedDropTxnIds: new Set(),
    rows: [{ id: 'dup-a', notes: 'first #sw-9', amount: -500, date: today, category: 'c' }],
    expectReason: 'pending duplicate drop missing',
  },
];

for (const duplicateCase of duplicateReviewCases) {
  test(`validateReviewedDuplicateLiveState rejects ${duplicateCase.name}`, () => {
    const rowA = duplicateCase.rows[0];
    const rowB = duplicateCase.rows[1] || {
      id: 'drop-b',
      notes: 'second #sw-9',
      amount: -700,
      date: today,
      category: 'c',
    };
    const observed = observedDuplicateSet(duplicateCase.rows.length > 1 ? duplicateCase.rows : [rowA, rowB]);
    const resolution = {
      sourceId: '9',
      observed,
      keepTxnId: 'dup-a',
      dropTxnIds: ['drop-b'],
      reviewedAt: nowIso,
    };
    const result = validateReviewedDuplicateLiveState(
      duplicateCase.rows,
      resolution,
      duplicateCase.completedDropTxnIds,
    );
    assert.equal(result.ok, false);
    assert.match(result.reason, new RegExp(duplicateCase.expectReason));
  });
}

test('validateSplitwiseMirrorSnapshot and classifyOwesTruth share OWES_SNAPSHOT_MAX_AGE_MS', () => {
  const previous = process.env.OWES_SNAPSHOT_MAX_AGE_MS;
  const now = Date.parse('2026-07-10T12:00:00.000Z');
  const staleTruth = {
    ...completeSnapshot([], '2026-07-09T00:00:00.000Z'),
    bySlug: {},
    source: 'splitwise-pairwise-test',
  };
  try {
    delete process.env.OWES_SNAPSHOT_MAX_AGE_MS;
    const defaultMax = owesSnapshotMaxAgeMs();
    assert.equal(defaultMax, DEFAULT_OWES_SNAPSHOT_MAX_AGE_MS);
    process.env.OWES_SNAPSHOT_MAX_AGE_MS = String(60 * 60 * 1000);
    assert.throws(
      () => validateSplitwiseMirrorSnapshot(staleTruth, { now }),
      (error) => error instanceof SplitwiseMirrorSnapshotError && error.code === 'STALE_UPSTREAM_DATA',
    );
    assert.equal(classifyOwesTruth(staleTruth, { now }).warning, 'splitwise-snapshot-stale');
    process.env.OWES_SNAPSHOT_MAX_AGE_MS = String(7 * 24 * 60 * 60 * 1000);
    assert.doesNotThrow(() => validateSplitwiseMirrorSnapshot(staleTruth, { now }));
    assert.equal(classifyOwesTruth(staleTruth, { now }).current, staleTruth);
  } finally {
    if (previous === undefined) delete process.env.OWES_SNAPSHOT_MAX_AGE_MS;
    else process.env.OWES_SNAPSHOT_MAX_AGE_MS = previous;
  }
  delete process.env.OWES_SNAPSHOT_MAX_AGE_MS;
  assert.equal(owesSnapshotMaxAgeMs(), DEFAULT_OWES_SNAPSHOT_MAX_AGE_MS);
});

test('validateSplitwiseMirrorSnapshot rejects bad currency invalid ids and future timestamps', () => {
  const now = Date.parse('2026-07-10T12:00:00.000Z');
  const fresh = completeSnapshot([], new Date(now - 60_000).toISOString());
  const previousCurrency = process.env.SPLITWISE_CURRENCY;
  process.env.SPLITWISE_CURRENCY = 'USD';
  try {
    assert.throws(
      () => validateSplitwiseMirrorSnapshot({
        ...fresh,
        manifest: { ...fresh.manifest, currency: 'EUR' },
      }, { now }),
      /currency must be USD/,
    );
    assert.throws(
      () => validateSplitwiseMirrorSnapshot(completeSnapshot([{ id: 'not-numeric', myShare: 1, date: today }], fresh.generatedAt), { now }),
      /invalid expense id/,
    );
    assert.throws(
      () => validateSplitwiseMirrorSnapshot(completeSnapshot([], '2030-01-01T00:00:00.000Z'), { now }),
      /invalid timestamp/,
    );
  } finally {
    if (previousCurrency === undefined) delete process.env.SPLITWISE_CURRENCY;
    else process.env.SPLITWISE_CURRENCY = previousCurrency;
  }
});

const CREATE_FAULT_POINTS = [
  'after:plan-checkpoint',
  'after:item-0-applied-checkpoint',
  'after:item-1-applied-checkpoint',
  'before:item-2-effect',
  'after:item-2-effect',
  'after:item-2-applied-checkpoint',
  'before:mirror-items-complete-checkpoint',
  'before:mirror-sync-pending-checkpoint',
];

for (const point of CREATE_FAULT_POINTS) {
  test(`mirror create checkpoint sweep converges once after crash at ${point}`, async () => {
    const harness = standardCreateHarness();
    await harness.data.initApi();
    const baselineAdd = harness.fakeActual.inspect().counts.add;
    const faultInjector = faultSchedule([{ point }]);
    assert.ok(faultInjector.queue[0]);
    await assert.rejects(
      harness.data.syncSplitwiseShareExpenses({ sync: false, faultInjector }),
      (error) => error.name === 'SagaInterruption',
    );
    assert.equal(faultInjector.queue[0].fired, true);
    const midAdd = harness.fakeActual.inspect().counts.add;
    const result = await harness.data.syncSplitwiseShareExpenses({ sync: false });
    assert.equal(result.created, 1);
    assert.equal(harness.fakeActual.inspect().counts.add - baselineAdd, 1);
    assert.ok(harness.fakeActual.inspect().counts.add >= midAdd);
    harness.cleanup();
  });
}

test('bootstrap category duplicate injected at after-effect fails closed unresolved', async () => {
  const harness = makeHarness({
    snapshot: completeSnapshot([]),
    categoryGroups: [{
      id: 'spending',
      name: 'Spending',
      is_income: false,
      categories: [{ id: 'food', name: 'Food' }],
    }],
  });
  await harness.data.initApi();
  const faultInjector = faultSchedule([{
    point: 'after:item-1-effect',
    hookOnly: true,
    hook: () => {
      harness.fakeActual.configure({
        preserveCounts: true,
        rows: harness.fakeActual.inspect().rows,
        accounts: harness.fakeActual.inspect().accounts,
        categoryGroups: [
          {
            id: 'spending',
            name: 'Spending',
            is_income: false,
            categories: [{ id: 'splitwise-a', name: 'Splitwise' }],
          },
          {
            id: 'other',
            name: 'Other',
            is_income: false,
            categories: [{ id: 'splitwise-b', name: 'Splitwise' }],
          },
        ],
      });
    },
  }]);
  await assert.rejects(
    harness.data.syncSplitwiseShareExpenses({ sync: false, faultInjector }),
    (error) => error instanceof BulkOperationOutcomeUnknownError
      && error.code === 'BULK_OPERATION_OUTCOME_UNKNOWN',
  );
  harness.cleanup();
});

test('sync_pending keyed mirror resumes before stale snapshot validation throws', async () => {
  const harness = standardCreateHarness();
  await harness.data.initApi();
  const binding = snapshotBinding(readJson(harness.paths.owesTruth));
  writeJson(harness.paths.bulk, {
    schemaVersion: 1,
    sagas: {
      pending: {
        id: 'pending-keyed',
        recordVersion: 1,
        kind: 'splitwise_mirror',
        operationKey: 'resume-stale-key',
        phase: 'sync_pending',
        mirrorRuntime: { accountId: 'splitwise-account', categoryId: 'splitwise-category' },
        plan: {
          params: { accountName: 'Splitwise', categoryName: 'Splitwise', snapshotBinding: binding },
          items: [
            { globalIndex: 0, itemType: 'splitwise_bootstrap_account' },
            { globalIndex: 1, itemType: 'splitwise_bootstrap_category' },
            {
              globalIndex: 2,
              itemType: 'splitwise_create',
              stageId: 'create',
              accountId: 'splitwise-account',
              sourceId: '880',
              intent: mirrorIntentFromItem({ id: '880', myShare: 3.25, date: today }, 'splitwise-account', 'splitwise-category'),
            },
          ],
        },
        itemOutcomes: { 0: { status: 'completed' }, 1: { status: 'completed' }, 2: { status: 'completed', txnId: 'added-1' } },
        completedIndexes: [0, 1, 2],
        cursor: { itemIndex: 3 },
        createdAt: nowIso,
        updatedAt: nowIso,
      },
    },
  });
  writeJson(harness.paths.owesTruth, completeSnapshot([], '2020-01-01T00:00:00.000Z'));
  await assert.rejects(
    harness.data.syncSplitwiseShareExpenses({ sync: true, operationKey: 'resume-stale-key' }),
    (error) => error instanceof BulkOperationOutcomeUnknownError
      && error.code === 'BULK_OPERATION_OUTCOME_UNKNOWN',
  );
  harness.cleanup();
});

test('null-key unresolved attempt increments then completes and replays', async () => {
  const harness = standardCreateHarness();
  await harness.data.initApi();
  const binding = snapshotBinding(readJson(harness.paths.owesTruth));
  writeJson(harness.paths.bulk, {
    schemaVersion: 1,
    sagas: {
      unresolved0: {
        id: 'unresolved0',
        recordVersion: 1,
        kind: 'splitwise_mirror',
        operationKey: null,
        phase: 'unresolved',
        params: { snapshotBinding: binding, mirrorAttempt: 0 },
        plan: { params: { snapshotBinding: binding }, items: [] },
        itemOutcomes: {},
        createdAt: nowIso,
        updatedAt: nowIso,
      },
    },
  });
  delete require.cache[require.resolve('../dataModule')];
  const data = require('../dataModule');
  await data.initApi();
  const first = await data.syncSplitwiseShareExpenses({ sync: true });
  assert.equal(first.created, 1);
  assert.equal(first.status, 'completed');
  const sagas = readJson(harness.paths.bulk).sagas;
  assert.ok(Object.values(sagas).some((entry) => entry.phase === 'unresolved' && entry.params?.mirrorAttempt === 0));
  assert.ok(Object.values(sagas).some((entry) => entry.phase === 'completed' && entry.params?.mirrorAttempt === 1));
  const addCount = harness.fakeActual.inspect().counts.add;
  const replay = await data.syncSplitwiseShareExpenses({ sync: true });
  assert.equal(replay.created, 1);
  assert.equal(harness.fakeActual.inspect().counts.add, addCount);
  harness.cleanup();
});

test('recover with deferSync advances healthy mirror while reporting broken mirror error', async () => {
  const harness = standardCreateHarness();
  await harness.data.initApi();
  const binding = snapshotBinding(readJson(harness.paths.owesTruth));
  writeJson(harness.paths.bulk, {
    schemaVersion: 1,
    sagas: {
      broken: {
        id: 'broken',
        recordVersion: 1,
        kind: 'splitwise_mirror',
        operationKey: 'broken-key',
        phase: 'items_pending',
        plan: {
          params: { snapshotBinding: binding },
          items: [{ globalIndex: 0, itemType: 'splitwise_create', sourceId: '880', intent: { sourceId: '880' } }],
        },
        itemOutcomes: {},
        cursor: { itemIndex: 0 },
        createdAt: nowIso,
        updatedAt: nowIso,
      },
      healthy: {
        id: 'healthy',
        recordVersion: 1,
        kind: 'splitwise_mirror',
        operationKey: 'healthy-recover-key',
        phase: 'sync_pending',
        mirrorRuntime: { accountId: 'splitwise-account', categoryId: 'splitwise-category' },
        plan: {
          params: { accountName: 'Splitwise', snapshotBinding: binding },
          items: [
            { globalIndex: 0, itemType: 'splitwise_bootstrap_account' },
            { globalIndex: 1, itemType: 'splitwise_bootstrap_category' },
            {
              globalIndex: 2,
              itemType: 'splitwise_create',
              sourceId: '880',
              intent: mirrorIntentFromItem({ id: '880', myShare: 3.25, date: today }, 'splitwise-account', 'splitwise-category'),
            },
          ],
        },
        itemOutcomes: {
          0: { status: 'completed' },
          1: { status: 'completed' },
          2: { status: 'completed', txnId: 'added-1' },
        },
        completedIndexes: [0, 1, 2],
        cursor: { itemIndex: 3 },
        createdAt: nowIso,
        updatedAt: nowIso,
      },
    },
  });
  delete require.cache[require.resolve('../dataModule')];
  const data = require('../dataModule');
  const fakeApi = require('./fixtures/deletion-actual');
  const recovery = await data.recoverBulkOperationSagas(fakeApi, { deferSync: true });
  assert.equal(recovery.errors.length, 1);
  assert.equal(recovery.needsSync, true);
  const healthy = readJson(harness.paths.bulk).sagas.healthy;
  assert.equal(healthy.phase, 'sync_pending');
  await data.recoverBulkOperationSagas(fakeApi, {});
  assert.equal(readJson(harness.paths.bulk).sagas.healthy.phase, 'completed');
  harness.cleanup();
});

const UPDATE_FAULT_POINTS = [
  'after:item-2-applied-checkpoint',
  'before:mirror-sync-pending-checkpoint',
];

for (const point of UPDATE_FAULT_POINTS) {
  test(`mirror update checkpoint sweep converges once after crash at ${point}`, async () => {
    const existing = {
      id: 'mirror-row',
      account: 'splitwise-account',
      date: today,
      amount: -325,
      notes: 'old #sw-880',
      cleared: true,
      category: 'splitwise-category',
      imported_id: durableImportedId('880'),
      is_parent: false,
      subtransactions: [],
    };
    const harness = makeHarness({
      rows: [existing],
      snapshot: completeSnapshot([{ id: '880', myShare: 9, date: today, desc: 'updated' }]),
    });
    await harness.data.initApi();
    const baselineUpdate = harness.fakeActual.inspect().counts.update;
    const faultInjector = faultSchedule([{ point }]);
    await assert.rejects(
      harness.data.syncSplitwiseShareExpenses({ sync: false, faultInjector }),
      (error) => error.name === 'SagaInterruption',
    );
    assert.equal(faultInjector.queue[0].fired, true);
    const result = await harness.data.syncSplitwiseShareExpenses({ sync: false });
    assert.equal(result.updated, 1);
    assert.equal(harness.fakeActual.inspect().counts.update - baselineUpdate, 1);
    harness.cleanup();
  });
}

test('mirror terminal checkpoint crash replays completed without extra effects', async () => {
  const harness = standardCreateHarness();
  await harness.data.initApi();
  const faultInjector = faultSchedule([{ point: 'after:mirror-terminal-checkpoint' }]);
  await assert.rejects(
    harness.data.syncSplitwiseShareExpenses({ sync: true, faultInjector }),
    (error) => error.name === 'SagaInterruption',
  );
  const addCount = harness.fakeActual.inspect().counts.add;
  const replay = await harness.data.syncSplitwiseShareExpenses({ sync: true });
  assert.equal(replay.status, 'completed');
  assert.equal(replay.created, 1);
  assert.equal(harness.fakeActual.inspect().counts.add, addCount);
  harness.cleanup();
});

function buildRealDataPreload(dashboardRoot, fixtureConfigureBody, { nullKeyWarmup = false } = {}) {
  const warmup = nullKeyWarmup ? `
    (async () => {
      try {
        await actual.syncSplitwiseShareExpenses({ sync: true });
        if (process.env.TEST_MIRROR_ROWS) {
          fs.writeFileSync(process.env.TEST_MIRROR_ROWS, JSON.stringify(fixture.inspect().rows, null, 2));
        }
      } catch (error) {
        console.error('preload null-key mirror failed', error);
        process.exit(1);
      }
    })();
  ` : '';
  return `
    const fs = require('fs');
    const path = require('path');
    const fixture = require(${JSON.stringify(path.join(__dirname, 'fixtures', 'deletion-actual.js'))});
    ${fixtureConfigureBody}
    process.env.ACTUAL_API_PATH = ${JSON.stringify(path.join(__dirname, 'fixtures', 'deletion-actual.js'))};
    const dataPath = require.resolve(path.join(${JSON.stringify(dashboardRoot)}, 'dataModule.js'));
    delete require.cache[dataPath];
    const actual = require(dataPath);
    require.cache[dataPath] = {
      id: dataPath,
      filename: dataPath,
      loaded: true,
      exports: {
        ...actual,
        initApi: async () => ({ ok: true }),
        shutdownApi: async () => ({ ok: true }),
        getHealth: () => ({ ready: true }),
        syncNow: () => actual.syncNow(),
        syncSplitwiseShareExpenses: async (options) => {
          const result = await actual.syncSplitwiseShareExpenses(options);
          if (process.env.TEST_MIRROR_ROWS) {
            fs.writeFileSync(process.env.TEST_MIRROR_ROWS, JSON.stringify(fixture.inspect().rows, null, 2));
          }
          return result;
        },
      },
      children: [],
      paths: [],
    };
    ${warmup}
  `;
}

test('HTTP sync-shares stale snapshot journals terminal STALE_UPSTREAM_DATA without bulk effects', async (t) => {
  const dashboardRoot = path.resolve(__dirname, '..');
  const { base, journalPath, bulkPath } = await startSplitwiseHttpServer(t, {
    tempPrefix: 'darkfinances-splitwise-http-stale-',
    preloadBody: buildRealDataPreload(dashboardRoot, `
    fixture.configure({
      rows: [],
      accounts: [{ id: 'splitwise-account', name: 'Splitwise', closed: false, offbudget: false }],
      categoryGroups: [{ id: 'spending', name: 'Spending', is_income: false, categories: [{ id: 'splitwise-category', name: 'Splitwise' }] }],
    });
  `),
    prepareState: (_dir, paths) => {
      writeJson(paths.journalPath, { schemaVersion: 1, operations: {} });
      writeJson(paths.bulkPath, { schemaVersion: 1, sagas: {} });
      writeJson(paths.resolutionsPath, { schemaVersion: 1, resolutions: [] });
      writeJson(paths.deletionPath, { schemaVersion: 1, sagas: {} });
      writeJson(paths.owesPath, completeSnapshot([], '2020-01-01T00:00:00.000Z'));
    },
  });

  const key = 'mirror-preflight-stale';
  const headers = { 'X-Finance-Token': 'test-api-token', 'Idempotency-Key': key };
  const first = await fetch(`${base}/api/v1/splitwise/sync-shares`, { method: 'POST', headers });
  const firstBody = await first.json();
  assert.equal(first.status, 503);
  assert.equal(firstBody.code, 'STALE_UPSTREAM_DATA');
  assert.deepEqual(readJson(bulkPath).sagas, {});
  const journal = readJson(journalPath);
  assert.equal(journal.operations[key].phase, 'failed');
  assert.equal(journal.operations[key].error.code, 'STALE_UPSTREAM_DATA');
  assert.equal(journal.operations[key].error.status, 503);

  const replay = await fetch(`${base}/api/v1/splitwise/sync-shares`, { method: 'POST', headers });
  const replayBody = await replay.json();
  assert.equal(replay.status, 503);
  assert.equal(replayBody.code, 'STALE_UPSTREAM_DATA');
  const journalReplay = readJson(journalPath);
  assert.equal(journalReplay.operations[key].phase, 'failed');
  assert.equal(journalReplay.operations[key].error.code, 'STALE_UPSTREAM_DATA');
});

test('HTTP sync-shares keyed run succeeds after null-key completed snapshot without duplicate ledger effects', async (t) => {
  const dashboardRoot = path.resolve(__dirname, '..');
  const { base, journalPath, bulkPath, rowsPath } = await startSplitwiseHttpServer(t, {
    tempPrefix: 'darkfinances-splitwise-http-mixed-',
    preloadBody: buildRealDataPreload(dashboardRoot, `
    fixture.configure({
      rows: [],
      accounts: [{ id: 'splitwise-account', name: 'Splitwise', closed: false, offbudget: false }],
      categoryGroups: [{ id: 'spending', name: 'Spending', is_income: false, categories: [{ id: 'splitwise-category', name: 'Splitwise' }] }],
    });
  `, { nullKeyWarmup: true }),
    prepareState: (_dir, paths) => {
      writeJson(paths.journalPath, { schemaVersion: 1, operations: {} });
      writeJson(paths.bulkPath, { schemaVersion: 1, sagas: {} });
      writeJson(paths.resolutionsPath, { schemaVersion: 1, resolutions: [] });
      writeJson(paths.deletionPath, { schemaVersion: 1, sagas: {} });
      writeJson(paths.owesPath, completeSnapshot([{ id: '200', myShare: 6, date: today, desc: 'mixed mode' }]));
    },
    extraEnvForDir: (dir) => ({ TEST_MIRROR_ROWS: path.join(dir, 'mirror-rows.json') }),
  });

  const rowsAfterNullKey = readJson(rowsPath);
  assert.equal(rowsAfterNullKey.filter((entry) => entry.imported_id === durableImportedId('200')).length, 1);
  assert.ok(Object.values(readJson(bulkPath).sagas).some((entry) => !entry.operationKey && entry.phase === 'completed'));

  const key = 'mirror-http-mixed-keyed';
  const headers = { 'X-Finance-Token': 'test-api-token', 'Idempotency-Key': key };
  const first = await fetch(`${base}/api/v1/splitwise/sync-shares`, { method: 'POST', headers });
  const firstBody = await first.json();
  assert.equal(first.status, 200);
  assert.equal(firstBody.data.status, 'completed');
  assert.equal(firstBody.data.created, 0);
  assert.equal(firstBody.data.items, 1);
  const journal = readJson(journalPath);
  assert.equal(journal.operations[key].phase, 'completed');

  const rowsAfterKeyed = readJson(rowsPath);
  assert.equal(rowsAfterKeyed.filter((entry) => entry.imported_id === durableImportedId('200')).length, 1);
  assert.ok(Object.values(readJson(bulkPath).sagas).some(
    (entry) => entry.operationKey === key && entry.phase === 'completed',
  ));

  const replay = await fetch(`${base}/api/v1/splitwise/sync-shares`, { method: 'POST', headers });
  const replayBody = await replay.json();
  assert.equal(replay.status, 200);
  assert.equal(replayBody.operation.replayed, true);
  assert.equal(readJson(rowsPath).filter((entry) => entry.imported_id === durableImportedId('200')).length, 1);
});

test('HTTP sync-shares rejects cross-kind idempotency key reuse', async (t) => {
  const dashboardRoot = path.resolve(__dirname, '..');
  const { base, journalPath } = await startSplitwiseHttpServer(t, {
    tempPrefix: 'darkfinances-splitwise-http-cross-kind-',
    preloadBody: buildRealDataPreload(dashboardRoot, `
    fixture.configure({
      rows: [],
      accounts: [{ id: 'splitwise-account', name: 'Splitwise', closed: false, offbudget: false }],
      categoryGroups: [{ id: 'spending', name: 'Spending', is_income: false, categories: [{ id: 'splitwise-category', name: 'Splitwise' }] }],
    });
  `),
    prepareState: (_dir, paths) => {
      writeJson(paths.journalPath, { schemaVersion: 1, operations: {} });
      writeJson(paths.bulkPath, { schemaVersion: 1, sagas: {} });
      writeJson(paths.resolutionsPath, { schemaVersion: 1, resolutions: [] });
      writeJson(paths.deletionPath, { schemaVersion: 1, sagas: {} });
      writeJson(paths.owesPath, completeSnapshot([]));
    },
  });

  const key = 'cross-kind-http-key';
  const headers = { 'X-Finance-Token': 'test-api-token', 'Idempotency-Key': key };
  const rules = await fetch(`${base}/api/v1/rules/apply`, { method: 'POST', headers });
  assert.equal(rules.status, 200);

  const mirror = await fetch(`${base}/api/v1/splitwise/sync-shares`, { method: 'POST', headers });
  const mirrorBody = await mirror.json();
  assert.equal(mirror.status, 409);
  assert.equal(mirrorBody.code, 'IDEMPOTENCY_KEY_REUSED');
  assert.equal(readJson(journalPath).operations[key].phase, 'completed');
});

test('HTTP sync-shares preflight failure journals terminal SPLITWISE_MIRROR_AMBIGUOUS without bulk effects', async (t) => {
  const dashboardRoot = path.resolve(__dirname, '..');
  const { base, journalPath, bulkPath } = await startSplitwiseHttpServer(t, {
    tempPrefix: 'darkfinances-splitwise-http-preflight-',
    preloadBody: buildRealDataPreload(dashboardRoot, `
    fixture.configure({
      rows: [
        { id: 'dup-a', account: 'splitwise-account', date: ${JSON.stringify(today)}, amount: -500, notes: 'first #sw-100', cleared: true, category: 'splitwise-category', is_parent: false, subtransactions: [] },
        { id: 'dup-b', account: 'splitwise-account', date: ${JSON.stringify(today)}, amount: -700, notes: 'second #sw-100', cleared: true, category: 'splitwise-category', is_parent: false, subtransactions: [] },
      ],
      accounts: [{ id: 'splitwise-account', name: 'Splitwise', closed: false, offbudget: false }],
      categoryGroups: [{ id: 'spending', name: 'Spending', is_income: false, categories: [{ id: 'splitwise-category', name: 'Splitwise' }] }],
    });
  `),
    prepareState: (_dir, paths) => {
      writeJson(paths.journalPath, { schemaVersion: 1, operations: {} });
      writeJson(paths.bulkPath, { schemaVersion: 1, sagas: {} });
      writeJson(paths.resolutionsPath, { schemaVersion: 1, resolutions: [] });
      writeJson(paths.deletionPath, { schemaVersion: 1, sagas: {} });
      writeJson(paths.owesPath, completeSnapshot([{ id: '100', myShare: 5, date: today, desc: 'dup' }]));
    },
  });

  const key = 'mirror-preflight-dup';
  const headers = { 'X-Finance-Token': 'test-api-token', 'Idempotency-Key': key };
  const first = await fetch(`${base}/api/v1/splitwise/sync-shares`, { method: 'POST', headers });
  const firstBody = await first.json();
  assert.equal(first.status, 409);
  assert.equal(firstBody.code, 'SPLITWISE_MIRROR_AMBIGUOUS');
  assert.deepEqual(readJson(bulkPath).sagas, {});
  const journal = readJson(journalPath);
  assert.equal(journal.operations[key].phase, 'failed');
  assert.equal(journal.operations[key].error.code, 'SPLITWISE_MIRROR_AMBIGUOUS');

  const replay = await fetch(`${base}/api/v1/splitwise/sync-shares`, { method: 'POST', headers });
  const replayBody = await replay.json();
  assert.equal(replay.status, 409);
  assert.equal(replayBody.code, 'SPLITWISE_MIRROR_AMBIGUOUS');
  const journalAfterReplay = readJson(journalPath);
  assert.equal(journalAfterReplay.operations[key].phase, 'failed');
  assert.equal(journalAfterReplay.operations[key].error.code, 'SPLITWISE_MIRROR_AMBIGUOUS');
});

test('HTTP sync-shares success writes imported_id through fixture Actual', async (t) => {
  const dashboardRoot = path.resolve(__dirname, '..');
  const { base, rowsPath } = await startSplitwiseHttpServer(t, {
    tempPrefix: 'darkfinances-splitwise-http-success-',
    preloadBody: buildRealDataPreload(dashboardRoot, `
    fixture.configure({
      rows: [],
      accounts: [{ id: 'splitwise-account', name: 'Splitwise', closed: false, offbudget: false }],
      categoryGroups: [{ id: 'spending', name: 'Spending', is_income: false, categories: [{ id: 'splitwise-category', name: 'Splitwise' }] }],
    });
  `),
    prepareState: (_dir, paths) => {
      writeJson(paths.journalPath, { schemaVersion: 1, operations: {} });
      writeJson(paths.bulkPath, { schemaVersion: 1, sagas: {} });
      writeJson(paths.resolutionsPath, { schemaVersion: 1, resolutions: [] });
      writeJson(paths.deletionPath, { schemaVersion: 1, sagas: {} });
      writeJson(paths.owesPath, completeSnapshot([{ id: '200', myShare: 6, date: today, desc: 'http create' }]));
    },
    extraEnvForDir: (dir) => ({ TEST_MIRROR_ROWS: path.join(dir, 'mirror-rows.json') }),
  });

  const key = 'mirror-http-success';
  const headers = { 'X-Finance-Token': 'test-api-token', 'Idempotency-Key': key };
  const response = await fetch(`${base}/api/v1/splitwise/sync-shares`, { method: 'POST', headers });
  const body = await response.json();
  assert.equal(response.status, 200);
  assert.equal(body.data.created, 1);
  const rows = readJson(rowsPath);
  const row = rows.find((entry) => entry.imported_id === durableImportedId('200'));
  assert.ok(row);
  const replay = await fetch(`${base}/api/v1/splitwise/sync-shares`, { method: 'POST', headers });
  const replayBody = await replay.json();
  assert.equal(replay.status, 200);
  assert.equal(replayBody.operation.replayed, true);
  const rowsAfterReplay = readJson(rowsPath);
  assert.equal(rowsAfterReplay.filter((entry) => entry.imported_id === durableImportedId('200')).length, 1);
});
