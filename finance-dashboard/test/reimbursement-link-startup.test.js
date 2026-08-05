'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const os = require('os');
const path = require('path');
const { resetActualCoordinator } = require('../lib/actual-coordinator');

const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'darkfinances-reimb-link-startup-'));
const stateFiles = {
  OWES_CONFIG_PATH: 'owes-config.json',
  REIMB_LINKS_PATH: 'links.json',
  REIMB_SUGGEST_PATH: 'suggestions.json',
  REPAYMENT_CONFIRMATION_SAGAS_PATH: 'repayment-confirmation-sagas.json',
  REIMBURSEMENT_LINK_SAGAS_PATH: 'reimbursement-link-sagas.json',
  TRANSACTION_SAGAS_PATH: 'transaction-sagas.json',
  TRANSACTION_DELETION_SAGAS_PATH: 'transaction-deletion-sagas.json',
  BULK_OPERATION_SAGAS_PATH: 'bulk-operation-sagas.json',
};
const savedEnv = Object.fromEntries([
  ...Object.keys(stateFiles).map((key) => [key, process.env[key]]),
  ['ACTUAL_API_PATH', process.env.ACTUAL_API_PATH],
  ['ACTUAL_DATA_DIR', process.env.ACTUAL_DATA_DIR],
]);
for (const [key, file] of Object.entries(stateFiles)) process.env[key] = path.join(dir, file);
process.env.ACTUAL_API_PATH = path.join(__dirname, 'fixtures', 'repayment-actual.js');
process.env.ACTUAL_DATA_DIR = path.join(dir, 'actual-cache');

const actual = require('./fixtures/repayment-actual');

function writeJson(file, value) {
  fs.writeFileSync(file, `${JSON.stringify(value, null, 2)}\n`);
}

function readJson(file) {
  return JSON.parse(fs.readFileSync(file, 'utf8'));
}

function baseRows() {
  return [
    {
      id: 'in1',
      account: 'account',
      date: '2026-07-10',
      amount: 10000,
      payee: 'payee',
      notes: '',
      cleared: true,
      category: 'dining',
      is_parent: false,
      subtransactions: [],
    },
    {
      id: 'ex1',
      account: 'account',
      date: '2026-07-05',
      amount: -5000,
      payee: 'payee',
      notes: '',
      cleared: true,
      category: 'reimb-category',
      is_parent: false,
      subtransactions: [],
    },
  ];
}

function resetSidecars() {
  fs.mkdirSync(process.env.ACTUAL_DATA_DIR, { recursive: true });
  actual.configure({ rows: baseRows() });
  writeJson(process.env.OWES_CONFIG_PATH, { expected: {}, debtorPatterns: {} });
  writeJson(process.env.REIMB_LINKS_PATH, { schemaVersion: 2, links: [] });
  writeJson(process.env.REIMB_SUGGEST_PATH, { schemaVersion: 1, confirmed: {}, dismissed: [] });
  writeJson(process.env.REPAYMENT_CONFIRMATION_SAGAS_PATH, { schemaVersion: 1, sagas: {} });
  writeJson(process.env.TRANSACTION_SAGAS_PATH, { schemaVersion: 1, sagas: {} });
  writeJson(process.env.TRANSACTION_DELETION_SAGAS_PATH, { schemaVersion: 1, sagas: {} });
  writeJson(process.env.BULK_OPERATION_SAGAS_PATH, { schemaVersion: 1, sagas: {} });
}

function preparedHealthyLinkSaga() {
  return {
    id: 'healthy-link',
    recordVersion: 1,
    status: 'started',
    phase: 'prepared',
    action: 'link',
    accountId: 'account',
    inflowId: 'in1',
    expenseId: 'ex1',
    linkKey: 'in1:ex1',
    allocationCents: 2000,
    person: null,
    expectedVersion: null,
    allowSamePairResolution: false,
    inflowLive: {
      id: 'in1',
      date: '2026-07-10',
      amountCents: 10000,
      accountId: 'account',
      accountName: 'account',
      payee: 'payee',
      category: 'dining',
      imported: false,
      parentId: null,
      isLeg: false,
    },
    expenseLive: {
      id: 'ex1',
      date: '2026-07-05',
      amountCents: -5000,
      accountId: 'account',
      accountName: 'account',
      payee: 'payee',
      category: 'reimb-category',
      imported: false,
      parentId: null,
      isLeg: false,
    },
    startedAt: '2026-07-10T00:00:00.000Z',
    updatedAt: '2026-07-10T00:00:00.000Z',
  };
}

function preparedBrokenLinkSaga() {
  return {
    id: 'broken-link',
    recordVersion: 1,
    status: 'started',
    phase: 'prepared',
    action: 'link',
    accountId: 'account',
    inflowId: 'missing-inflow',
    expenseId: 'ex1',
    linkKey: 'missing-inflow:ex1',
    allocationCents: 1000,
    person: null,
    expectedVersion: null,
    allowSamePairResolution: false,
    inflowLive: {
      id: 'missing-inflow',
      date: '2026-07-10',
      amountCents: 10000,
      accountId: 'account',
      accountName: 'account',
      payee: 'payee',
      category: 'dining',
      imported: false,
      parentId: null,
      isLeg: false,
    },
    expenseLive: preparedHealthyLinkSaga().expenseLive,
    startedAt: '2026-07-10T00:00:00.000Z',
    updatedAt: '2026-07-10T00:00:00.000Z',
  };
}

