'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const os = require('os');
const path = require('path');
const { categoryIdentityFingerprint } = require('../lib/bulk-operation-fingerprint');
const {
  observedDuplicateSet,
  SplitwiseMirrorAmbiguousError,
  SplitwiseMirrorAdmissionError,
  SplitwiseMirrorSnapshotError,
  durableImportedId,
  parseMirrorSourceId,
  buildMirrorNotes,
  resolveMirrorRowSourceId,
} = require('../lib/splitwise-mirror');
const {
  BulkOperationInProgressError,
  BulkOperationOutcomeUnknownError,
} = require('../lib/bulk-operation-saga');

class SagaInterruption extends Error {
  constructor(message) {
    super(message);
    this.name = 'SagaInterruption';
  }
}

function faultSchedule(entries) {
  const queue = entries.map((entry) => ({ ...entry, fired: false }));
  const injector = async (point) => {
    const entry = queue.find((candidate) => !candidate.fired && candidate.point === point);
    if (!entry) return;
    entry.fired = true;
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

const nowIso = '2026-07-10T02:30:00.000Z';
const today = '2026-07-10';

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

function restoreBaselineEnv() {
  for (const key of ENV_KEYS) {
    const value = savedBaselineEnv[key];
    if (value === undefined) delete process.env[key];
    else process.env[key] = value;
  }
}

test.after(() => {
  restoreBaselineEnv();
});

function completeSnapshot(items = []) {
  return {
    schemaVersion: 2,
    generatedAt: new Date().toISOString(),
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

function makeHarness({ rows = [], snapshot = completeSnapshot(), resolutions = { schemaVersion: 1, resolutions: [] } } = {}) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'darkfinances-splitwise-mirror-'));
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
    accounts: [{
      id: 'splitwise-account',
      name: 'Splitwise',
      closed: false,
      offbudget: false,
    }],
    categoryGroups: [{
      id: 'spending',
      name: 'Spending',
      is_income: false,
      categories: [{ id: 'splitwise-category', name: 'Splitwise' }],
    }],
  });

  delete require.cache[require.resolve('../dataModule')];
  const data = require('../dataModule');

  return { data, fakeActual, paths, dir, cleanup() { fs.rmSync(dir, { recursive: true, force: true }); } };
}

function assertNoMirrorAdmissionEffects(harness, {
  splitwiseAccountCount = 1,
  splitwiseCategoryCount = 1,
} = {}) {
  assert.deepEqual(readJson(harness.paths.bulk).sagas, {});
  const inspect = harness.fakeActual.inspect();
  assert.equal(inspect.counts.add, 0);
  assert.equal(inspect.counts.delete, 0);
  assert.equal(inspect.counts.update, 0);
  assert.equal(
    inspect.accounts.filter((account) => account.name === 'Splitwise').length,
    splitwiseAccountCount,
  );
  const splitwiseCategories = inspect.categoryGroups
    .flatMap((group) => group.categories || [])
    .filter((category) => category.name === 'Splitwise');
  assert.equal(splitwiseCategories.length, splitwiseCategoryCount);
}

test('duplicate tags without resolution perform zero structural or transaction effects', async () => {
  const harness = makeHarness({
    rows: [
      {
        id: 'dup-a',
        account: 'splitwise-account',
        date: today,
        amount: -500,
        notes: 'first #sw-123',
        cleared: true,
        category: 'splitwise-category',
        is_parent: false,
        subtransactions: [],
      },
      {
        id: 'dup-b',
        account: 'splitwise-account',
        date: today,
        amount: -700,
        notes: 'second #sw-123',
        cleared: true,
        category: 'splitwise-category',
        is_parent: false,
        subtransactions: [],
      },
    ],
    snapshot: completeSnapshot([{ id: '123', myShare: 7, date: today, desc: 'shared' }]),
  });
  await harness.data.initApi();
  await assert.rejects(
    harness.data.syncSplitwiseShareExpenses({ sync: false }),
    (error) => error instanceof SplitwiseMirrorAmbiguousError
      && error.code === 'SPLITWISE_MIRROR_AMBIGUOUS',
  );
  assert.equal(harness.fakeActual.inspect().counts.add, 0);
  assert.equal(harness.fakeActual.inspect().counts.update, 0);
  assert.equal(harness.fakeActual.inspect().counts.delete, 0);
  assert.deepEqual(readJson(harness.paths.bulk).sagas, {});
  fs.rmSync(harness.dir, { recursive: true, force: true });
});

