'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const os = require('os');
const path = require('path');
const { createBulkOperationSaga, BulkOperationStateError } = require('../lib/bulk-operation-saga');
const { categoryIdentityFingerprint } = require('../lib/bulk-operation-fingerprint');

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

function isCrashError(error) {
  return error instanceof SagaInterruption || /injected crash/.test(String(error?.message || ''));
}

function writeJson(file, value) {
  fs.writeFileSync(file, `${JSON.stringify(value, null, 2)}\n`);
}

function readJson(file) {
  return JSON.parse(fs.readFileSync(file, 'utf8'));
}

function makeHarness(rows = []) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'darkfinances-bulk-faults-'));
  const paths = {
    sagas: path.join(dir, 'bulk-operation-sagas.json'),
    rules: path.join(dir, 'rules.json'),
    phantomSeen: path.join(dir, 'phantom-seen.json'),
    phantomLog: path.join(dir, 'phantom-log.json'),
  };
  writeJson(paths.rules, {
    rules: [{
      id: 'r1',
      match: 'Merchant',
      categoryId: 'category-new',
      categoryName: 'Dining',
      created: '2026-07-10',
    }],
  });
  writeJson(paths.phantomSeen, { seen: {} });
  writeJson(paths.phantomLog, { deleted: [] });

  const state = {
    rows: structuredClone(rows),
    counts: { update: 0, delete: 0, sync: 0 },
  };

  const api = {
    async getAccounts() {
      return [{ id: 'account', name: 'Account', closed: false, offbudget: false }];
    },
    async getPayees() {
      return [{ id: 'payee', name: 'Merchant' }];
    },
    async getCategoryGroups() {
      return [{
        id: 'group',
        name: 'Spending',
        is_income: false,
        categories: [{ id: 'category-new', name: 'Dining' }],
      }];
    },
    async getTransactions(accountId, start, end) {
      return state.rows
        .filter((row) => row.account === accountId && row.date >= start && row.date <= end)
        .map((row) => structuredClone(row));
    },
    async updateTransaction(id, fields) {
      state.counts.update += 1;
      const row = state.rows.find((candidate) => String(candidate.id) === String(id));
      if (row) Object.assign(row, structuredClone(fields));
    },
    async sync() {
      state.counts.sync += 1;
    },
  };

  const manager = createBulkOperationSaga({
    sagaPath: paths.sagas,
    readRules: () => readJson(paths.rules),
    writeRules: (store) => writeJson(paths.rules, store),
    readPhantomSeen: () => readJson(paths.phantomSeen),
    writePhantomSeen: (store) => writeJson(paths.phantomSeen, store),
    readPhantomLog: () => readJson(paths.phantomLog),
    writePhantomLog: (store) => writeJson(paths.phantomLog, store),
    deleteTransaction: async ({ id }) => {
      state.counts.delete += 1;
      state.rows = state.rows.filter((row) => String(row.id) !== String(id));
      return { ok: true, deleted: id };
    },
    inspectDeletionState: () => ({ schemaVersion: 1, sagas: {} }),
    recoverDeletionSagas: async () => ({ needsSync: false, errors: [] }),
    merchantCatalog: [],
    catalogTypeMatch: {},
    resolveCatalogCategory: () => null,
    buildCatInfo: () => ({}),
    settleUpPayee: /$^/,
    reimbCat: /$^/,
    incomeGroup: /$^/,
    moneyMovementGroup: /$^/,
    todayYMD: () => '2026-07-10',
    addDays: (date, delta) => {
      const next = new Date(`${date}T12:00:00.000Z`);
      next.setUTCDate(next.getUTCDate() + delta);
      return next.toISOString().slice(0, 10);
    },
  });

  return { api, manager, paths, state };
}

const txnA = {
  id: 'txn-a',
  account: 'account',
  date: '2026-07-10',
  amount: -1200,
  payee: 'payee',
  imported_payee: 'Merchant Alpha',
  cleared: true,
  category: null,
  is_parent: false,
  subtransactions: [],
};
const txnB = {
  id: 'txn-b',
  account: 'account',
  date: '2026-07-10',
  amount: -900,
  payee: 'payee',
  imported_payee: 'Merchant Beta',
  cleared: true,
  category: null,
  is_parent: false,
  subtransactions: [],
};

test('legacy defect model: naive restart re-applies completed items', () => {
  const updates = [];
  for (const pass of [1, 2]) {
    for (const txn of [txnA, txnB]) {
      if (pass === 2 && txn.id === 'txn-a') continue;
      updates.push(txn.id);
    }
  }
  assert.deepEqual(updates, ['txn-a', 'txn-b', 'txn-b']);
});

test('checkpointed rules apply skips completed item-0 after crash at item-1', async () => {
  const { api, manager, state, paths } = makeHarness([txnA, txnB]);
  const operationKey = 'bulk-fault-rules-apply';
  let crashOnce = true;
  const faultInjector = async (point) => {
    if (crashOnce && point === 'after:item-0-applied-checkpoint') {
      crashOnce = false;
      throw new Error('crash after item 0');
    }
  };

  await assert.rejects(
    manager.run(api, {
      kind: 'rules_apply',
      operationKey,
      faultInjector,
      deferSync: true,
    }),
    /crash after item 0/,
  );
  assert.equal(state.counts.update, 1);
  assert.equal(state.rows.find((row) => row.id === 'txn-a').category, 'category-new');

  const result = await manager.run(api, {
    kind: 'rules_apply',
    operationKey,
    deferSync: true,
  });
  assert.equal(result.applied, 2);
  assert.equal(state.counts.update, 2);
  assert.equal(state.rows.every((row) => row.category === 'category-new'), true);

  const saga = Object.values(readJson(paths.sagas).sagas)[0];
  assert.deepEqual(saga.completedIndexes, [0, 1]);
});

test('saveRule converges rules sidecar after auto-apply checkpoint', async () => {
  const { api, manager, paths, state } = makeHarness([txnA]);
  const rule = {
    id: 'r-new',
    match: 'Merchant',
    categoryId: 'category-new',
    categoryName: 'Dining',
    created: '2026-07-10',
  };
  let crashOnce = true;
  const faultInjector = async (point, meta) => {
    if (crashOnce && point === 'after:item-0-applied-checkpoint' && meta?.itemIndex === 0) {
      crashOnce = false;
      throw new Error('crash before sidecar');
    }
  };

  await assert.rejects(
    manager.run(api, {
      kind: 'rules_save',
      operationKey: 'bulk-fault-save',
      params: { rule },
      faultInjector,
      deferSync: true,
    }),
    /crash before sidecar/,
  );
  assert.equal(readJson(paths.rules).rules.some((entry) => entry.id === 'r-new'), false);
  assert.equal(state.rows[0].category, 'category-new');

  const result = await manager.run(api, {
    kind: 'rules_save',
    operationKey: 'bulk-fault-save',
    params: { rule },
    deferSync: true,
  });
  assert.equal(result.applied, 1);
  assert.equal(readJson(paths.rules).rules.some((entry) => entry.id === 'r-new'), true);
});

