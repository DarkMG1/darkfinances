'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const { mock } = require('node:test');
const fs = require('fs');
const os = require('os');
const path = require('path');
const { addDays, todayYMD } = require('../lib/date-only');

const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'darkfinances-bulk-callers-'));
const stateFiles = {
  PERSONAL_CONFIG_PATH: 'personal.json',
  RECEIPTS_PATH: 'receipts.json',
  RECEIPTS_DIR: 'receipts',
  REIMB_LINKS_PATH: 'links.json',
  REIMB_SUGGEST_PATH: 'suggestions.json',
  RECON_PATH: 'reconciliation.json',
  PHANTOM_SEEN_PATH: 'phantom-seen.json',
  PHANTOM_LOG_PATH: 'phantom-log.json',
  RULES_PATH: 'rules.json',
  TRANSACTION_SAGAS_PATH: 'transaction-sagas.json',
  TRANSACTION_DELETION_SAGAS_PATH: 'transaction-deletion-sagas.json',
  BULK_OPERATION_SAGAS_PATH: 'bulk-operation-sagas.json',
  REPAYMENT_CONFIRMATION_SAGAS_PATH: 'repayment-confirmation-sagas.json',
  OWES_TRUTH_PATH: 'owes-truth.json',
};
for (const [key, name] of Object.entries(stateFiles)) process.env[key] = path.join(dir, name);
process.env.ACTUAL_API_PATH = path.join(__dirname, 'fixtures', 'deletion-actual');

const fakeActual = require('./fixtures/deletion-actual');
const data = require('../dataModule');
const fixtureToday = todayYMD();

function writeJson(file, value) {
  fs.writeFileSync(file, `${JSON.stringify(value, null, 2)}\n`);
}

function reset(rows = []) {
  fs.rmSync(dir, { recursive: true, force: true });
  fs.mkdirSync(process.env.RECEIPTS_DIR, { recursive: true });
  fakeActual.configure({ rows });
  writeJson(process.env.RECEIPTS_PATH, { byTxn: {} });
  writeJson(process.env.REIMB_LINKS_PATH, { links: [] });
  writeJson(process.env.REIMB_SUGGEST_PATH, { confirmed: {}, dismissed: [] });
  writeJson(process.env.RECON_PATH, { enabled: false, months: {} });
  writeJson(process.env.PHANTOM_SEEN_PATH, { seen: {} });
  writeJson(process.env.PHANTOM_LOG_PATH, { deleted: [] });
  writeJson(process.env.RULES_PATH, { rules: [] });
  writeJson(process.env.BULK_OPERATION_SAGAS_PATH, { schemaVersion: 1, sagas: {} });
  writeJson(process.env.TRANSACTION_DELETION_SAGAS_PATH, { schemaVersion: 1, sagas: {} });
  writeJson(process.env.TRANSACTION_SAGAS_PATH, { schemaVersion: 1, sagas: {} });
  writeJson(process.env.REPAYMENT_CONFIRMATION_SAGAS_PATH, { schemaVersion: 1, sagas: {} });
}

const uncategorized = Object.freeze({
  id: 'rule-target',
  account: 'account',
  date: addDays(fixtureToday, -10),
  amount: -1200,
  payee: 'payee',
  imported_payee: 'Merchant Cafe',
  cleared: true,
  category: null,
  is_parent: false,
  subtransactions: [],
});

test('applyRules uses bulk checkpoints and reports status', async () => {
  reset([uncategorized]);
  writeJson(process.env.RULES_PATH, {
    rules: [{ id: 'r1', match: 'Merchant', categoryId: 'category', categoryName: 'Dining', created: uncategorized.date }],
  });
  const result = await data.applyRules({ sync: false, operationKey: 'rules-apply-test' });
  assert.equal(result.ok, false);
  assert.equal(result.applied, 1);
  assert.equal(result.status, 'in_progress');
  assert.equal(fakeActual.inspect().counts.update, 1);
  const bulk = JSON.parse(fs.readFileSync(process.env.BULK_OPERATION_SAGAS_PATH, 'utf8'));
  assert.equal(Object.values(bulk.sagas).length, 1);
});