test('stale resolution observed-set mismatch refuses to delete anything', async () => {
  const rowA = {
    id: 'dup-a',
    account: 'splitwise-account',
    date: today,
    amount: -500,
    notes: 'first #sw-123',
    cleared: true,
    category: 'splitwise-category',
    is_parent: false,
    subtransactions: [],
  };
  const rowB = {
    id: 'dup-b',
    account: 'splitwise-account',
    date: today,
    amount: -700,
    notes: 'second #sw-123',
    cleared: true,
    category: 'splitwise-category',
    is_parent: false,
    subtransactions: [],
  };
  const harness = makeHarness({
    rows: [rowA, rowB],
    snapshot: completeSnapshot([{ id: '123', myShare: 7, date: today, desc: 'shared' }]),
    resolutions: {
      schemaVersion: 1,
      resolutions: [{
        sourceId: '123',
        observed: [{ id: 'dup-a', fingerprint: 'stale-fingerprint' }, { id: 'dup-b', fingerprint: 'also-stale' }],
        keepTxnId: 'dup-a',
        dropTxnIds: ['dup-b'],
        reviewedAt: nowIso,
      }],
    },
  });
  await harness.data.initApi();
  await assert.rejects(
    harness.data.syncSplitwiseShareExpenses({ sync: false }),
    (error) => error instanceof SplitwiseMirrorAmbiguousError,
  );
  assert.equal(harness.fakeActual.inspect().counts.delete, 0);
  assert.equal(harness.fakeActual.inspect().rows.length, 2);
  fs.rmSync(harness.dir, { recursive: true, force: true });
});