function loadDataModule() {
  resetActualCoordinator('reimb-link-startup');
  delete require.cache[require.resolve('../dataModule.js')];
  return require('../dataModule.js');
}

test.after(() => {
  fs.rmSync(dir, { recursive: true, force: true });
  for (const [key, value] of Object.entries(savedEnv)) {
    if (value === undefined) delete process.env[key];
    else process.env[key] = value;
  }
});

test('startup recovery completes healthy link saga and reports broken saga in health diagnostics', async () => {
  resetSidecars();
  writeJson(process.env.REIMBURSEMENT_LINK_SAGAS_PATH, {
    schemaVersion: 1,
    sagas: {
      'healthy-link': preparedHealthyLinkSaga(),
      'broken-link': preparedBrokenLinkSaga(),
    },
  });

  const data = loadDataModule();
  await data.initApi();
  const health = data.getHealth();

  assert.equal(health.ready, false);
  assert.equal(health.operationalSagas.recoveryCompleted, true);
  assert.ok(health.operationalSagas.errors.some((entry) => entry.store === 'reimbursementLinks'));
  assert.ok(health.operationalSagas.nonterminal.byStore.reimbursementLinks >= 1);

  const sagas = readJson(process.env.REIMBURSEMENT_LINK_SAGAS_PATH).sagas;
  assert.equal(sagas['healthy-link'].phase, 'completed');
  assert.notEqual(sagas['broken-link'].phase, 'completed');

  const links = readJson(process.env.REIMB_LINKS_PATH).links;
  assert.equal(links.length, 1);
  assert.equal(links[0].allocationCents, 2000);
});

test('startup health inventories a legacy replacement that cannot be safely terminalized', async () => {
  resetSidecars();
  writeJson(process.env.REIMBURSEMENT_LINK_SAGAS_PATH, { schemaVersion: 1, sagas: {} });
  writeJson(process.env.TRANSACTION_SAGAS_PATH, {
    schemaVersion: 1,
    sagas: {
      'legacy-replacement': {
        id: 'legacy-replacement',
        status: 'original-deleted',
        accountId: 'account',
        original: {
          id: 'missing-original',
          date: '2026-07-10',
          amount: -2500,
          payee: 'payee',
          notes: '',
          cleared: true,
          category: 'dining',
          is_parent: false,
          subtransactions: [],
        },
        replacement: {
          date: '2026-07-10',
          amount: -2500,
          payee: 'payee',
          notes: '',
          cleared: true,
          category: 'dining',
        },
        startedAt: '2026-07-10T00:00:00.000Z',
        updatedAt: '2026-07-10T00:00:01.000Z',
      },
    },
  });

  const data = loadDataModule();
  await data.initApi();
  const health = data.getHealth();

  assert.equal(health.ready, false);
  assert.equal(health.operationalSagas.nonterminal.byStore.transactionReplacement, 1);
  assert.ok(health.operationalSagas.errors.some((entry) => (
    entry.store === 'transactionReplacement'
      && entry.sagaId === 'legacy-replacement'
      && entry.code === 'TRANSACTION_REPLACEMENT_OUTCOME_UNKNOWN'
      && /operator repair is required/.test(entry.message)
  )));
  const saga = readJson(process.env.TRANSACTION_SAGAS_PATH).sagas['legacy-replacement'];
  assert.equal(saga.phase, 'legacy_unresolved');
  assert.match(saga.lastError.message, /operator repair is required/);
});

test('startup with only terminal link sagas marks operational recovery ready', async () => {
  resetSidecars();
  writeJson(process.env.REIMBURSEMENT_LINK_SAGAS_PATH, { schemaVersion: 1, sagas: {} });

  const data = loadDataModule();
  await data.initApi();
  const health = data.getHealth();

  assert.equal(health.ready, true);
  assert.equal(health.operationalSagas.errors.length, 0);
  assert.equal(health.operationalSagas.nonterminal.total, 0);
});

test('normal sync recovery advances healthy saga while retaining broken saga diagnostics', async () => {
  resetSidecars();
  writeJson(process.env.REIMBURSEMENT_LINK_SAGAS_PATH, {
    schemaVersion: 1,
    sagas: {
      'healthy-link': preparedHealthyLinkSaga(),
      'broken-link': preparedBrokenLinkSaga(),
    },
  });

  const data = loadDataModule();
  await data.initApi();
  assert.equal(data.getHealth().ready, false);

  await assert.rejects(() => data.syncNow());
  const health = data.getHealth();
  assert.equal(health.ready, false);
  assert.ok(health.lastError);
  assert.ok(health.operationalSagas.errors.some((entry) => entry.store === 'reimbursementLinks'));
  assert.equal(readJson(process.env.REIMB_LINKS_PATH).links.length, 1);
});
