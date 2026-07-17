'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const os = require('os');
const path = require('path');
const {
  buildAdmissionPayload,
  resolveRepaymentEndpoints,
} = require('../lib/repayment-confirmation-admission');
const {
  validateAllocationPlan,
} = require('../lib/repayment-confirmation-sidecars');

const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'darkfinances-repay-admission-'));
const stateFiles = {
  OWES_CONFIG_PATH: 'owes-config.json',
  REIMB_LINKS_PATH: 'links.json',
  REIMB_SUGGEST_PATH: 'suggestions.json',
  REPAYMENT_CONFIRMATION_SAGAS_PATH: 'repayment-confirmation-sagas.json',
  REIMBURSEMENT_LINK_SAGAS_PATH: 'reimbursement-link-sagas.json',
  TRANSACTION_SAGAS_PATH: 'transaction-sagas.json',
  TRANSACTION_DELETION_SAGAS_PATH: 'transaction-deletion-sagas.json',
};
for (const [key, file] of Object.entries(stateFiles)) process.env[key] = path.join(dir, file);
process.env.REIMB_SUGGEST_FROM = '2026-01-01';
process.env.ACTUAL_API_PATH = path.join(__dirname, 'fixtures', 'repayment-actual.js');

const actual = require('./fixtures/repayment-actual');

function writeJson(file, value) {
  fs.writeFileSync(file, `${JSON.stringify(value, null, 2)}\n`);
}

function readJson(file) {
  return JSON.parse(fs.readFileSync(file, 'utf8'));
}

function splitExpenseRows({ expenseAccount = 'account' } = {}) {
  return [
    {
      id: 'repay-inflow',
      account: 'account',
      date: '2026-07-10',
      amount: 5000,
      payee: null,
      imported_payee: 'Zelle from Alex',
      notes: '',
      cleared: true,
      category: 'dining',
      is_parent: false,
      subtransactions: [],
    },
    {
      id: 'split-parent',
      account: expenseAccount,
      date: '2026-07-05',
      amount: -5000,
      payee: 'payee',
      notes: '',
      cleared: true,
      category: null,
      is_parent: true,
      subtransactions: [
        {
          id: 'split-leg-reimb',
          parent_id: 'split-parent',
          date: '2026-07-05',
          amount: -3000,
          payee: 'payee',
          notes: '#alex',
          cleared: true,
          category: 'reimb-category',
        },
        {
          id: 'split-leg-self',
          parent_id: 'split-parent',
          date: '2026-07-05',
          amount: -2000,
          payee: 'payee',
          notes: '',
          cleared: true,
          category: 'dining',
        },
      ],
    },
    {
      id: 'expense-b',
      account: expenseAccount,
      date: '2026-07-08',
      amount: -2000,
      payee: 'payee',
      notes: '#alex',
      cleared: true,
      category: 'reimb-category',
      is_parent: false,
      subtransactions: [],
    },
  ];
}

function crossDateRows({ expenseAccount = 'account' } = {}) {
  return [
    {
      id: 'repay-inflow',
      account: 'account',
      date: '2026-07-10',
      amount: 5000,
      payee: null,
      imported_payee: 'Zelle from Alex',
      notes: '',
      cleared: true,
      category: 'dining',
      is_parent: false,
      subtransactions: [],
    },
    {
      id: 1001,
      account: expenseAccount,
      date: '2026-07-05',
      amount: -3000,
      payee: 'payee',
      notes: '#alex',
      cleared: true,
      category: 'reimb-category',
      is_parent: false,
      subtransactions: [],
    },
    {
      id: 'expense-b',
      account: expenseAccount,
      date: '2026-07-08',
      amount: -2000,
      payee: 'payee',
      notes: '#alex',
      cleared: true,
      category: 'reimb-category',
      is_parent: false,
      subtransactions: [],
    },
  ];
}

function reset(rows = crossDateRows()) {
  fs.rmSync(dir, { recursive: true, force: true });
  fs.mkdirSync(dir, { recursive: true });
  actual.configure({ rows });
  writeJson(process.env.OWES_CONFIG_PATH, {
    expected: {},
    debtorPatterns: { alex: 'alex' },
  });
  writeJson(process.env.REIMB_LINKS_PATH, { schemaVersion: 2, unknown: 'keep', links: [] });
  writeJson(process.env.REIMB_SUGGEST_PATH, {
    schemaVersion: 1,
    unknown: { keep: true },
    confirmed: {},
    dismissed: [],
  });
  writeJson(process.env.REPAYMENT_CONFIRMATION_SAGAS_PATH, { schemaVersion: 1, sagas: {} });
  writeJson(process.env.REIMBURSEMENT_LINK_SAGAS_PATH, { schemaVersion: 1, sagas: {} });
}