test('valid resolution drops reviewed duplicate then converges keeper fields', async () => {
  const rowA = {
    id: 'dup-a',
    account: 'splitwise-account',
    date: today,
    amount: -500,
    notes: 'first #sw-123',
    cleared: true,
    category: 'splitwise-category',
    is_parent: false,
    subtransactions: [],
  };
  const rowB = {
    id: 'dup-b',
    account: 'splitwise-account',
    date: today,
    amount: -700,
    notes: 'second #sw-123',
    cleared: true,
    category: 'splitwise-category',
    is_parent: false,
    subtransactions: [],
  };
  const observed = observedDuplicateSet([rowA, rowB]);
  const harness = makeHarness({
    rows: [rowA, rowB],
    snapshot: completeSnapshot([{
      id: '123',
      myShare: 7,
      date: today,
      desc: 'converged title',
      payer: 'Alex',
    }]),
    resolutions: {
      schemaVersion: 1,
      resolutions: [{
        sourceId: '123',
        observed,
        keepTxnId: 'dup-a',
        dropTxnIds: ['dup-b'],
        reviewedAt: nowIso,
      }],
    },
  });
  await harness.data.initApi();
  const result = await harness.data.syncSplitwiseShareExpenses({ sync: false });
  assert.equal(result.pruned, 1);
  assert.equal(result.updated, 1);
  const rows = harness.fakeActual.inspect().rows;
  assert.equal(rows.length, 1);
  assert.equal(rows[0].id, 'dup-a');
  assert.equal(rows[0].amount, -700);
  assert.match(rows[0].notes, /converged title \(paid by Alex\) #sw-123/);
  fs.rmSync(harness.dir, { recursive: true, force: true });
});

test('snapshot change before destructive stage fails closed unresolved', async () => {
  const harness = makeHarness({
    rows: [{
      id: 'stale-row',
      account: 'splitwise-account',
      date: today,
      amount: -500,
      notes: 'old #sw-999',
      cleared: true,
      category: 'splitwise-category',
      is_parent: false,
      subtransactions: [],
    }],
    snapshot: completeSnapshot([]),
  });
  await harness.data.initApi();
  const faultInjector = faultSchedule([{ point: 'before:item-2-pending-checkpoint' }]);
  await assert.rejects(
    harness.data.syncSplitwiseShareExpenses({ sync: false, faultInjector }),
    (error) => error.name === 'SagaInterruption',
  );
  writeJson(harness.paths.owesTruth, completeSnapshot([{ id: '888', myShare: 3, date: today }]));
  assert.equal(readJson(harness.paths.owesTruth).othersPaidItems[0].id, '888');
  await assert.rejects(
    harness.data.syncSplitwiseShareExpenses({ sync: false }),
    (error) => error.code === 'BULK_OPERATION_OUTCOME_UNKNOWN',
  );
  assert.equal(harness.fakeActual.inspect().counts.delete, 0);
  fs.rmSync(harness.dir, { recursive: true, force: true });
});

test('create uses durable imported_id and survives apply-then-throw restart', async () => {
  const harness = makeHarness({
    snapshot: completeSnapshot([{ id: '555', myShare: 4.5, date: today, desc: 'new share' }]),
  });
  await harness.data.initApi();
  const faultInjector = faultSchedule([{ point: 'after:item-2-effect' }]);
  await assert.rejects(
    harness.data.syncSplitwiseShareExpenses({ sync: false, faultInjector }),
    (error) => error.name === 'SagaInterruption',
  );
  assert.equal(harness.fakeActual.inspect().counts.add, 1);
  const result = await harness.data.syncSplitwiseShareExpenses({ sync: false });
  assert.equal(result.created, 1);
  assert.equal(harness.fakeActual.inspect().rows.length, 1);
  assert.match(harness.fakeActual.inspect().rows[0].imported_id, /splitwise-mirror:555/);
  fs.rmSync(harness.dir, { recursive: true, force: true });
});

test('fractional-cent snapshot shares are rejected without silent rounding', async () => {
  const harness = makeHarness({
    snapshot: completeSnapshot([{ id: '321', myShare: 1.005, date: today }]),
  });
  await harness.data.initApi();
  await assert.rejects(
    harness.data.syncSplitwiseShareExpenses({ sync: false }),
    /exact cent amount|invalid share/i,
  );
  fs.rmSync(harness.dir, { recursive: true, force: true });
});

test('two mirror operation keys overlapping source resources reject the second admission', async () => {
  const harness = makeHarness({
    snapshot: completeSnapshot([{ id: '777', myShare: 2, date: today }]),
  });
  await harness.data.initApi();
  writeJson(harness.paths.bulk, {
    schemaVersion: 1,
    sagas: {
      active: {
        id: 'active-mirror',
        recordVersion: 1,
        kind: 'splitwise_mirror',
        operationKey: 'first-key',
        phase: 'items_pending',
        plan: {
          items: [{
            globalIndex: 0,
            itemType: 'splitwise_create',
            stageId: 'create',
            accountId: 'splitwise-account',
            txnId: null,
            sourceId: '777',
            date: today,
            identityFingerprint: null,
            intent: { sourceId: '777' },
          }],
        },
        cursor: { itemIndex: 0 },
        completedIndexes: [],
        itemOutcomes: {},
        delegatedDeletionSagaIds: {},
        createdAt: nowIso,
        updatedAt: nowIso,
      },
    },
  });
  await assert.rejects(
    harness.data.syncSplitwiseShareExpenses({
      sync: false,
      operationKey: 'second-key',
    }),
    (error) => error instanceof BulkOperationInProgressError,
  );
  fs.rmSync(harness.dir, { recursive: true, force: true });
});

test('completed mirror items are not repeated after transient item crash and two restarts', async () => {
  const harness = makeHarness({
    snapshot: completeSnapshot([
      { id: '101', myShare: 1, date: today, desc: 'one' },
      { id: '102', myShare: 2, date: today, desc: 'two' },
    ]),
  });
  await harness.data.initApi();
  const faultInjector = faultSchedule([
    { point: 'after:item-2-effect' },
    { point: 'before:item-3-pending-checkpoint' },
  ]);
  await assert.rejects(
    harness.data.syncSplitwiseShareExpenses({ sync: false, faultInjector }),
    (error) => error.name === 'SagaInterruption',
  );
  const addAfterFirstCrash = harness.fakeActual.inspect().counts.add;
  assert.equal(addAfterFirstCrash, 1);
  await harness.data.syncSplitwiseShareExpenses({ sync: false });
  assert.equal(harness.fakeActual.inspect().counts.add, 2);
  assert.equal(harness.fakeActual.inspect().rows.length, 2);
  fs.rmSync(harness.dir, { recursive: true, force: true });
});

test('snapshot change after final item prevents terminal completion', async () => {
  const stale = {
    id: 'stale-row',
    account: 'splitwise-account',
    date: today,
    amount: -500,
    notes: 'old #sw-999',
    cleared: true,
    category: 'splitwise-category',
    is_parent: false,
    subtransactions: [],
  };
  const harness = makeHarness({ rows: [stale], snapshot: completeSnapshot([]) });
  await harness.data.initApi();
  await harness.data.syncSplitwiseShareExpenses({ sync: false });
  const saga = Object.values(readJson(harness.paths.bulk).sagas)[0];
  assert.equal(saga.phase, 'sync_pending');
  writeJson(harness.paths.owesTruth, completeSnapshot([{ id: '888', myShare: 3, date: today }]));
  await assert.rejects(
    harness.data.syncSplitwiseShareExpenses({ sync: true }),
    (error) => error instanceof BulkOperationOutcomeUnknownError,
  );
  assert.equal(Object.values(readJson(harness.paths.bulk).sagas)[0].phase, 'unresolved');
  fs.rmSync(harness.dir, { recursive: true, force: true });
});

test('mid-flight third duplicate performs zero wrong deletes', async () => {
  const rowA = {
    id: 'dup-a',
    account: 'splitwise-account',
    date: today,
    amount: -500,
    notes: 'first #sw-123',
    cleared: true,
    category: 'splitwise-category',
    is_parent: false,
    subtransactions: [],
  };
  const rowB = {
    id: 'dup-b',
    account: 'splitwise-account',
    date: today,
    amount: -700,
    notes: 'second #sw-123',
    cleared: true,
    category: 'splitwise-category',
    is_parent: false,
    subtransactions: [],
  };
  const observed = observedDuplicateSet([rowA, rowB]);
  const harness = makeHarness({
    rows: [rowA, rowB],
    snapshot: completeSnapshot([{ id: '123', myShare: 7, date: today, desc: 'shared' }]),
    resolutions: {
      schemaVersion: 1,
      resolutions: [{
        sourceId: '123',
        observed,
        keepTxnId: 'dup-a',
        dropTxnIds: ['dup-b'],
        reviewedAt: new Date().toISOString(),
      }],
    },
  });
  await harness.data.initApi();
  const faultInjector = faultSchedule([{ point: 'after:item-2-post-delete-verification' }]);
  await assert.rejects(
    harness.data.syncSplitwiseShareExpenses({ sync: false, faultInjector }),
    (error) => error.name === 'SagaInterruption',
  );
  assert.equal(harness.fakeActual.inspect().counts.delete, 1);
  harness.fakeActual.configure({
    rows: [
      rowA,
      {
        id: 'dup-c',
        account: 'splitwise-account',
        date: today,
        amount: -900,
        notes: 'third #sw-123',
        cleared: true,
        category: 'splitwise-category',
        is_parent: false,
        subtransactions: [],
      },
    ],
    accounts: [{
      id: 'splitwise-account',
      name: 'Splitwise',
      closed: false,
      offbudget: false,
    }],
    categoryGroups: [{
      id: 'spending',
      name: 'Spending',
      is_income: false,
      categories: [{ id: 'splitwise-category', name: 'Splitwise' }],
    }],
  });
  await assert.rejects(
    harness.data.syncSplitwiseShareExpenses({ sync: false }),
    (error) => error instanceof BulkOperationOutcomeUnknownError
      && error.code === 'BULK_OPERATION_OUTCOME_UNKNOWN',
  );
  assert.equal(harness.fakeActual.inspect().counts.delete, 0);
  assert.ok(harness.fakeActual.inspect().rows.some((row) => String(row.id) === 'dup-a'));
  assert.ok(harness.fakeActual.inspect().rows.some((row) => String(row.id) === 'dup-c'));
  fs.rmSync(harness.dir, { recursive: true, force: true });
});

test('closed mirror account fails deterministic pre-admission', async () => {
  const harness = makeHarness({
    snapshot: completeSnapshot([]),
  });
  harness.fakeActual.configure({
    rows: [],
    accounts: [{
      id: 'splitwise-account',
      name: 'Splitwise',
      closed: true,
      offbudget: false,
    }],
    categoryGroups: [{
      id: 'spending',
      name: 'Spending',
      is_income: false,
      categories: [{ id: 'splitwise-category', name: 'Splitwise' }],
    }],
  });
  await harness.data.initApi();
  await assert.rejects(
    harness.data.syncSplitwiseShareExpenses({ sync: false }),
    (error) => error instanceof SplitwiseMirrorAdmissionError && error.code === 'SPLITWISE_MIRROR_ACCOUNT_CLOSED',
  );
  fs.rmSync(harness.dir, { recursive: true, force: true });
});

test('bootstrap account apply-then-throw creates exactly one structural account', async () => {
  const harness = makeHarness({ snapshot: completeSnapshot([]) });
  harness.fakeActual.configure({ rows: [], accounts: [], categoryGroups: [{
    id: 'spending',
    name: 'Spending',
    is_income: false,
    categories: [{ id: 'food', name: 'Food' }],
  }] });
  await harness.data.initApi();
  const faultInjector = faultSchedule([{ point: 'after:item-0-effect' }]);
  await assert.rejects(
    harness.data.syncSplitwiseShareExpenses({ sync: false, faultInjector }),
    (error) => error.name === 'SagaInterruption',
  );
  assert.equal(harness.fakeActual.inspect().accounts.filter((a) => a.name === 'Splitwise').length, 1);
  await harness.data.syncSplitwiseShareExpenses({ sync: false });
  assert.equal(harness.fakeActual.inspect().accounts.filter((a) => a.name === 'Splitwise').length, 1);
  fs.rmSync(harness.dir, { recursive: true, force: true });
});

test('update converges amount date category and notes exactly', async () => {
  const existing = {
    id: 'mirror-row',
    account: 'splitwise-account',
    date: '2026-07-01',
    amount: -500,
    notes: 'old desc #sw-42',
    cleared: true,
    category: 'splitwise-category',
    imported_id: durableImportedId('42'),
    is_parent: false,
    subtransactions: [],
  };
  const harness = makeHarness({
    rows: [existing],
    snapshot: completeSnapshot([{
      id: '42',
      myShare: 12.34,
      date: today,
      desc: 'new desc',
      payer: 'Sam',
      category: 'Food',
    }]),
  });
  await harness.data.initApi();
  await harness.data.syncSplitwiseShareExpenses({ sync: false });
  const row = harness.fakeActual.inspect().rows[0];
  assert.equal(row.amount, -1234);
  assert.equal(row.date, today);
  assert.equal(row.category, 'splitwise-category');
  assert.match(row.notes, /new desc \(paid by Sam\) #sw-42/);
  fs.rmSync(harness.dir, { recursive: true, force: true });
});

test('imported_id conflict fails closed without adding a duplicate row', async () => {
  const conflict = {
    id: 'conflict',
    account: 'splitwise-account',
    date: today,
    amount: -100,
    notes: 'foreign row without mirror tag',
    cleared: true,
    category: 'splitwise-category',
    imported_id: durableImportedId('77'),
    is_parent: false,
    subtransactions: [],
  };
  const harness = makeHarness({
    rows: [conflict],
    snapshot: completeSnapshot([{ id: '77', myShare: 5, date: today, desc: 'real' }]),
  });
  await harness.data.initApi();
  await assert.rejects(
    harness.data.syncSplitwiseShareExpenses({ sync: false }),
    (error) => error instanceof SplitwiseMirrorAmbiguousError
      && error.code === 'SPLITWISE_MIRROR_AMBIGUOUS'
      && error.sourceIds.includes('77'),
  );
  assert.equal(harness.fakeActual.inspect().counts.add, 0);
  fs.rmSync(harness.dir, { recursive: true, force: true });
});

test('identical-looking tag decoy fails closed when imported_id holder disagrees', async () => {
  const keeper = {
    id: 'keeper',
    account: 'splitwise-account',
    date: today,
    amount: -500,
    notes: 'keeper #sw-88',
    cleared: true,
    category: 'splitwise-category',
    imported_id: durableImportedId('88'),
    is_parent: false,
    subtransactions: [],
  };
  const decoy = {
    id: 'decoy',
    account: 'splitwise-account',
    date: today,
    amount: -500,
    notes: 'decoy #sw-88',
    cleared: true,
    category: 'splitwise-category',
    is_parent: false,
    subtransactions: [],
  };
  const harness = makeHarness({
    rows: [keeper, decoy],
    snapshot: completeSnapshot([{ id: '88', myShare: 5, date: today, desc: 'shared' }]),
  });
  await harness.data.initApi();
  await assert.rejects(
    harness.data.syncSplitwiseShareExpenses({ sync: false }),
    (error) => error instanceof SplitwiseMirrorAmbiguousError
      && error.code === 'SPLITWISE_MIRROR_AMBIGUOUS'
      && error.sourceIds.includes('88'),
  );
  assert.equal(harness.fakeActual.inspect().counts.add, 0);
  harness.cleanup();
});

test('duplicate imported_id rows fail closed before mirror effects', async () => {
  const rowA = {
    id: 'a',
    account: 'splitwise-account',
    date: today,
    amount: -100,
    notes: 'first #sw-66',
    cleared: true,
    category: 'splitwise-category',
    imported_id: durableImportedId('66'),
    is_parent: false,
    subtransactions: [],
  };
  const rowB = {
    id: 'b',
    account: 'splitwise-account',
    date: today,
    amount: -200,
    notes: 'second #sw-66',
    cleared: true,
    category: 'splitwise-category',
    imported_id: durableImportedId('66'),
    is_parent: false,
    subtransactions: [],
  };
  const harness = makeHarness({
    rows: [rowA, rowB],
    snapshot: completeSnapshot([{ id: '66', myShare: 2, date: today }]),
  });
  await harness.data.initApi();
  await assert.rejects(
    harness.data.syncSplitwiseShareExpenses({ sync: false }),
    (error) => error instanceof SplitwiseMirrorAmbiguousError
      && error.code === 'SPLITWISE_MIRROR_AMBIGUOUS'
      && error.sourceIds.includes('66'),
  );
  harness.cleanup();
});

test('changed keeper fingerprint after reviewed drop refuses further convergence', async () => {
  const rowA = {
    id: 'dup-a',
    account: 'splitwise-account',
    date: today,
    amount: -500,
    notes: 'first #sw-123',
    cleared: true,
    category: 'splitwise-category',
    is_parent: false,
    subtransactions: [],
  };
  const rowB = {
    id: 'dup-b',
    account: 'splitwise-account',
    date: today,
    amount: -700,
    notes: 'second #sw-123',
    cleared: true,
    category: 'splitwise-category',
    is_parent: false,
    subtransactions: [],
  };
  const observed = observedDuplicateSet([rowA, rowB]);
  const harness = makeHarness({
    rows: [rowA, rowB],
    snapshot: completeSnapshot([{ id: '123', myShare: 7, date: today, desc: 'converged' }]),
    resolutions: {
      schemaVersion: 1,
      resolutions: [{
        sourceId: '123',
        observed,
        keepTxnId: 'dup-a',
        dropTxnIds: ['dup-b'],
        reviewedAt: nowIso,
      }],
    },
  });
  await harness.data.initApi();
  const faultInjector = faultSchedule([{ point: 'after:item-2-post-delete-verification' }]);
  await assert.rejects(
    harness.data.syncSplitwiseShareExpenses({ sync: false, faultInjector }),
    (error) => error.name === 'SagaInterruption',
  );
  harness.fakeActual.configure({
    rows: [{
      ...rowA,
      amount: -999,
    }],
    accounts: [{
      id: 'splitwise-account',
      name: 'Splitwise',
      closed: false,
      offbudget: false,
    }],
    categoryGroups: [{
      id: 'spending',
      name: 'Spending',
      is_income: false,
      categories: [{ id: 'splitwise-category', name: 'Splitwise' }],
    }],
  });
  await assert.rejects(
    harness.data.syncSplitwiseShareExpenses({ sync: false }),
    (error) => error instanceof BulkOperationOutcomeUnknownError
      && error.code === 'BULK_OPERATION_OUTCOME_UNKNOWN',
  );
  fs.rmSync(harness.dir, { recursive: true, force: true });
});

test('sync_pending mirror saga keeps source ownership until terminal', async () => {
  const harness = makeHarness({
    snapshot: completeSnapshot([{ id: '777', myShare: 2, date: today }]),
  });
  await harness.data.initApi();
  writeJson(harness.paths.bulk, {
    schemaVersion: 1,
    sagas: {
      active: {
        id: 'active-mirror',
        recordVersion: 1,
        kind: 'splitwise_mirror',
        operationKey: 'first-key',
        phase: 'sync_pending',
        plan: {
          params: { accountName: 'Splitwise', categoryName: 'Splitwise' },
          items: [{
            globalIndex: 0,
            itemType: 'splitwise_create',
            stageId: 'create',
            accountId: 'splitwise-account',
            txnId: null,
            sourceId: '777',
            date: today,
            identityFingerprint: null,
            intent: { sourceId: '777' },
          }],
        },
        itemOutcomes: { '0': { status: 'completed', txnId: 'added-1' } },
        cursor: { itemIndex: 1 },
        completedIndexes: [0],
        delegatedDeletionSagaIds: {},
        createdAt: nowIso,
        updatedAt: nowIso,
      },
    },
  });
  await assert.rejects(
    harness.data.syncSplitwiseShareExpenses({ sync: false, operationKey: 'second-key' }),
    (error) => error instanceof BulkOperationInProgressError,
  );
  fs.rmSync(harness.dir, { recursive: true, force: true });
});

test('prune-only delete survives apply-then-throw restart without double delete', async () => {
  const stale = {
    id: 'mirror-row',
    account: 'splitwise-account',
    date: today,
    amount: -500,
    notes: 'old #sw-999',
    cleared: true,
    category: 'splitwise-category',
    is_parent: false,
    subtransactions: [],
  };
  const harness = makeHarness({ rows: [stale], snapshot: completeSnapshot([]) });
  await harness.data.initApi();
  const faultInjector = faultSchedule([{ point: 'after:item-2-post-delete-verification' }]);
  await assert.rejects(
    harness.data.syncSplitwiseShareExpenses({ sync: false, faultInjector }),
    (error) => error.name === 'SagaInterruption',
  );
  const deleteCount = harness.fakeActual.inspect().counts.delete;
  assert.equal(deleteCount, 1);
  await harness.data.syncSplitwiseShareExpenses({ sync: false });
  assert.equal(harness.fakeActual.inspect().counts.delete, deleteCount);
  fs.rmSync(harness.dir, { recursive: true, force: true });
});

test('update apply-then-throw converges once without double update', async () => {
  const existing = {
    id: 'mirror-row',
    account: 'splitwise-account',
    date: today,
    amount: -500,
    notes: 'old #sw-42',
    cleared: true,
    category: 'splitwise-category',
    imported_id: durableImportedId('42'),
    is_parent: false,
    subtransactions: [],
  };
  const harness = makeHarness({
    rows: [existing],
    snapshot: completeSnapshot([{ id: '42', myShare: 9, date: today, desc: 'updated' }]),
  });
  await harness.data.initApi();
  const faultInjector = faultSchedule([{ point: 'after:item-2-effect' }]);
  await assert.rejects(
    harness.data.syncSplitwiseShareExpenses({ sync: false, faultInjector }),
    (error) => error.name === 'SagaInterruption',
  );
  assert.equal(harness.fakeActual.inspect().counts.update, 1);
  await harness.data.syncSplitwiseShareExpenses({ sync: false });
  assert.equal(harness.fakeActual.inspect().counts.update, 1);
  assert.equal(harness.fakeActual.inspect().rows[0].amount, -900);
  fs.rmSync(harness.dir, { recursive: true, force: true });
});

test('multiple matching mirror accounts fail deterministic pre-admission', async () => {
  const harness = makeHarness({ snapshot: completeSnapshot([]) });
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
      categories: [{ id: 'splitwise-category', name: 'Splitwise' }],
    }],
  });
  await harness.data.initApi();
  await assert.rejects(
    harness.data.syncSplitwiseShareExpenses({ sync: false }),
    (error) => error instanceof SplitwiseMirrorAdmissionError
      && error.code === 'SPLITWISE_MIRROR_ACCOUNT_AMBIGUOUS',
  );
  fs.rmSync(harness.dir, { recursive: true, force: true });
});