test('transient category failure stays pending and retries after two restarts', async () => {
  const { api, manager, state, paths } = makeHarness([txnA, txnB]);
  let attempts = 0;
  const faultInjector = async (point) => {
    if (point === 'before:item-1-effect') {
      attempts += 1;
      if (attempts <= 2) throw new Error('transient category apply failure');
    }
  };

  await assert.rejects(
    manager.run(api, {
      kind: 'rules_apply',
      operationKey: 'transient-item-1',
      faultInjector,
      deferSync: true,
    }),
    /transient category apply failure/,
  );
  assert.equal(state.counts.update, 1);
  const mid = Object.values(readJson(paths.sagas).sagas)[0];
  assert.equal(mid.itemOutcomes['1'], undefined);
  assert.ok(mid.lastError);

  await assert.rejects(
    manager.run(api, {
      kind: 'rules_apply',
      operationKey: 'transient-item-1',
      faultInjector,
      deferSync: true,
    }),
    /transient category apply failure/,
  );
  assert.equal(state.counts.update, 1);

  const result = await manager.run(api, {
    kind: 'rules_apply',
    operationKey: 'transient-item-1',
    deferSync: true,
  });
  assert.equal(result.applied, 2);
  assert.equal(state.counts.update, 2);
});

test('apply-then-throw after category effect converges without duplicate update', async () => {
  const { api, manager, state } = makeHarness([txnA]);
  let crashOnce = true;
  const faultInjector = async (point) => {
    if (crashOnce && point === 'before:item-0-verify-checkpoint') {
      crashOnce = false;
      throw new Error('crash after category effect');
    }
  };

  await assert.rejects(
    manager.run(api, {
      kind: 'rules_apply',
      operationKey: 'apply-then-throw',
      faultInjector,
      deferSync: true,
    }),
    /crash after category effect/,
  );
  assert.equal(state.counts.update, 1);
  assert.equal(state.rows[0].category, 'category-new');

  const result = await manager.run(api, {
    kind: 'rules_apply',
    operationKey: 'apply-then-throw',
    deferSync: true,
  });
  assert.equal(result.applied, 1);
  assert.equal(state.counts.update, 1);
});

test('two independent bulk records recover when one remains broken', async () => {
  const { api, manager, paths, state } = makeHarness([txnA]);
  writeJson(paths.rules, { rules: [] });

  await manager.run(api, {
    kind: 'rules_apply',
    operationKey: 'healthy-bulk',
    deferSync: true,
  });
  assert.equal(state.counts.update, 0);

  const broken = {
    id: 'broken',
    recordVersion: 1,
    kind: 'rules_apply',
    operationKey: 'broken-bulk',
    phase: 'items_pending',
    params: {},
    plan: {
      items: [{
        globalIndex: 0,
        itemType: 'category_update',
        stageId: 'rule:missing',
        accountId: 'account',
        txnId: 'missing-txn',
        date: '2026-07-10',
        identityFingerprint: 'deadbeef',
        intent: { categoryId: 'category-new' },
      }],
    },
    cursor: { itemIndex: 0 },
    completedIndexes: [],
    itemOutcomes: {},
    delegatedDeletionSagaIds: {},
    createdAt: new Date().toISOString(),
    updatedAt: new Date().toISOString(),
  };
  const store = readJson(paths.sagas);
  store.sagas[broken.id] = broken;
  writeJson(paths.sagas, store);

  const recovery = await manager.recover(api, { deferSync: true });
  assert.equal(recovery.errors.length, 1);
  assert.equal(Object.values(readJson(paths.sagas).sagas).some((saga) => saga.operationKey === 'healthy-bulk' && saga.phase === 'sync_pending'), true);
});

async function finishBulk(api, manager, operationKey, kind, params = {}) {
  const result = await manager.run(api, {
    kind,
    operationKey,
    params,
    deferSync: false,
  });
  assert.equal(result.ok, true);
  return result;
}

async function interruptRulesApply(api, manager, operationKey, injector, params = {}) {
  await assert.rejects(
    manager.run(api, {
      kind: 'rules_apply',
      operationKey,
      params,
      faultInjector: injector,
      deferSync: true,
    }),
    isCrashError,
  );
  assert.ok(injector.queue.every((entry) => entry.fired), 'requested fault was reached');
}

const RULES_APPLY_BOUNDARIES = [
  'after:initial-saga-write',
  'after:plan-checkpoint',
  'after:items-start-checkpoint',
  'after:item-0-pending-checkpoint',
  'after:item-0-effect',
  'after:item-0-verify-checkpoint',
  'after:item-0-applied-checkpoint',
  'after:item-1-pending-checkpoint',
  'after:item-1-effect',
  'after:item-1-verify-checkpoint',
  'after:item-1-applied-checkpoint',
  'after:sidecars-pending-checkpoint',
  'after:sync-pending-checkpoint',
];

test('rules apply converges across injectable checkpoint boundaries', async (t) => {
  for (const boundary of RULES_APPLY_BOUNDARIES) {
    await t.test(boundary, async () => {
      const { api, manager, state } = makeHarness([txnA, txnB]);
      const operationKey = `rules-boundary-${boundary.replace(/[:]/g, '-')}`;
      const injector = faultSchedule([{ point: boundary }]);
      await interruptRulesApply(api, manager, operationKey, injector);
      const midUpdates = state.counts.update;
      const result = await finishBulk(api, manager, operationKey, 'rules_apply');
      assert.equal(result.applied, 2);
      assert.equal(state.counts.update, Math.max(midUpdates, 2));
      assert.equal(state.rows.every((row) => row.category === 'category-new'), true);
    });
  }
});

test('sync and terminal boundaries converge without duplicate updates', async (t) => {
  for (const boundary of ['after:sync', 'after:saga-terminal-write']) {
    await t.test(boundary, async () => {
      const { api, manager, state } = makeHarness([txnA]);
      const operationKey = `rules-sync-${boundary.replace(/[:]/g, '-')}`;
      const injector = faultSchedule([{ point: boundary }]);
      await assert.rejects(
        manager.run(api, {
          kind: 'rules_apply',
          operationKey,
          faultInjector: injector,
          deferSync: false,
        }),
        isCrashError,
      );
      const result = await finishBulk(api, manager, operationKey, 'rules_apply');
      assert.equal(result.applied, 1);
      assert.equal(state.counts.update, 1);
    });
  }
});