test('saveRule refuses owned transactions via bulk admission', async () => {
  reset([uncategorized]);
  writeJson(process.env.TRANSACTION_DELETION_SAGAS_PATH, {
    schemaVersion: 1,
    sagas: {
      active: {
        id: 'active-delete',
        recordVersion: 1,
        phase: 'delete_pending',
        accountId: 'account',
        date: uncategorized.date,
        target: { parentId: uncategorized.id, legIds: [], ids: [uncategorized.id] },
      },
    },
  });
  await assert.rejects(
    data.saveRule({ match: 'Merchant', categoryId: 'category-new' }, { sync: false }),
    (error) => error.code === 'TRANSACTION_DELETION_IN_PROGRESS',
  );
});

test('frozen-clock rule creates stay distinct, preserve legacy IDs, and delete exactly one', async () => {
  mock.timers.enable({ apis: ['Date'], now: new Date('2026-07-15T17:01:00-07:00') });
  try {
    reset([]);
    writeJson(process.env.RULES_PATH, {
      rules: [{
        id: 'rlegacy',
        match: 'Legacy merchant',
        categoryId: 'category',
        categoryName: 'Dining',
        created: '2026-07-01',
      }],
    });

    const first = await data.saveRule(
      { match: 'First merchant', categoryId: 'category', categoryName: 'Dining' },
      { sync: false },
    );
    const second = await data.saveRule(
      { match: 'Second merchant', categoryId: 'category', categoryName: 'Dining' },
      { sync: false },
    );

    assert.notEqual(first.id, second.id);
    assert.match(first.id, /^r_[0-9a-f-]{36}$/);
    assert.match(second.id, /^r_[0-9a-f-]{36}$/);
    assert.deepEqual(
      data.getRules().rules.map(({ id }) => id),
      ['rlegacy', first.id, second.id],
    );

    assert.deepEqual(data.deleteRule({ id: first.id }), { ok: true, removed: 1 });
    assert.deepEqual(
      data.getRules().rules.map(({ id }) => id),
      ['rlegacy', second.id],
    );
  } finally {
    mock.timers.reset();
  }
});

test('phantom dry-run remains effect-free', async () => {
  const phantom = {
    id: 'phantom-dry',
    account: 'account',
    date: addDays(fixtureToday, -30),
    amount: -1200,
    payee: 'payee',
    notes: 'temporary authorization hold expected to drop',
    cleared: false,
    imported_id: 'pending-bank-id',
    is_parent: false,
    subtransactions: [],
  };
  reset([phantom]);
  const beforeSeen = fs.readFileSync(process.env.PHANTOM_SEEN_PATH, 'utf8');
  const result = await data.cleanupPhantoms({
    dryRun: true,
    window: 60,
    agedDays: 0,
    observeDays: 0,
    holdAgedDays: 0,
    holdObserveDays: 0,
  });
  assert.equal(result.dryRun, true);
  assert.equal(fs.readFileSync(process.env.PHANTOM_SEEN_PATH, 'utf8'), beforeSeen);
  assert.equal(Object.keys(JSON.parse(fs.readFileSync(process.env.BULK_OPERATION_SAGAS_PATH, 'utf8')).sagas).length, 0);
});

test('zero-item rules apply terminalizes without stranding at sync_pending', async () => {
  reset([]);
  const deferred = await data.applyRules({ sync: false, operationKey: 'zero-items' });
  assert.equal(deferred.applied, 0);
  assert.equal(deferred.ok, false);
  assert.equal(deferred.needsSync, true);
  assert.equal(deferred.status, 'in_progress');
  await data.syncNow();
  const terminal = data.getBulkOperationResult('zero-items');
  assert.equal(terminal.ok, true);
  assert.equal(terminal.status, 'completed');
  assert.equal(terminal.needsSync, false);
});

const phantomPending = Object.freeze({
  id: 'phantom-pending',
  account: 'account',
  date: addDays(fixtureToday, -30),
  amount: -1200,
  payee: 'payee',
  imported_payee: 'Merchant Cafe',
  cleared: false,
  imported_id: 'bank-import-1',
  is_parent: false,
  subtransactions: [],
});

const phantomOther = Object.freeze({
  id: 'phantom-other',
  account: 'account',
  date: addDays(fixtureToday, -30),
  amount: -900,
  payee: 'payee',
  imported_payee: 'Merchant Other',
  cleared: false,
  imported_id: 'bank-import-2',
  is_parent: false,
  subtransactions: [],
});