test.after(() => fs.rmSync(dir, { recursive: true, force: true }));

test('single-day inflow queries miss cross-date expenses (pre-fix reproduction)', async () => {
  reset();
  const api = actual;
  const inflowDate = '2026-07-10';
  const dayScoped = await api.getTransactions('account', inflowDate, inflowDate);
  assert.ok(dayScoped.some((row) => String(row.id) === 'repay-inflow'));
  assert.equal(dayScoped.some((row) => String(row.id) === '1001'), false);
  assert.equal(dayScoped.some((row) => String(row.id) === 'expense-b'), false);
});

test('resolveRepaymentEndpoints finds exact ids across dates and closed accounts', async () => {
  reset(crossDateRows({ expenseAccount: 'closed-account' }));
  actual.configure({
    rows: crossDateRows({ expenseAccount: 'closed-account' }),
    accounts: [
      { id: 'account', name: 'Open', closed: false, offbudget: false },
      { id: 'closed-account', name: 'Closed', closed: true, offbudget: false },
    ],
  });
  const suggestion = {
    inflow: { id: 'repay-inflow', date: '2026-07-10', payee: 'Zelle from Alex', amount: 50 },
    allocations: [
      { expense: { id: 1001, date: '2026-07-05', payee: 'Expense A', amount: -30 }, amount: 30 },
      { expense: { id: 'expense-b', date: '2026-07-08', payee: 'Expense B', amount: -20 }, amount: 20 },
    ],
  };
  const resolved = await resolveRepaymentEndpoints(actual, suggestion, {});
  assert.equal(resolved.accountId, 'account');
  assert.equal(resolved.expenseAccounts[1001], 'closed-account');
  assert.equal(resolved.expenseAccounts['expense-b'], 'closed-account');
});

test('resolveRepaymentEndpoints resolves split reimbursement legs with parent context', async () => {
  reset(splitExpenseRows());
  const suggestion = {
    inflow: { id: 'repay-inflow', date: '2026-07-10', payee: 'Zelle from Alex', amount: 50 },
    allocations: [
      { expense: { id: 'split-leg-reimb', date: '2026-07-05', payee: 'Expense A', amount: -30 }, amount: 30 },
      { expense: { id: 'expense-b', date: '2026-07-08', payee: 'Expense B', amount: -20 }, amount: 20 },
    ],
  };
  const resolved = await resolveRepaymentEndpoints(actual, suggestion, {});
  assert.equal(resolved.expenseTransactions['split-leg-reimb'].parentId, 'split-parent');
  assert.equal(resolved.expenseTransactions['split-leg-reimb'].parent_id, 'split-parent');
  assert.equal(resolved.expenseTransactions['split-leg-reimb'].amount, -3000);
  assert.equal(resolved.expenseTransactions['expense-b'].parentId, null);
});

test('numeric legacy expense ids are counted when validating prior allocations', () => {
  assert.throws(
    () => validateAllocationPlan({
      inflowAmountCents: 5000,
      inflowId: 'repay-inflow',
      existingLinks: [{
        inflow: { id: 'other-inflow' },
        expense: { id: 1001, amount: -30 },
        amount: 30,
      }],
      allocations: [{
        expenseId: '1001',
        amountCents: 100,
        expenseSnapshot: { amountCents: -3000 },
      }],
    }),
    /exceeds remaining expense capacity/,
  );
});

test('confirmRepayment resolves cross-date expenses through suggestRepayments and completes', async () => {
  reset();
  delete require.cache[require.resolve('../dataModule.js')];
  const data = require('../dataModule');

  const { suggestions } = await data.suggestRepayments({ from: '2026-01-01', to: '2026-12-31' });
  const suggestion = suggestions.find((entry) => entry.id === 'sg_repay-inflow');
  assert.ok(suggestion, 'expected a cross-date repayment suggestion');
  assert.equal(suggestion.allocations.length, 2);
  assert.notEqual(suggestion.allocations[0].expense.date, suggestion.inflow.date);

  const result = await data.confirmRepayment({
    id: suggestion.id,
    from: '2026-01-01',
    to: '2026-12-31',
    operationIdentity: 'caller-op-1',
  });
  assert.equal(result.ok, true);
  assert.equal(result.inflowId, 'repay-inflow');

  const state = readJson(process.env.REPAYMENT_CONFIRMATION_SAGAS_PATH);
  const saga = Object.values(state.sagas)[0];
  assert.equal(saga.id, 'caller-op-1');
  assert.equal(saga.phase, 'sync_pending');

  const links = readJson(process.env.REIMB_LINKS_PATH);
  assert.equal(links.unknown, 'keep');
  assert.equal(links.links.length, 2);

  await data.syncNow();
  assert.equal(Object.values(readJson(process.env.REPAYMENT_CONFIRMATION_SAGAS_PATH).sagas)[0].phase, 'completed');
  assert.equal(actual.inspect().rows.find((row) => row.id === 'repay-inflow').category, 'reimb-category');
});