test('zero-item rules apply reaches sync_pending without ok', async () => {
  const { api, manager } = makeHarness([]);
  const result = await manager.run(api, {
    kind: 'rules_apply',
    operationKey: 'zero-item-fault',
    deferSync: true,
  });
  assert.equal(result.applied, 0);
  assert.equal(result.ok, false);
  assert.equal(result.status, 'in_progress');
});

test('rule precedence claims each transaction once', async () => {
  const harness = makeHarness([txnA]);
  writeJson(harness.paths.rules, {
    rules: [
      { id: 'first', match: 'Merchant', categoryId: 'category-new', categoryName: 'Dining', created: '2026-07-10' },
      { id: 'second', match: 'Alpha', categoryId: 'category-other', categoryName: 'Other', created: '2026-07-10' },
    ],
  });
  await harness.manager.run(harness.api, {
    kind: 'rules_apply',
    operationKey: 'precedence',
    deferSync: true,
  });
  const saga = Object.values(readJson(harness.paths.sagas).sagas)[0];
  assert.equal(saga.plan.items.length, 1);
  assert.equal(saga.plan.items[0].stageId, 'rule:first');
  assert.equal(harness.state.rows[0].category, 'category-new');
});

test('save-rule sidecar boundary converges without duplicate rule write', async () => {
  const { api, manager, paths, state } = makeHarness([txnA]);
  const rule = {
    id: 'r-sidecar',
    match: 'Merchant',
    categoryId: 'category-new',
    categoryName: 'Dining',
    created: '2026-07-10',
  };
  const operationKey = 'save-sidecar-boundary';
  const injector = faultSchedule([{ point: 'before:item-1-rules-sidecar-write' }]);
  await assert.rejects(
    manager.run(api, {
      kind: 'rules_save',
      operationKey,
      params: { rule },
      faultInjector: injector,
      deferSync: true,
    }),
    isCrashError,
  );
  assert.equal(readJson(paths.rules).rules.some((entry) => entry.id === 'r-sidecar'), false);
  assert.equal(state.rows[0].category, 'category-new');
  const result = await finishBulk(api, manager, operationKey, 'rules_save', { rule });
  assert.equal(result.applied, 1);
  assert.equal(readJson(paths.rules).rules.filter((entry) => entry.id === 'r-sidecar').length, 1);
});

test('bounded lastError redacts bearer and authorization secrets', async () => {
  const { api, manager, paths } = makeHarness([txnA, txnB]);
  const injector = async (point) => {
    if (point === 'before:item-1-effect') {
      throw new Error('upstream failed Authorization: Bearer secret-token-value');
    }
  };
  await assert.rejects(
    manager.run(api, {
      kind: 'rules_apply',
      operationKey: 'redaction',
      faultInjector: injector,
      deferSync: true,
    }),
    /upstream failed/,
  );
  const saga = Object.values(readJson(paths.sagas).sagas)[0];
  assert.match(saga.lastError.message, /Authorization:\s*\[redacted\]/);
  assert.doesNotMatch(saga.lastError.message, /secret-token-value/);
});

test('repeated terminal restart returns stable completed result', async () => {
  const { api, manager } = makeHarness([txnA]);
  const operationKey = 'terminal-repeat';
  const first = await finishBulk(api, manager, operationKey, 'rules_apply');
  const second = await manager.run(api, { kind: 'rules_apply', operationKey, deferSync: false });
  assert.deepEqual(second, first);
  assert.equal(second.ok, true);
});

test('foreign account duplication fails closed unresolved', async () => {
  const { api, manager, state } = makeHarness([txnA]);
  const operationKey = 'foreign-account';
  const injector = faultSchedule([{ point: 'after:item-0-effect' }]);
  await assert.rejects(
    manager.run(api, {
      kind: 'rules_apply',
      operationKey,
      faultInjector: injector,
      deferSync: true,
    }),
    isCrashError,
  );
  state.rows.push({ ...structuredClone(txnA), account: 'foreign' });
  api.getAccounts = async () => [
    { id: 'account', name: 'Account', closed: false, offbudget: false },
    { id: 'foreign', name: 'Foreign', closed: false, offbudget: false },
  ];
  api.getTransactions = async (accountId) => state.rows
    .filter((row) => row.account === accountId)
    .map((row) => structuredClone(row));
  await assert.rejects(
    manager.run(api, { kind: 'rules_apply', operationKey, deferSync: true }),
    /found outside recorded account/,
  );
});

test('moved account fails closed unresolved', async () => {
  const { api, manager, state } = makeHarness([txnA, txnB]);
  const operationKey = 'moved-account';
  const injector = faultSchedule([{ point: 'after:item-0-applied-checkpoint' }]);
  await interruptRulesApply(api, manager, operationKey, injector);
  const moved = state.rows.find((row) => row.id === 'txn-b');
  moved.account = 'other-account';
  api.getAccounts = async () => [
    { id: 'account', name: 'Account', closed: false, offbudget: false },
    { id: 'other-account', name: 'Other', closed: false, offbudget: false },
  ];
  api.getTransactions = async (accountId) => state.rows
    .filter((row) => row.account === accountId)
    .map((row) => structuredClone(row));
  await assert.rejects(
    manager.run(api, { kind: 'rules_apply', operationKey, deferSync: true }),
    /found outside recorded account/,
  );
});

test('incompatible identity mutation fails closed unresolved', async () => {
  const { api, manager, state } = makeHarness([txnA, txnB]);
  const operationKey = 'identity-drift';
  const injector = faultSchedule([{ point: 'after:item-0-applied-checkpoint' }]);
  await interruptRulesApply(api, manager, operationKey, injector);
  const drifted = state.rows.find((row) => row.id === 'txn-b');
  drifted.amount = -9999;
  await assert.rejects(
    manager.run(api, { kind: 'rules_apply', operationKey, deferSync: true }),
    /identity changed incompatibly/,
  );
});

