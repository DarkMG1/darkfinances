const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const os = require('os');
const path = require('path');
const {
  AccountNotFoundError,
  KnownPreApplyError,
  TransactionNotFoundError,
} = require('../lib/errors');
const { STATE_REGISTRY } = require('../lib/state-registry');

const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'darkfinances-data-boundaries-'));
for (const definition of Object.values(STATE_REGISTRY)) {
  process.env[definition.env] = path.join(dir, definition.filename);
}
process.env.ACTUAL_DATA_DIR = path.join(dir, 'actual-cache');
process.env.ACTUAL_SERVER_URL = 'http://actual.invalid';
process.env.ACTUAL_PASSWORD = 'test-password';
process.env.ACTUAL_SYNC_ID = 'test-sync-id';
process.env.ALLOW_RAW_ACTUAL_API = '1';

const data = require('../dataModule');
test.after(() => fs.rmSync(dir, { recursive: true, force: true }));

data.api.init = async () => {};
data.api.downloadBudget = async () => {};
data.api.sync = async () => {};

test('strict bank synchronization propagates a rejected external effect', async () => {
  let syncCalls = 0;
  data.api.runBankSync = async () => { throw new Error('injected bank sync rejection'); };
  data.api.sync = async () => { syncCalls += 1; };
  await assert.rejects(
    data.bankSync({ throwOnBankError: true }),
    /injected bank sync rejection/,
  );
  assert.equal(syncCalls, 0);
});

test('transaction creation does not swallow uncertain payee creation errors', async () => {
  let addCalls = 0;
  data.api.getPayees = async () => [];
  data.api.createPayee = async () => { throw new Error('injected payee creation rejection'); };
  data.api.addTransactions = async () => {
    addCalls += 1;
    return ['transaction-id'];
  };
  await assert.rejects(
    data.createTransaction({
      accountId: 'account-id',
      amount: -12.34,
      payee: 'New Payee',
      date: '2026-07-13',
    }, { sync: false }),
    /injected payee creation rejection/,
  );
  assert.equal(addCalls, 0);
});

test('transaction lookup distinguishes confirmed absence from transient errors', async () => {
  data.api.getCategories = async () => [];
  data.api.getPayees = async () => [];
  data.api.getAccounts = async () => [];

  await assert.rejects(
    data.getTransactionById({
      id: 'transaction-id',
      accountId: 'missing-account',
      date: '2026-07-13',
    }),
    (error) => {
      assert.ok(error instanceof AccountNotFoundError);
      assert.equal(error instanceof KnownPreApplyError, false);
      assert.equal(error.code, 'NOT_FOUND');
      assert.equal(error.status, 404);
      assert.equal(error.message, 'account not found');
      return true;
    },
  );

  data.api.getAccounts = async () => [{ id: 'closed-account', closed: true }];
  await assert.rejects(
    data.getTransactionById({
      id: 'transaction-id',
      date: '2026-07-13',
    }),
    (error) => {
      assert.equal(error instanceof AccountNotFoundError, false);
      assert.equal(error instanceof KnownPreApplyError, false);
      assert.equal(error.message, 'account not found');
      return true;
    },
  );

  const transientAccountLookup = new Error('injected Actual account lookup outage');
  data.api.getAccounts = async () => { throw transientAccountLookup; };
  await assert.rejects(
    data.getTransactionById({
      id: 'transaction-id',
      accountId: 'ambiguous-account',
      date: '2026-07-13',
    }),
    (error) => {
      assert.equal(error, transientAccountLookup);
      assert.equal(error instanceof KnownPreApplyError, false);
      return true;
    },
  );

  data.api.getAccounts = async () => [{ id: 'account-id', name: 'Checking', closed: false }];
  data.api.getTransactions = async () => [];
  await assert.rejects(
    data.getTransactionById({
      id: 'missing-transaction',
      accountId: 'account-id',
      date: '2026-07-13',
    }),
    (error) => {
      assert.ok(error instanceof TransactionNotFoundError);
      assert.equal(error instanceof KnownPreApplyError, false);
      assert.equal(error.code, 'NOT_FOUND');
      assert.equal(error.status, 404);
      assert.equal(error.message, 'Transaction not found');
      return true;
    },
  );

  const transient = new Error('injected Actual lookup outage');
  data.api.getTransactions = async () => { throw transient; };
  await assert.rejects(
    data.getTransactionById({
      id: 'ambiguous-transaction',
      accountId: 'account-id',
      date: '2026-07-13',
    }),
    (error) => {
      assert.equal(error, transient);
      assert.equal(error instanceof KnownPreApplyError, false);
      return true;
    },
  );
});

test('Splitwise structural account/category writes synchronize with zero transaction counters', async () => {
  fs.writeFileSync(process.env.OWES_TRUTH_PATH, JSON.stringify({
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
    othersPaidItems: [],
  }));

  let accountCreated = false;
  let categoryCreated = false;
  let syncCalls = 0;
  data.api.getAccounts = async () => accountCreated
    ? [{ id: 'splitwise-account', name: 'Splitwise', closed: false }]
    : [];
  data.api.createAccount = async () => {
    accountCreated = true;
    return 'splitwise-account';
  };
  data.api.getCategoryGroups = async () => [{
    id: 'spending-group',
    name: 'Spending',
    is_income: false,
    categories: categoryCreated
      ? [{ id: 'splitwise-category', name: 'Splitwise' }]
      : [{ id: 'food-category', name: 'Food' }],
  }];
  data.api.createCategory = async () => {
    categoryCreated = true;
    return 'splitwise-category';
  };
  data.api.getTransactions = async () => [];
  data.api.sync = async () => { syncCalls += 1; };

  const result = await data.syncSplitwiseShareExpenses();
  assert.equal(accountCreated, true);
  assert.equal(categoryCreated, true);
  assert.deepEqual(
    { created: result.created, updated: result.updated, pruned: result.pruned },
    { created: 0, updated: 0, pruned: 0 },
  );
  assert.equal(syncCalls, 1);
});