test('unresolved mirror saga does not block unrelated bulk operation keys', async () => {
  const harness = makeHarness({
    snapshot: completeSnapshot([{ id: '777', myShare: 2, date: today }]),
  });
  await harness.data.initApi();
  writeJson(harness.paths.bulk, {
    schemaVersion: 1,
    sagas: {
      stuck: {
        id: 'stuck',
        recordVersion: 1,
        kind: 'splitwise_mirror',
        operationKey: 'first-key',
        phase: 'unresolved',
        plan: {
          params: { accountName: 'Splitwise', categoryName: 'Splitwise' },
          items: [{
            globalIndex: 0,
            itemType: 'splitwise_create',
            stageId: 'create',
            accountId: 'splitwise-account',
            txnId: null,
            sourceId: '777',
            date: today,
            intent: { sourceId: '777' },
          }],
        },
        itemOutcomes: {},
        cursor: { itemIndex: 0 },
        completedIndexes: [],
        delegatedDeletionSagaIds: {},
        createdAt: nowIso,
        updatedAt: nowIso,
      },
    },
  });
  const result = await harness.data.syncSplitwiseShareExpenses({
    sync: false,
    operationKey: 'fresh-key',
  });
  assert.equal(result.created, 1);
  fs.rmSync(harness.dir, { recursive: true, force: true });
});