function makePhantomHarness() {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'darkfinances-bulk-phantom-faults-'));
  const paths = {
    sagas: path.join(dir, 'bulk-operation-sagas.json'),
    rules: path.join(dir, 'rules.json'),
    phantomSeen: path.join(dir, 'phantom-seen.json'),
    phantomLog: path.join(dir, 'phantom-log.json'),
    deletionSagas: path.join(dir, 'transaction-deletion-sagas.json'),
  };
  writeJson(paths.rules, { rules: [] });
  writeJson(paths.phantomSeen, { seen: {} });
  writeJson(paths.phantomLog, { deleted: [] });
  writeJson(paths.deletionSagas, { schemaVersion: 1, sagas: {} });

  const pending = {
    id: 'phantom-pending',
    account: 'account',
    date: '2026-06-01',
    amount: -1200,
    payee: 'payee',
    imported_payee: 'Merchant Cafe',
    cleared: false,
    imported_id: 'bank-import-1',
    is_parent: false,
    subtransactions: [],
  };
  const cleared = {
    id: 'phantom-cleared',
    account: 'account',
    date: '2026-06-02',
    amount: -1200,
    payee: 'payee',
    imported_payee: 'Merchant Cafe',
    cleared: true,
    category: null,
    is_parent: false,
    subtransactions: [],
  };

  const state = {
    rows: [pending, cleared],
    counts: { delete: 0, sync: 0 },
  };

  const api = {
    async getAccounts() {
      return [{ id: 'account', name: 'Account', closed: false, offbudget: false }];
    },
    async getPayees() {
      return [{ id: 'payee', name: 'Merchant Cafe' }];
    },
    async getCategoryGroups() {
      return [{ id: 'group', name: 'Spending', is_income: false, categories: [] }];
    },
    async getTransactions(accountId, start, end) {
      return state.rows
        .filter((row) => row.account === accountId && row.date >= start && row.date <= end)
        .map((row) => structuredClone(row));
    },
    async sync() {
      state.counts.sync += 1;
    },
  };

  let manager;
  const deleteTransaction = async ({ id, bulkDelegation } = {}) => {
    if (!bulkDelegation) throw new Error('bulk delegation required');
    manager.assertDeletionDelegationAuthorized(bulkDelegation);
    const sagaId = `del-${id}`;
    const now = new Date().toISOString();
    const deletionState = readJson(paths.deletionSagas);
    deletionState.sagas[sagaId] = {
      id: sagaId,
      recordVersion: 1,
      phase: 'sync_pending',
      target: { parentId: id, legIds: [], ids: [id] },
      updatedAt: now,
    };
    writeJson(paths.deletionSagas, deletionState);
    state.counts.delete += 1;
    state.rows = state.rows.filter((row) => String(row.id) !== String(id));
    return { ok: true, deleted: id, sagaId };
  };

  manager = createBulkOperationSaga({
    sagaPath: paths.sagas,
    readRules: () => readJson(paths.rules),
    writeRules: (store) => writeJson(paths.rules, store),
    readPhantomSeen: () => readJson(paths.phantomSeen),
    writePhantomSeen: (store) => writeJson(paths.phantomSeen, store),
    readPhantomLog: () => readJson(paths.phantomLog),
    writePhantomLog: (store) => writeJson(paths.phantomLog, store),
    deleteTransaction,
    inspectDeletionState: () => readJson(paths.deletionSagas),
    recoverDeletionSagas: async () => {
      const deletionState = readJson(paths.deletionSagas);
      for (const saga of Object.values(deletionState.sagas)) {
        if (saga.phase === 'sync_pending') {
          saga.phase = 'completed';
          saga.terminalAt = new Date().toISOString();
        }
      }
      writeJson(paths.deletionSagas, deletionState);
      return { needsSync: false, errors: [] };
    },
    merchantCatalog: [],
    catalogTypeMatch: {},
    resolveCatalogCategory: () => null,
    buildCatInfo: () => ({}),
    settleUpPayee: /$^/,
    reimbCat: /$^/,
    incomeGroup: /$^/,
    moneyMovementGroup: /$^/,
    todayYMD: () => '2026-07-10',
    addDays: (date, delta) => {
      const next = new Date(`${date}T12:00:00.000Z`);
      next.setUTCDate(next.getUTCDate() + delta);
      return next.toISOString().slice(0, 10);
    },
  });

  return {
    api,
    manager,
    paths,
    state,
    pending,
    phantomParams: {
      window: 60,
      agedDays: 0,
      observeDays: 0,
      holdAgedDays: 0,
      holdObserveDays: 0,
    },
  };
}

test('phantom deletion handoff performs one delete and one log entry', async () => {
  const { api, manager, paths, state, phantomParams } = makePhantomHarness();
  const operationKey = 'phantom-one-delete';
  const result = await finishBulk(api, manager, operationKey, 'phantom_cleanup', phantomParams);
  assert.equal(state.counts.delete, 1);
  assert.equal(result.deletedCount, 1);
  assert.equal(result.deleted[0].id, 'phantom-pending');
  const log = readJson(paths.phantomLog);
  assert.equal(log.deleted.length, 1);
  assert.equal(log.deleted[0].id, 'phantom-pending');
  assert.equal(Object.keys(readJson(paths.phantomSeen).seen).length, 0);
});

test('phantom crash after deletion discovers saga by txn id without re-delete', async () => {
  const { api, manager, paths, state, phantomParams, pending } = makePhantomHarness();
  const operationKey = 'phantom-delegation-crash';
  const partial = await manager.run(api, {
    kind: 'phantom_cleanup',
    operationKey,
    params: phantomParams,
    deferSync: true,
  });
  assert.equal(partial.ok, false);

  const bulkStore = readJson(paths.sagas);
  const saga = Object.values(bulkStore.sagas)[0];
  const deleteItem = saga.plan.items.find((item) => item.itemType === 'phantom_delete');
  assert.ok(deleteItem);
  saga.phase = 'items_pending';
  saga.cursor = { itemIndex: deleteItem.globalIndex };
  saga.activeDelegation = {
    itemIndex: deleteItem.globalIndex,
    txnId: pending.id,
    token: 'resume-token',
  };
  saga.delegatedDeletionSagaIds = {};
  saga.itemOutcomes = Object.fromEntries(
    saga.plan.items
      .filter((item) => item.globalIndex < deleteItem.globalIndex)
      .map((item) => [String(item.globalIndex), { status: 'completed' }]),
  );
  writeJson(paths.sagas, bulkStore);
  writeJson(paths.deletionSagas, {
    schemaVersion: 1,
    sagas: {
      'del-phantom-pending': {
        id: 'del-phantom-pending',
        recordVersion: 1,
        phase: 'sync_pending',
        target: { parentId: pending.id, legIds: [], ids: [pending.id] },
        updatedAt: new Date().toISOString(),
      },
    },
  });
  state.rows = state.rows.filter((row) => row.id !== pending.id);
  state.counts.delete = 1;

  const result = await finishBulk(api, manager, operationKey, 'phantom_cleanup', phantomParams);
  assert.equal(state.counts.delete, 1);
  assert.equal(result.deletedCount, 1);
  const finished = Object.values(readJson(paths.sagas).sagas)[0];
  assert.equal(finished.delegatedDeletionSagaIds[pending.id], 'del-phantom-pending');
});

