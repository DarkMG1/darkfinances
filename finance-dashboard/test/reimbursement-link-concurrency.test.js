'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const os = require('os');
const path = require('path');
const { resetActualCoordinator } = require('../lib/actual-coordinator');
const {
  sumTrustedAllocationsForExpense,
  sumTrustedAllocationsForInflow,
} = require('../lib/reimbursement-allocation');

const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'darkfinances-reimb-link-concurrency-'));
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

const actual = require('./fixtures/repayment-actual');

function writeJson(file, value) {
  fs.writeFileSync(file, `${JSON.stringify(value, null, 2)}\n`);
}

function readJson(file) {
  return JSON.parse(fs.readFileSync(file, 'utf8'));
}

function absCents(row) {
  return Math.abs(Math.round(Number(row.amount)));
}

function sharedExpenseRows() {
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
      id: 'in2',
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

function sharedInflowRows() {
  return [
    {
      id: 'in1',
      account: 'account',
      date: '2026-07-10',
      amount: 5000,
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
      amount: -3000,
      payee: 'payee',
      notes: '',
      cleared: true,
      category: 'reimb-category',
      is_parent: false,
      subtransactions: [],
    },
    {
      id: 'ex2',
      account: 'account',
      date: '2026-07-06',
      amount: -3000,
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
  writeJson(process.env.OWES_CONFIG_PATH, { expected: {}, debtorPatterns: {} });
  writeJson(process.env.REIMB_LINKS_PATH, { schemaVersion: 2, links: [] });
  writeJson(process.env.REIMB_SUGGEST_PATH, { schemaVersion: 1, confirmed: {}, dismissed: [] });
  writeJson(process.env.REPAYMENT_CONFIRMATION_SAGAS_PATH, { schemaVersion: 1, sagas: {} });
  writeJson(process.env.REIMBURSEMENT_LINK_SAGAS_PATH, { schemaVersion: 1, sagas: {} });
  writeJson(process.env.TRANSACTION_SAGAS_PATH, { schemaVersion: 1, sagas: {} });
  writeJson(process.env.TRANSACTION_DELETION_SAGAS_PATH, { schemaVersion: 1, sagas: {} });
  writeJson(process.env.BULK_OPERATION_SAGAS_PATH, { schemaVersion: 1, sagas: {} });
}

function loadDataModule() {
  resetActualCoordinator('reimb-link-concurrency');
  delete require.cache[require.resolve('../dataModule.js')];
  return require('../dataModule.js');
}

function assertTrustedCapacityInvariant(links, rows) {
  const expenseCaps = new Map();
  const inflowCaps = new Map();
  for (const row of rows) {
    const cents = absCents(row);
    if (row.amount < 0) expenseCaps.set(String(row.id), cents);
    if (row.amount > 0) inflowCaps.set(String(row.id), cents);
  }
  for (const [expenseId, cap] of expenseCaps) {
    assert.ok(
      sumTrustedAllocationsForExpense(links, expenseId) <= cap,
      `trusted expense allocations exceed live capacity for ${expenseId}`,
    );
  }
  for (const [inflowId, cap] of inflowCaps) {
    assert.ok(
      sumTrustedAllocationsForInflow(links, inflowId) <= cap,
      `trusted inflow allocations exceed live capacity for ${inflowId}`,
    );
  }
}

function createWriteBarrier() {
  let release;
  const gate = new Promise((resolve) => { release = resolve; });
  let armed = false;
  return {
    armBeforeLinksWrite() {
      armed = true;
    },
    release() {
      release();
    },
    faultInjector: async (point) => {
      if (armed && point === 'before:links-write') await gate;
    },
  };
}

test.after(() => {
  fs.rmSync(dir, { recursive: true, force: true });
  for (const [key, value] of Object.entries(savedEnv)) {
    if (value === undefined) delete process.env[key];
    else process.env[key] = value;
  }
});

test('Promise.all concurrent links on shared expense: one succeeds and one fails capacity', async () => {
  resetSidecars();
  actual.configure({ rows: sharedExpenseRows() });
  const data = loadDataModule();
  await data.initApi();

  const settled = await Promise.allSettled([
    data.addReimbLink({
      inflow: { id: 'in1', amount: 100 },
      expense: { id: 'ex1', amount: -50 },
      allocationCents: 3000,
      operationIdentity: 'shared-expense-a',
    }),
    data.addReimbLink({
      inflow: { id: 'in2', amount: 100 },
      expense: { id: 'ex1', amount: -50 },
      allocationCents: 3000,
      operationIdentity: 'shared-expense-b',
    }),
  ]);

  const fulfilled = settled.filter((entry) => entry.status === 'fulfilled');
  const rejected = settled.filter((entry) => entry.status === 'rejected');
  assert.equal(fulfilled.length, 1);
  assert.equal(rejected.length, 1);
  assert.match(String(rejected[0].reason?.message || rejected[0].reason), /remaining (expense|inflow) capacity/);

  const links = readJson(process.env.REIMB_LINKS_PATH).links;
  assert.equal(links.length, 1);
  assertTrustedCapacityInvariant(links, sharedExpenseRows());
});

test('Promise.all concurrent links on shared inflow: one succeeds and one fails capacity', async () => {
  resetSidecars();
  actual.configure({ rows: sharedInflowRows() });
  const data = loadDataModule();
  await data.initApi();

  const settled = await Promise.allSettled([
    data.addReimbLink({
      inflow: { id: 'in1', amount: 50 },
      expense: { id: 'ex1', amount: -30 },
      allocationCents: 3000,
      operationIdentity: 'shared-inflow-a',
    }),
    data.addReimbLink({
      inflow: { id: 'in1', amount: 50 },
      expense: { id: 'ex2', amount: -30 },
      allocationCents: 3000,
      operationIdentity: 'shared-inflow-b',
    }),
  ]);

  const fulfilled = settled.filter((entry) => entry.status === 'fulfilled');
  const rejected = settled.filter((entry) => entry.status === 'rejected');
  assert.equal(fulfilled.length, 1);
  assert.equal(rejected.length, 1);
  assert.match(String(rejected[0].reason?.message || rejected[0].reason), /remaining (expense|inflow) capacity/);

  const links = readJson(process.env.REIMB_LINKS_PATH).links;
  assert.equal(links.length, 1);
  assertTrustedCapacityInvariant(links, sharedInflowRows());
});

test('controlled barrier ordering still conserves shared expense capacity under Promise.all dispatch', async () => {
  resetSidecars();
  actual.configure({ rows: sharedExpenseRows() });
  const data = loadDataModule();
  await data.initApi();
  const barrier = createWriteBarrier();
  barrier.armBeforeLinksWrite();

  const pending = Promise.allSettled([
    data.addReimbLink({
      inflow: { id: 'in1', amount: 100 },
      expense: { id: 'ex1', amount: -50 },
      allocationCents: 3000,
      operationIdentity: 'barrier-expense-a',
      faultInjector: barrier.faultInjector,
    }),
    data.addReimbLink({
      inflow: { id: 'in2', amount: 100 },
      expense: { id: 'ex1', amount: -50 },
      allocationCents: 3000,
      operationIdentity: 'barrier-expense-b',
    }),
  ]);

  await new Promise((resolve) => setImmediate(resolve));
  barrier.release();
  const settled = await pending;

  const fulfilled = settled.filter((entry) => entry.status === 'fulfilled');
  const rejected = settled.filter((entry) => entry.status === 'rejected');
  assert.equal(fulfilled.length, 1);
  assert.equal(rejected.length, 1);

  const links = readJson(process.env.REIMB_LINKS_PATH).links;
  assertTrustedCapacityInvariant(links, sharedExpenseRows());
});