test('account enumeration failure during admission writes no saga and performs no mutations', async () => {
  const harness = makeHarness({ snapshot: completeSnapshot([]) });
  await harness.data.initApi();
  harness.fakeActual.setFault('getAccounts', () => {
    throw new Error('Actual account enumeration unavailable');
  });
  await assert.rejects(
    harness.data.syncSplitwiseShareExpenses({ sync: false }),
    (error) => error instanceof SplitwiseMirrorAdmissionError
      && error.code === 'SPLITWISE_MIRROR_ADMISSION_FAILED',
  );
  assertNoMirrorAdmissionEffects(harness);
  fs.rmSync(harness.dir, { recursive: true, force: true });
});

test('category enumeration failure during admission writes no saga and performs no mutations', async () => {
  const harness = makeHarness({ snapshot: completeSnapshot([]) });
  await harness.data.initApi();
  harness.fakeActual.setFault('getCategoryGroups', () => {
    throw new Error('Actual category enumeration unavailable');
  });
  await assert.rejects(
    harness.data.syncSplitwiseShareExpenses({ sync: false }),
    (error) => error instanceof SplitwiseMirrorAdmissionError
      && error.code === 'SPLITWISE_MIRROR_ADMISSION_FAILED',
  );
  assertNoMirrorAdmissionEffects(harness);
  fs.rmSync(harness.dir, { recursive: true, force: true });
});