function isRecordedDeletionSagaId(value) {
  return typeof value === 'string' && value.length > 0 && value !== 'pending';
}

test('phantom absent target without delegation fails closed unresolved', async () => {
  const { api, manager, state, phantomParams } = makePhantomHarness();
  const operationKey = 'phantom-absent';
  const injector = faultSchedule([{ point: 'after:item-1-pending-checkpoint' }]);
  await assert.rejects(
    manager.run(api, {
      kind: 'phantom_cleanup',
      operationKey,
      params: phantomParams,
      faultInjector: injector,
      deferSync: true,
    }),
    isCrashError,
  );
  state.rows = state.rows.filter((row) => row.id !== 'phantom-pending');
  await assert.rejects(
    manager.run(api, {
      kind: 'phantom_cleanup',
      operationKey,
      params: phantomParams,
      deferSync: true,
    }),
    /absent without a recorded deletion delegation/,
  );
});

test('phantom sidecar boundaries converge with one log write', async (t) => {
  const boundaries = [
    'after:item-0-phantom-seen-write',
    'before:item-1-phantom-seen-removal',
    'after:item-1-phantom-log-write',
  ];
  for (const boundary of boundaries) {
    await t.test(boundary, async () => {
      const { api, manager, paths, state, phantomParams } = makePhantomHarness();
      const operationKey = `phantom-sidecar-${boundary.replace(/[:]/g, '-')}`;
      const injector = faultSchedule([{ point: boundary }]);
      await assert.rejects(
        manager.run(api, {
          kind: 'phantom_cleanup',
          operationKey,
          params: phantomParams,
          faultInjector: injector,
          deferSync: true,
        }),
        isCrashError,
      );
      const result = await finishBulk(api, manager, operationKey, 'phantom_cleanup', phantomParams);
      assert.equal(state.counts.delete, 1);
      assert.equal(readJson(paths.phantomLog).deleted.length, 1);
      assert.equal(result.deletedCount, 1);
    });
  }
});

test('delegation token rejects unauthorized deletion admission', () => {
  const { manager } = makePhantomHarness();
  assert.throws(
    () => manager.assertDeletionDelegationAuthorized({
      sagaId: 'missing',
      itemIndex: 0,
      token: 'wrong',
      txnId: 'phantom-pending',
      accountId: 'account',
    }),
    (error) => error.code === 'BULK_OPERATION_IN_PROGRESS',
  );
});

test('phantom prune write boundary converges without duplicate prune', async (t) => {
  for (const boundary of ['before:item-0-phantom-prune-write', 'after:item-0-phantom-prune-write']) {
    await t.test(boundary, async () => {
      const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'darkfinances-bulk-prune-faults-'));
      const paths = {
        sagas: path.join(dir, 'bulk-operation-sagas.json'),
        rules: path.join(dir, 'rules.json'),
        phantomSeen: path.join(dir, 'phantom-seen.json'),
        phantomLog: path.join(dir, 'phantom-log.json'),
        deletionSagas: path.join(dir, 'transaction-deletion-sagas.json'),
      };
      writeJson(paths.rules, { rules: [] });
      writeJson(paths.phantomSeen, {
        seen: {
          'stale-prune': {
            firstSeen: '2026-01-01T00:00:00.000Z',
            lastSeen: '2026-01-01T00:00:00.000Z',
            date: '2026-01-01',
            payee: 'Old Merchant',
            amount: 12,
          },
        },
      });
      writeJson(paths.phantomLog, { deleted: [] });
      writeJson(paths.deletionSagas, { schemaVersion: 1, sagas: {} });

      const state = { pruneWrites: 0 };
      const api = {
        async getAccounts() {
          return [{ id: 'account', name: 'Account', closed: false, offbudget: false }];
        },
        async getPayees() {
          return [{ id: 'payee', name: 'Merchant' }];
        },
        async getCategoryGroups() {
          return [{ id: 'group', name: 'Spending', is_income: false, categories: [] }];
        },
        async getTransactions() {
          return [];
        },
        async sync() {},
      };

      const manager = createBulkOperationSaga({
        sagaPath: paths.sagas,
        readRules: () => readJson(paths.rules),
        writeRules: (store) => writeJson(paths.rules, store),
        readPhantomSeen: () => readJson(paths.phantomSeen),
        writePhantomSeen: (store) => {
          state.pruneWrites += 1;
          writeJson(paths.phantomSeen, store);
        },
        readPhantomLog: () => readJson(paths.phantomLog),
        writePhantomLog: (store) => writeJson(paths.phantomLog, store),
        deleteTransaction: async () => ({ ok: true }),
        inspectDeletionState: () => readJson(paths.deletionSagas),
        recoverDeletionSagas: async () => ({ needsSync: false, errors: [] }),
        merchantCatalog: [],
        catalogTypeMatch: {},
        resolveCatalogCategory: () => null,
        buildCatInfo: () => ({}),
        settleUpPayee: /$^/,
        reimbCat: /$^/,
        incomeGroup: /$^/,
        moneyMovementGroup: /$^/,
        todayYMD: () => '2026-07-10',
        addDays: (date, delta) => {
          const next = new Date(`${date}T12:00:00.000Z`);
          next.setUTCDate(next.getUTCDate() + delta);
          return next.toISOString().slice(0, 10);
        },
      });

      const operationKey = `phantom-prune-${boundary.replace(/[:]/g, '-')}`;
      const injector = faultSchedule([{ point: boundary }]);
      await assert.rejects(
        manager.run(api, {
          kind: 'phantom_cleanup',
          operationKey,
          params: {
            window: 60,
            agedDays: 0,
            observeDays: 0,
            holdAgedDays: 0,
            holdObserveDays: 0,
          },
          faultInjector: injector,
          deferSync: true,
        }),
        isCrashError,
      );
      const result = await finishBulk(api, manager, operationKey, 'phantom_cleanup', {
        window: 60,
        agedDays: 0,
        observeDays: 0,
        holdAgedDays: 0,
        holdObserveDays: 0,
      });
      assert.equal(result.auditOutcome.applied, 1);
      assert.equal(state.pruneWrites, 1);
      assert.equal(readJson(paths.phantomSeen).seen['stale-prune'], undefined);
    });
  }
});

test('account closed after plan fails closed unresolved on recovery', async () => {
  const { api, manager, state } = makeHarness([txnA]);
  const operationKey = 'account-closed';
  const injector = faultSchedule([{ point: 'after:plan-checkpoint' }]);
  await assert.rejects(
    manager.run(api, {
      kind: 'rules_apply',
      operationKey,
      faultInjector: injector,
      deferSync: true,
    }),
    isCrashError,
  );
  api.getAccounts = async () => [{ id: 'account', name: 'Account', closed: true, offbudget: false }];
  await assert.rejects(
    manager.run(api, { kind: 'rules_apply', operationKey, deferSync: true }),
    /closed after bulk plan checkpoint/,
  );
  assert.equal(state.counts.update, 0);
});