test('confirmRepayment resolves split reimbursement legs through suggestRepayments and survives restart', async () => {
  reset(splitExpenseRows());
  delete require.cache[require.resolve('../dataModule.js')];
  const data = require('../dataModule');

  const { suggestions } = await data.suggestRepayments({ from: '2026-01-01', to: '2026-12-31' });
  const suggestion = suggestions.find((entry) => entry.id === 'sg_repay-inflow');
  assert.ok(suggestion, 'expected a split-leg repayment suggestion');
  const splitAllocation = suggestion.allocations.find((entry) => entry.expense.id === 'split-leg-reimb');
  assert.ok(splitAllocation, 'expected allocation against split reimbursement leg id');
  assert.notEqual(splitAllocation.expense.date, suggestion.inflow.date);

  const result = await data.confirmRepayment({
    id: suggestion.id,
    from: '2026-01-01',
    to: '2026-12-31',
    operationIdentity: 'caller-split-op',
  });
  assert.equal(result.ok, true);

  let saga = Object.values(readJson(process.env.REPAYMENT_CONFIRMATION_SAGAS_PATH).sagas)[0];
  assert.equal(saga.id, 'caller-split-op');
  const splitAllocationRecord = saga.allocations.find((entry) => entry.expenseId === 'split-leg-reimb');
  assert.equal(splitAllocationRecord.parentId, 'split-parent');
  assert.ok(splitAllocationRecord.fingerprint);

  await data.syncNow();
  saga = Object.values(readJson(process.env.REPAYMENT_CONFIRMATION_SAGAS_PATH).sagas)[0];
  assert.equal(saga.phase, 'completed');

  const links = readJson(process.env.REIMB_LINKS_PATH).links.filter((link) => link.inflow?.id === 'repay-inflow');
  assert.equal(links.length, 2);
  assert.ok(links.some((link) => link.expense?.id === 'split-leg-reimb'));
});

test('buildAdmissionPayload rejects stale over-capacity allocation plans before effects', async () => {
  reset();
  delete require.cache[require.resolve('../dataModule.js')];
  const data = require('../dataModule');
  const { suggestions } = await data.suggestRepayments({ from: '2026-01-01', to: '2026-12-31' });
  const suggestion = structuredClone(suggestions.find((entry) => entry.id === 'sg_repay-inflow'));
  assert.ok(suggestion);
  suggestion.allocations[0].amount += 10;
  const resolved = await resolveRepaymentEndpoints(actual, suggestion, {});
  assert.throws(
    () => buildAdmissionPayload({
      suggestionId: suggestion.id,
      suggestion,
      reimbCategoryId: 'reimb-category',
      resolved,
      existingLinks: readJson(process.env.REIMB_LINKS_PATH).links,
    }),
    (error) => error.code === 'REPAYMENT_ALLOCATION_PLAN_INVALID' && error.status === 409,
  );
  assert.equal(Object.keys(readJson(process.env.REPAYMENT_CONFIRMATION_SAGAS_PATH).sagas).length, 0);
  assert.equal(actual.inspect().counts.update, 0);
});

test('suggestion audit writes preserve unknown reimb-suggest metadata', async () => {
  reset();
  delete require.cache[require.resolve('../dataModule.js')];
  const data = require('../dataModule');
  writeJson(process.env.REIMB_SUGGEST_PATH, {
    schemaVersion: 1,
    unknown: { keep: true, nested: { audit: 'preserve' } },
    confirmed: { legacy: { inflowId: null, at: 'keep' } },
    dismissed: ['legacy-dismissed'],
  });

  const { suggestions } = await data.suggestRepayments({ from: '2026-01-01', to: '2026-12-31' });
  await data.confirmRepayment({
    id: suggestions[0].id,
    from: '2026-01-01',
    to: '2026-12-31',
  });
  await data.syncNow();

  const store = readJson(process.env.REIMB_SUGGEST_PATH);
  assert.equal(store.schemaVersion, 1);
  assert.deepEqual(store.unknown, { keep: true, nested: { audit: 'preserve' } });
  assert.deepEqual(store.dismissed, ['legacy-dismissed']);
  assert.deepEqual(store.confirmed.legacy, { inflowId: null, at: 'keep' });
  assert.equal(store.confirmed[`sg_${suggestions[0].inflow.id}`].inflowId, 'repay-inflow');
});