test('transaction query failure during admission writes no saga and performs no mutations', async () => {
  const harness = makeHarness({
    rows: [{
      id: 'mirror-row',
      account: 'splitwise-account',
      date: today,
      amount: -500,
      notes: 'live #sw-44',
      cleared: true,
      category: 'splitwise-category',
      is_parent: false,
      subtransactions: [],
    }],
    snapshot: completeSnapshot([]),
  });
  await harness.data.initApi();
  harness.fakeActual.setFault('getTransactions', () => {
    throw new Error('Actual transaction query unavailable');
  });
  await assert.rejects(
    harness.data.syncSplitwiseShareExpenses({ sync: false }),
    (error) => error instanceof SplitwiseMirrorAdmissionError
      && error.code === 'SPLITWISE_MIRROR_ADMISSION_FAILED',
  );
  assertNoMirrorAdmissionEffects(harness);
  assert.equal(harness.fakeActual.inspect().rows.length, 1);
  fs.rmSync(harness.dir, { recursive: true, force: true });
});

test('ambiguous fallback category name fails deterministic pre-admission', async () => {
  const harness = makeHarness({ snapshot: completeSnapshot([]) });
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
  await harness.data.initApi();
  await assert.rejects(
    harness.data.syncSplitwiseShareExpenses({ sync: false }),
    (error) => error instanceof SplitwiseMirrorAdmissionError
      && error.code === 'SPLITWISE_MIRROR_CATEGORY_AMBIGUOUS',
  );
  assertNoMirrorAdmissionEffects(harness, { splitwiseCategoryCount: 2 });
  fs.rmSync(harness.dir, { recursive: true, force: true });
});