test('zero-item bulk terminalizes without calling Actual sync', async () => {
  const { api, manager } = makeHarness([]);
  let syncCalls = 0;
  api.sync = async () => { syncCalls += 1; };
  const result = await manager.run(api, {
    kind: 'rules_apply',
    operationKey: 'zero-no-sync',
    deferSync: false,
  });
  assert.equal(result.ok, true);
  assert.equal(result.status, 'completed');
  assert.equal(result.needsSync, false);
  assert.equal(syncCalls, 0);
});

test('finishSync uses one shared Actual sync for two sagas', async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'darkfinances-bulk-shared-sync-'));
  const paths = { sagas: path.join(dir, 'bulk-operation-sagas.json'), rules: path.join(dir, 'rules.json'), phantomSeen: path.join(dir, 'phantom-seen.json'), phantomLog: path.join(dir, 'phantom-log.json') };
  writeJson(paths.rules, { rules: [] });
  writeJson(paths.phantomSeen, { seen: {} });
  writeJson(paths.phantomLog, { deleted: [] });
  const now = new Date().toISOString();
  writeJson(paths.sagas, {
    schemaVersion: 1,
    sagas: {
      a: {
        id: 'a',
        recordVersion: 1,
        kind: 'rules_apply',
        operationKey: 'bulk-a',
        phase: 'sync_pending',
        plan: {
          items: [{
            globalIndex: 0,
            itemType: 'category_update',
            stageId: 'rule:r1',
            accountId: 'account',
            txnId: 'txn-a',
            date: '2026-07-10',
            identityFingerprint: categoryIdentityFingerprint(txnA),
            accountOpenAtPlan: true,
            intent: { categoryId: 'category-new' },
          }],
        },
        itemOutcomes: { 0: { status: 'completed' } },
        createdAt: now,
        updatedAt: now,
      },
      b: {
        id: 'b',
        recordVersion: 1,
        kind: 'rules_apply',
        operationKey: 'bulk-b',
        phase: 'sync_pending',
        plan: { items: [] },
        itemOutcomes: {},
        createdAt: now,
        updatedAt: now,
      },
    },
  });
  let syncCalls = 0;
  const api = {
    async getAccounts() { return [{ id: 'account', name: 'Account', closed: false, offbudget: false }]; },
    async getPayees() { return [{ id: 'payee', name: 'Merchant' }]; },
    async getCategoryGroups() { return [{ id: 'group', name: 'Spending', is_income: false, categories: [{ id: 'category-new', name: 'Dining' }] }]; },
    async getTransactions() { return []; },
    async sync() { syncCalls += 1; },
  };
  const manager = createBulkOperationSaga({
    sagaPath: paths.sagas,
    readRules: () => readJson(paths.rules),
    writeRules: (store) => writeJson(paths.rules, store),
    readPhantomSeen: () => readJson(paths.phantomSeen),
    writePhantomSeen: (store) => writeJson(paths.phantomSeen, store),
    readPhantomLog: () => readJson(paths.phantomLog),
    writePhantomLog: (store) => writeJson(paths.phantomLog, store),
    deleteTransaction: async () => ({ ok: true }),
    inspectDeletionState: () => ({ schemaVersion: 1, sagas: {} }),
    recoverDeletionSagas: async () => ({ needsSync: false, errors: [] }),
    merchantCatalog: [],
    catalogTypeMatch: {},
    resolveCatalogCategory: () => null,
    buildCatInfo: () => ({}),
    settleUpPayee: /$^/,
    reimbCat: /$^/,
    incomeGroup: /$^/,
    moneyMovementGroup: /$^/,
    todayYMD: () => '2026-07-10',
    addDays: (date, delta) => {
      const next = new Date(`${date}T12:00:00.000Z`);
      next.setUTCDate(next.getUTCDate() + delta);
      return next.toISOString().slice(0, 10);
    },
  });
  await manager.recover(api);
  assert.equal(syncCalls, 1);
  const store = readJson(paths.sagas);
  assert.equal(store.sagas.a.phase, 'completed');
  assert.equal(store.sagas.b.phase, 'completed');
  assert.equal(store.sagas.a.auditOutcome.status, 'completed');
  assert.equal(store.sagas.b.auditOutcome.status, 'completed');
});

test('terminal checkpoint failure on one saga does not falsely complete it', async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'darkfinances-bulk-terminal-fault-'));
  const paths = { sagas: path.join(dir, 'bulk-operation-sagas.json'), rules: path.join(dir, 'rules.json'), phantomSeen: path.join(dir, 'phantom-seen.json'), phantomLog: path.join(dir, 'phantom-log.json') };
  writeJson(paths.rules, { rules: [] });
  writeJson(paths.phantomSeen, { seen: {} });
  writeJson(paths.phantomLog, { deleted: [] });
  const now = new Date().toISOString();
  writeJson(paths.sagas, {
    schemaVersion: 1,
    sagas: {
      fail: {
        id: 'fail',
        recordVersion: 1,
        kind: 'rules_apply',
        operationKey: 'bulk-fail',
        phase: 'sync_pending',
        plan: { items: [] },
        itemOutcomes: {},
        createdAt: now,
        updatedAt: now,
      },
      ok: {
        id: 'ok',
        recordVersion: 1,
        kind: 'rules_apply',
        operationKey: 'bulk-ok',
        phase: 'sync_pending',
        plan: { items: [] },
        itemOutcomes: {},
        createdAt: now,
        updatedAt: now,
      },
    },
  });
  const api = { async sync() {} };
  const manager = createBulkOperationSaga({
    sagaPath: paths.sagas,
    readRules: () => readJson(paths.rules),
    writeRules: (store) => writeJson(paths.rules, store),
    readPhantomSeen: () => readJson(paths.phantomSeen),
    writePhantomSeen: (store) => writeJson(paths.phantomSeen, store),
    readPhantomLog: () => readJson(paths.phantomLog),
    writePhantomLog: (store) => writeJson(paths.phantomLog, store),
    deleteTransaction: async () => ({ ok: true }),
    inspectDeletionState: () => ({ schemaVersion: 1, sagas: {} }),
    recoverDeletionSagas: async () => ({ needsSync: false, errors: [] }),
    merchantCatalog: [],
    catalogTypeMatch: {},
    resolveCatalogCategory: () => null,
    buildCatInfo: () => ({}),
    settleUpPayee: /$^/,
    reimbCat: /$^/,
    incomeGroup: /$^/,
    moneyMovementGroup: /$^/,
    todayYMD: () => '2026-07-10',
    addDays: (date, delta) => {
      const next = new Date(`${date}T12:00:00.000Z`);
      next.setUTCDate(next.getUTCDate() + delta);
      return next.toISOString().slice(0, 10);
    },
  });
  let failOnce = true;
  const faultInjector = async (point, meta) => {
    if (failOnce && point === 'before:saga-terminal-write' && meta?.sagaId === 'fail') {
      failOnce = false;
      throw new SagaInterruption('terminal fault');
    }
  };
  await assert.rejects(manager.markSynced(api, { faultInjector }), isCrashError);
  const mid = readJson(paths.sagas);
  assert.equal(mid.sagas.fail.phase, 'sync_pending');
  assert.equal(mid.sagas.ok.phase, 'completed');
  await manager.markSynced(api);
  assert.equal(readJson(paths.sagas).sagas.fail.phase, 'completed');
});