function activeRepaymentRecord({
  phase = 'links_pending',
  inflowId = 'repay-inflow',
  expenseIds = [1001, 'expense-b'],
} = {}) {
  return {
    id: 'active-repay',
    recordVersion: 1,
    phase,
    status: 'started',
    accountId: 'account',
    date: '2026-07-10',
    inflow: { id: inflowId },
    allocations: expenseIds.map((expenseId) => ({ expenseId: String(expenseId) })),
  };
}

test('active repayment ownership blocks transaction mutations before effects', async () => {
  reset();
  delete require.cache[require.resolve('../dataModule.js')];
  const data = require('../dataModule');
  writeJson(process.env.REPAYMENT_CONFIRMATION_SAGAS_PATH, {
    schemaVersion: 1,
    sagas: {
      active: activeRepaymentRecord(),
      terminal: {
        ...activeRepaymentRecord({ inflowId: 'terminal-inflow', expenseIds: [] }),
        id: 'terminal-repay',
        phase: 'completed',
        status: 'completed',
      },
    },
  });

  const blockedIds = ['repay-inflow', 1001, 'expense-b'];
  for (const id of blockedIds) {
    assert.throws(
      () => data.assertTransactionMutationAvailable({ ids: [id] }),
      (error) => error.code === 'REPAYMENT_CONFIRMATION_IN_PROGRESS' && error.status === 409,
    );
  }

  const mutationCalls = [
    {
      label: 'deleteTransaction',
      run: () => data.deleteTransaction({
        id: 'repay-inflow',
        accountId: 'account',
        date: '2026-07-10',
      }),
      async: true,
    },
    {
      label: 'setTransactionCategory',
      run: () => data.setTransactionCategory({
        id: 'repay-inflow',
        categoryId: 'reimb-category',
      }),
      async: true,
    },
    {
      label: 'addReimbLink',
      run: () => data.addReimbLink({
        inflow: { id: 'repay-inflow', amount: 50 },
        expense: { id: 1001, amount: -30 },
        allocationCents: 3000,
      }),
      async: true,
    },
    {
      label: 'confirmRepayment',
      run: () => data.confirmRepayment({ id: 'sg_repay-inflow' }),
      async: true,
    },
    {
      label: 'dismissRepayment',
      run: () => data.dismissRepayment({ inflowId: 'repay-inflow' }),
      async: false,
    },
  ];
  for (const { label, run, async: isAsync } of mutationCalls) {
    const expectBlocked = (error) => {
      assert.equal(error.code, 'REPAYMENT_CONFIRMATION_IN_PROGRESS', label);
      return true;
    };
    if (isAsync) {
      await assert.rejects(run, expectBlocked);
    } else {
      assert.throws(run, expectBlocked);
    }
  }

  assert.doesNotThrow(() => data.assertTransactionMutationAvailable({ ids: ['terminal-inflow'] }));
  assert.doesNotThrow(() => data.assertTransactionMutationAvailable({ ids: ['unrelated-id'] }));
  assert.equal(actual.inspect().counts.update, 0);
  assert.equal(actual.inspect().counts.delete, 0);
});

test('active replacement and deletion sagas block repayment confirmation admission', async () => {
  reset();
  delete require.cache[require.resolve('../dataModule.js')];
  const data = require('../dataModule');
  writeJson(process.env.TRANSACTION_DELETION_SAGAS_PATH, {
    schemaVersion: 1,
    sagas: {
      active: {
        id: 'active-delete',
        recordVersion: 1,
        phase: 'delete_pending',
        accountId: 'account',
        target: {
          parentId: 'repay-inflow',
          legIds: [],
          ids: ['repay-inflow'],
        },
      },
    },
  });

  await assert.rejects(
    data.validateRepaymentConfirmationAdmission({ id: 'sg_repay-inflow' }),
    (error) => error.code === 'TRANSACTION_DELETION_IN_PROGRESS',
  );
  assert.equal(Object.keys(readJson(process.env.REPAYMENT_CONFIRMATION_SAGAS_PATH).sagas).length, 0);

  reset();
  delete require.cache[require.resolve('../dataModule.js')];
  const dataAfterReset = require('../dataModule');
  writeJson(process.env.TRANSACTION_SAGAS_PATH, {
    schemaVersion: 1,
    sagas: {
      active: {
        id: 'active-replace',
        recordVersion: 1,
        phase: 'replace_pending',
        accountId: 'account',
        original: { id: 'repay-inflow' },
        replacement: { id: 'replacement-inflow' },
        ids: ['repay-inflow'],
      },
    },
  });

  await assert.rejects(
    dataAfterReset.validateRepaymentConfirmationAdmission({ id: 'sg_repay-inflow' }),
    (error) => error.code === 'TRANSACTION_REPLACEMENT_IN_PROGRESS',
  );
  assert.equal(Object.keys(readJson(process.env.REPAYMENT_CONFIRMATION_SAGAS_PATH).sagas).length, 0);
});