test('bootstrap category apply-then-throw creates exactly one Splitwise category', async () => {
  const harness = makeHarness({ snapshot: completeSnapshot([]) });
  harness.fakeActual.configure({
    rows: [],
    accounts: [{
      id: 'splitwise-account',
      name: 'Splitwise',
      closed: false,
      offbudget: false,
    }],
    categoryGroups: [{
      id: 'spending',
      name: 'Spending',
      is_income: false,
      categories: [{ id: 'food', name: 'Food' }],
    }],
  });
  await harness.data.initApi();
  const faultInjector = faultSchedule([{ point: 'after:item-1-effect' }]);
  await assert.rejects(
    harness.data.syncSplitwiseShareExpenses({ sync: false, faultInjector }),
    (error) => error.name === 'SagaInterruption',
  );
  const categoriesAfterFault = harness.fakeActual.inspect().categoryGroups
    .flatMap((group) => group.categories || [])
    .filter((category) => category.name === 'Splitwise');
  assert.equal(categoriesAfterFault.length, 1);
  const categoryId = categoriesAfterFault[0].id;
  await harness.data.syncSplitwiseShareExpenses({ sync: false });
  const categoriesAfterRestart = harness.fakeActual.inspect().categoryGroups
    .flatMap((group) => group.categories || [])
    .filter((category) => category.name === 'Splitwise');
  assert.equal(categoriesAfterRestart.length, 1);
  assert.equal(categoriesAfterRestart[0].id, categoryId);
  fs.rmSync(harness.dir, { recursive: true, force: true });
});