test('rules sidecar drift with same rule id fails closed unresolved', async () => {
  const { api, manager, paths, state } = makeHarness([txnA]);
  const rule = {
    id: 'r-drift',
    match: 'Merchant',
    categoryId: 'category-new',
    categoryName: 'Dining',
    created: '2026-07-10',
  };
  const operationKey = 'rules-sidecar-drift';
  const injector = faultSchedule([{ point: 'after:item-0-applied-checkpoint' }]);
  await assert.rejects(
    manager.run(api, {
      kind: 'rules_save',
      operationKey,
      params: { rule },
      faultInjector: injector,
      deferSync: true,
    }),
    isCrashError,
  );
  writeJson(paths.rules, {
    schemaVersion: 1,
    rules: [{ ...rule, categoryId: 'category-wrong' }],
  });
  await assert.rejects(
    manager.run(api, {
      kind: 'rules_save',
      operationKey,
      params: { rule },
      deferSync: true,
    }),
    /rules sidecar diverged for rule r-drift/,
  );
  assert.equal(state.counts.update, 1);
});

test('stale delegation token is rejected once deletion saga exists', async () => {
  const { api, manager, paths, pending, phantomParams } = makePhantomHarness();
  const operationKey = 'stale-delegation';
  await manager.run(api, {
    kind: 'phantom_cleanup',
    operationKey,
    params: phantomParams,
    deferSync: true,
  });
  const store = readJson(paths.sagas);
  const saga = Object.values(store.sagas)[0];
  const deleteItem = saga.plan.items.find((item) => item.itemType === 'phantom_delete');
  writeJson(paths.deletionSagas, {
    schemaVersion: 1,
    sagas: {
      'del-phantom-pending': {
        id: 'del-phantom-pending',
        recordVersion: 1,
        phase: 'sync_pending',
        target: { parentId: pending.id, legIds: [], ids: [pending.id] },
        updatedAt: new Date().toISOString(),
      },
    },
  });
  saga.phase = 'items_pending';
  saga.cursor = { itemIndex: deleteItem.globalIndex };
  saga.activeDelegation = {
    itemIndex: deleteItem.globalIndex,
    txnId: pending.id,
    token: 'stale-token',
    accountId: 'account',
  };
  saga.delegatedDeletionSagaIds = {};
  saga.itemOutcomes = Object.fromEntries(
    saga.plan.items
      .filter((item) => item.globalIndex < deleteItem.globalIndex)
      .map((item) => [String(item.globalIndex), { status: 'completed' }]),
  );
  store.sagas[saga.id] = saga;
  writeJson(paths.sagas, store);
  assert.throws(
    () => manager.assertDeletionDelegationAuthorized({
      sagaId: saga.id,
      itemIndex: deleteItem.globalIndex,
      token: 'stale-token',
      txnId: pending.id,
      accountId: 'account',
    }),
    (error) => error.code === 'BULK_OPERATION_IN_PROGRESS',
  );
  const result = await finishBulk(api, manager, operationKey, 'phantom_cleanup', phantomParams);
  assert.equal(result.deletedCount, 1);
  assert.equal(readJson(paths.sagas).sagas[saga.id].activeDelegation, null);
});

test('phantom delete fails closed when account closes after plan', async () => {
  const { api, manager, phantomParams, pending } = makePhantomHarness();
  const operationKey = 'phantom-account-closed';
  const injector = faultSchedule([{ point: 'after:plan-checkpoint' }]);
  await assert.rejects(
    manager.run(api, {
      kind: 'phantom_cleanup',
      operationKey,
      params: phantomParams,
      faultInjector: injector,
      deferSync: true,
    }),
    isCrashError,
  );
  api.getAccounts = async () => [{ id: 'account', name: 'Account', closed: true, offbudget: false }];
  await assert.rejects(
    manager.run(api, {
      kind: 'phantom_cleanup',
      operationKey,
      params: phantomParams,
      deferSync: true,
    }),
    /closed after bulk plan checkpoint/,
  );
});

test('duplicate bulk operation keys fail closed without choosing a winner', async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'darkfinances-bulk-dup-key-'));
  const paths = {
    sagas: path.join(dir, 'bulk-operation-sagas.json'),
    rules: path.join(dir, 'rules.json'),
    phantomSeen: path.join(dir, 'phantom-seen.json'),
    phantomLog: path.join(dir, 'phantom-log.json'),
  };
  writeJson(paths.rules, { rules: [] });
  writeJson(paths.phantomSeen, { seen: {} });
  writeJson(paths.phantomLog, { deleted: [] });
  writeJson(paths.sagas, {
    schemaVersion: 1,
    sagas: {
      a: {
        id: 'a',
        recordVersion: 1,
        kind: 'rules_apply',
        operationKey: 'dup-key',
        phase: 'completed',
        plan: { items: [] },
        itemOutcomes: {},
        auditOutcome: { status: 'completed', applied: 0, failed: 0, skipped: 0, failedItems: [] },
        createdAt: '2026-07-10T00:00:00.000Z',
        updatedAt: '2026-07-10T00:00:00.000Z',
      },
      b: {
        id: 'b',
        recordVersion: 1,
        kind: 'rules_apply',
        operationKey: 'dup-key',
        phase: 'sync_pending',
        plan: { items: [] },
        itemOutcomes: {},
        createdAt: '2026-07-10T00:00:00.000Z',
        updatedAt: '2026-07-10T00:00:00.000Z',
      },
    },
  });
  const manager = createBulkOperationSaga({
    sagaPath: paths.sagas,
    readRules: () => readJson(paths.rules),
    writeRules: (store) => writeJson(paths.rules, store),
    readPhantomSeen: () => readJson(paths.phantomSeen),
    writePhantomSeen: (store) => writeJson(paths.phantomSeen, store),
    readPhantomLog: () => readJson(paths.phantomLog),
    writePhantomLog: (store) => writeJson(paths.phantomLog, store),
    deleteTransaction: async () => ({ ok: true }),
    inspectDeletionState: () => ({ schemaVersion: 1, sagas: {} }),
    recoverDeletionSagas: async () => ({ needsSync: false, errors: [] }),
    merchantCatalog: [],
    catalogTypeMatch: {},
    resolveCatalogCategory: () => null,
    buildCatInfo: () => ({}),
    settleUpPayee: /$^/,
    reimbCat: /$^/,
    incomeGroup: /$^/,
    moneyMovementGroup: /$^/,
    todayYMD: () => '2026-07-10',
    addDays: (date, delta) => {
      const next = new Date(`${date}T12:00:00.000Z`);
      next.setUTCDate(next.getUTCDate() + delta);
      return next.toISOString().slice(0, 10);
    },
  });
  assert.equal(manager.proveTerminalJournalCompletion('dup-key'), null);
  assert.equal(manager.resultForOperationKey('dup-key'), null);
  await assert.rejects(
    () => manager.run({ async sync() {} }, {
      kind: 'rules_apply',
      operationKey: 'dup-key',
      deferSync: true,
    }),
    (error) => error instanceof BulkOperationStateError,
  );
  assert.equal(Object.keys(readJson(paths.sagas).sagas).length, 2);
});