const phantomSuperseder = Object.freeze({
  id: 'phantom-cleared',
  account: 'account',
  date: addDays(fixtureToday, -29),
  amount: -1200,
  payee: 'payee',
  imported_payee: 'Merchant Cafe',
  cleared: true,
  category: null,
  is_parent: false,
  subtransactions: [],
});

class SagaInterruption extends Error {
  constructor(message) {
    super(message);
    this.name = 'SagaInterruption';
  }
}

test('bulk delegation binds delete target account saga item and token in dataModule', async () => {
  reset([phantomPending, phantomSuperseder]);
  let crashOnce = true;
  const faultInjector = async (point) => {
    if (crashOnce && point === 'before:item-1-delegation-handoff-checkpoint') {
      crashOnce = false;
      throw new SagaInterruption('stop before handoff');
    }
  };

  await assert.rejects(
    data.cleanupPhantoms({
      window: 60,
      agedDays: 0,
      observeDays: 0,
      holdAgedDays: 0,
      holdObserveDays: 0,
      operationKey: 'delegation-bind',
      faultInjector,
    }),
    (error) => error instanceof SagaInterruption,
  );

  const bulk = JSON.parse(fs.readFileSync(process.env.BULK_OPERATION_SAGAS_PATH, 'utf8'));
  const saga = Object.values(bulk.sagas)[0];
  const delegation = {
    sagaId: saga.id,
    itemIndex: 1,
    token: 'stolen-token',
    txnId: phantomPending.id,
    accountId: 'account',
  };

  await assert.rejects(
    data.deleteTransaction({
      id: phantomOther.id,
      accountId: 'account',
      date: phantomOther.date,
      allowImported: true,
      bulkDelegation: delegation,
    }),
    (error) => error.code === 'BULK_OPERATION_IN_PROGRESS',
  );

  await assert.rejects(
    data.deleteTransaction({
      id: phantomPending.id,
      accountId: 'account',
      date: phantomPending.date,
      allowImported: true,
      bulkDelegation: { ...delegation, txnId: phantomOther.id },
    }),
    (error) => error.code === 'BULK_OPERATION_IN_PROGRESS',
  );

  saga.activeDelegation = {
    itemIndex: 1,
    txnId: phantomPending.id,
    token: 'real-token',
    accountId: 'account',
  };
  saga.cursor = { itemIndex: 1 };
  bulk.sagas[saga.id] = saga;
  writeJson(process.env.BULK_OPERATION_SAGAS_PATH, bulk);

  await assert.rejects(
    data.deleteTransaction({
      id: phantomPending.id,
      accountId: 'account',
      date: phantomPending.date,
      allowImported: true,
      bulkDelegation: {
        sagaId: saga.id,
        itemIndex: 1,
        token: 'wrong-token',
        txnId: phantomPending.id,
        accountId: 'account',
      },
    }),
    (error) => error.code === 'BULK_OPERATION_IN_PROGRESS',
  );
});

test('direct delete without delegation is blocked during phantom sidecars_pending', async () => {
  reset([phantomPending, phantomSuperseder]);
  let crashOnce = true;
  const faultInjector = async (point) => {
    if (crashOnce && point === 'after:item-0-applied-checkpoint') {
      crashOnce = false;
      throw new SagaInterruption('stop after seen item');
    }
  };

  await assert.rejects(
    data.cleanupPhantoms({
      window: 60,
      agedDays: 0,
      observeDays: 0,
      holdAgedDays: 0,
      holdObserveDays: 0,
      operationKey: 'phantom-sidecars-block',
      faultInjector,
    }),
    (error) => error instanceof SagaInterruption,
  );

  const bulk = JSON.parse(fs.readFileSync(process.env.BULK_OPERATION_SAGAS_PATH, 'utf8'));
  const saga = Object.values(bulk.sagas)[0];
  assert.equal(saga.phase, 'items_pending');

  await assert.rejects(
    data.deleteTransaction({
      id: phantomPending.id,
      accountId: 'account',
      date: phantomPending.date,
      allowImported: true,
    }),
    (error) => error.code === 'BULK_OPERATION_IN_PROGRESS',
  );
});