test('external deleteTransaction is blocked while mirror saga owns the txn', async () => {
  const row = {
    id: 'mirror-row',
    account: 'splitwise-account',
    date: today,
    amount: -500,
    notes: 'stale #sw-501',
    cleared: true,
    category: 'splitwise-category',
    is_parent: false,
    subtransactions: [],
  };
  const harness = makeHarness({ rows: [row], snapshot: completeSnapshot([]) });
  await harness.data.initApi();
  writeJson(harness.paths.bulk, {
    schemaVersion: 1,
    sagas: {
      active: {
        id: 'active-mirror',
        recordVersion: 1,
        kind: 'splitwise_mirror',
        operationKey: 'mirror-delete-boundary',
        phase: 'items_pending',
        mirrorRuntime: {
          accountId: 'splitwise-account',
          categoryId: 'splitwise-category',
        },
        plan: {
          params: {
            accountName: 'Splitwise',
            categoryName: 'Splitwise',
            resolutions: [],
          },
          items: [
            {
              globalIndex: 0,
              itemType: 'splitwise_bootstrap_account',
              stageId: 'bootstrap_account',
              accountId: null,
              txnId: null,
              sourceId: null,
              date: today,
              intent: { accountName: 'Splitwise' },
            },
            {
              globalIndex: 1,
              itemType: 'splitwise_bootstrap_category',
              stageId: 'bootstrap_category',
              accountId: null,
              txnId: null,
              sourceId: null,
              date: today,
              intent: { categoryName: 'Splitwise' },
            },
            {
              globalIndex: 2,
              itemType: 'splitwise_delete',
              stageId: 'delete',
              accountId: 'splitwise-account',
              txnId: 'mirror-row',
              sourceId: '501',
              date: today,
              identityFingerprint: categoryIdentityFingerprint(row),
              intent: { sourceId: '501', reason: 'removed-from-snapshot' },
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
  await assert.rejects(
    harness.data.deleteTransaction({
      id: 'mirror-row',
      accountId: 'splitwise-account',
      date: today,
    }),
    (error) => error instanceof BulkOperationInProgressError,
  );
  assert.equal(harness.fakeActual.inspect().counts.delete, 0);
  assert.ok(harness.fakeActual.inspect().rows.some((entry) => entry.id === 'mirror-row'));
  assert.equal(Object.keys(readJson(harness.paths.deletion).sagas).length, 0);
  fs.rmSync(harness.dir, { recursive: true, force: true });
});

test('embedded decoy tag in description uses canonical trailing source id on sync and replay', async () => {
  const harness = makeHarness({
    snapshot: completeSnapshot([{
      id: '222',
      myShare: 4,
      date: today,
      desc: 'See #sw-111',
    }]),
  });
  await harness.data.initApi();
  const first = await harness.data.syncSplitwiseShareExpenses({ sync: true });
  assert.equal(first.created, 1);
  assert.equal(first.pruned, 0);
  assert.equal(harness.fakeActual.inspect().counts.add, 1);
  assert.equal(harness.fakeActual.inspect().counts.delete, 0);
  const row = harness.fakeActual.inspect().rows.find((entry) => entry.imported_id === durableImportedId('222'));
  assert.ok(row);
  assert.equal(parseMirrorSourceId(row.notes), '222');
  assert.match(row.notes, /#sw-222$/);
  const replay = await harness.data.syncSplitwiseShareExpenses({ sync: true });
  assert.equal(replay.created, 1);
  assert.equal(replay.pruned, 0);
  assert.equal(harness.fakeActual.inspect().counts.add, 1);
  assert.equal(harness.fakeActual.inspect().counts.delete, 0);
  harness.cleanup();
});

test('imported_id and last tag disagreement fails closed before effects', async () => {
  const harness = makeHarness({
    rows: [{
      id: 'conflict-row',
      account: 'splitwise-account',
      date: today,
      amount: -400,
      notes: 'legacy See #sw-111 #sw-222',
      cleared: true,
      category: 'splitwise-category',
      imported_id: durableImportedId('111'),
      is_parent: false,
      subtransactions: [],
    }],
    snapshot: completeSnapshot([]),
  });
  await harness.data.initApi();
  await assert.rejects(
    harness.data.syncSplitwiseShareExpenses({ sync: false }),
    (error) => error instanceof SplitwiseMirrorAmbiguousError
      && error.sourceIds.includes('111')
      && error.sourceIds.includes('222'),
  );
  harness.cleanup();
});

test('parseMirrorSourceId uses the last tag and buildMirrorNotes keeps canonical tag trailing', () => {
  assert.equal(parseMirrorSourceId('See #sw-111 and also #sw-222'), '222');
  assert.equal(
    buildMirrorNotes({ id: '222', desc: 'See #sw-111', payer: null }),
    'See #sw-222',
  );
  const resolved = resolveMirrorRowSourceId({
    imported_id: durableImportedId('222'),
    notes: 'See #sw-111 #sw-222',
  });
  assert.equal(resolved.disagreement, false);
  assert.equal(resolved.sourceId, '222');
});