test('journal-backed bulk saga rejects a different operation fingerprint for the same key', async () => {
  const { api, manager } = makeHarness([]);
  const bindingA = {
    fingerprint: 'a'.repeat(64),
    fingerprintVersion: 2,
    method: 'POST',
    route: '/api/v1/rules/apply',
  };
  const bindingB = {
    fingerprint: 'b'.repeat(64),
    fingerprintVersion: 2,
    method: 'POST',
    route: '/api/v1/rules/apply',
  };
  await manager.run(api, {
    kind: 'rules_apply',
    operationKey: 'fp-key',
    journalBinding: bindingA,
    deferSync: false,
  });
  assert.throws(
    () => manager.assertJournalAdmission({
      operationKey: 'fp-key',
      journalBinding: bindingB,
      kind: 'rules_apply',
    }),
    (error) => error.code === 'IDEMPOTENCY_KEY_REUSED',
  );
  await assert.rejects(
    manager.run(api, {
      kind: 'rules_apply',
      operationKey: 'fp-key',
      journalBinding: bindingB,
      deferSync: true,
    }),
    (error) => error.code === 'IDEMPOTENCY_KEY_REUSED',
  );
});

test('terminal journal proof requires an exact bound fingerprint and rejects legacy records', async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'darkfinances-bulk-proof-'));
  const paths = {
    sagas: path.join(dir, 'bulk-operation-sagas.json'),
    rules: path.join(dir, 'rules.json'),
    phantomSeen: path.join(dir, 'phantom-seen.json'),
    phantomLog: path.join(dir, 'phantom-log.json'),
  };
  writeJson(paths.rules, { rules: [] });
  writeJson(paths.phantomSeen, { seen: {} });
  writeJson(paths.phantomLog, { deleted: [] });
  const binding = {
    fingerprint: 'c'.repeat(64),
    fingerprintVersion: 2,
    method: 'POST',
    route: '/api/v1/rules/apply',
  };
  writeJson(paths.sagas, {
    schemaVersion: 1,
    sagas: {
      bound: {
        id: 'bound',
        recordVersion: 1,
        kind: 'rules_apply',
        operationKey: 'proof-key',
        operationJournalFingerprint: binding.fingerprint,
        operationJournalFingerprintVersion: 2,
        operationJournalMethod: 'POST',
        operationJournalRoute: '/api/v1/rules/apply',
        phase: 'completed',
        plan: { items: [] },
        itemOutcomes: {},
        auditOutcome: { status: 'completed', applied: 0, failed: 0, skipped: 0, failedItems: [] },
        createdAt: '2026-07-10T00:00:00.000Z',
        updatedAt: '2026-07-10T00:00:00.000Z',
      },
      legacy: {
        id: 'legacy',
        recordVersion: 1,
        kind: 'rules_apply',
        operationKey: 'legacy-key',
        phase: 'completed',
        plan: { items: [] },
        itemOutcomes: {},
        auditOutcome: { status: 'completed', applied: 0, failed: 0, skipped: 0, failedItems: [] },
        createdAt: '2026-07-10T00:00:00.000Z',
        updatedAt: '2026-07-10T00:00:00.000Z',
      },
    },
  });
  const manager = createBulkOperationSaga({
    sagaPath: paths.sagas,
    readRules: () => readJson(paths.rules),
    writeRules: (store) => writeJson(paths.rules, store),
    readPhantomSeen: () => readJson(paths.phantomSeen),
    writePhantomSeen: (store) => writeJson(paths.phantomSeen, store),
    readPhantomLog: () => readJson(paths.phantomLog),
    writePhantomLog: (store) => writeJson(paths.phantomLog, store),
    deleteTransaction: async () => ({ ok: true }),
    inspectDeletionState: () => ({ schemaVersion: 1, sagas: {} }),
    recoverDeletionSagas: async () => ({ needsSync: false, errors: [] }),
    merchantCatalog: [],
    catalogTypeMatch: {},
    resolveCatalogCategory: () => null,
    buildCatInfo: () => ({}),
    settleUpPayee: /$^/,
    reimbCat: /$^/,
    incomeGroup: /$^/,
    moneyMovementGroup: /$^/,
    todayYMD: () => '2026-07-10',
    addDays: (date, delta) => {
      const next = new Date(`${date}T12:00:00.000Z`);
      next.setUTCDate(next.getUTCDate() + delta);
      return next.toISOString().slice(0, 10);
    },
  });
  const journalOperation = {
    fingerprint: binding.fingerprint,
    fingerprintVersion: 2,
    method: 'POST',
    route: '/api/v1/rules/apply',
  };
  assert.equal(manager.proveTerminalJournalCompletion('proof-key', journalOperation)?.status, 'completed');
  assert.equal(manager.proveTerminalJournalCompletion('proof-key', {
    ...journalOperation,
    fingerprint: 'd'.repeat(64),
  }), null);
  assert.equal(manager.proveTerminalJournalCompletion('proof-key', {
    ...journalOperation,
    route: '/api/v1/rules',
  }), null);
  assert.equal(manager.proveTerminalJournalCompletion('legacy-key', journalOperation), null);
  assert.equal(manager.proveTerminalJournalCompletion('proof-key', null), null);
});
