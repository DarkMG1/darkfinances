'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const os = require('os');
const path = require('path');

const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'darkfinances-account-projection-integration-'));
process.env.ACTUAL_API_PATH = path.join(__dirname, 'fixtures', 'account-projection-actual.js');
process.env.ACTUAL_DATA_DIR = path.join(dir, 'actual-cache');
process.env.SPLITWISE_MIRROR_ACCOUNT_ID = 'acc-splitwise';
for (const [env, filename] of Object.entries({
  ACCOUNT_OVERRIDES_PATH: 'account-overrides.json',
  BILLS_PAID_PATH: 'bills-paid.json',
  BUDGET_SETTINGS_PATH: 'budget-settings.json',
  EVENTS_PATH: 'events.json',
  GOALS_PATH: 'goals.json',
  OWES_CONFIG_PATH: 'owes-config.json',
  OWES_TRUTH_PATH: 'owes-truth.json',
  PERSONAL_CONFIG_PATH: 'personal-config.json',
  RECEIPTS_PATH: 'receipts.json',
  RECON_PATH: 'reconciliation.json',
  REIMB_LINKS_PATH: 'reimb-links.json',
  REIMB_SUGGEST_PATH: 'reimb-suggest.json',
  RECURRING_OVERRIDES_PATH: 'recurring-overrides.json',
  REVIEW_STATE_PATH: 'review-state.json',
  TRANSACTION_SAGAS_PATH: 'transaction-sagas.json',
  MANUAL_ASSETS_PATH: 'manual-assets.json',
  VENMO_TRUTH_PATH: 'venmo-truth.json',
  DEBT_PLANNER_PATH: 'debt-planner.json',
})) process.env[env] = path.join(dir, filename);

const fixture = require('./fixtures/account-projection-actual');
const {
  getToday,
  getTrends,
  getSpending,
  getAccounts,
  resetApi,
} = require('../dataModule');

test.after(() => fs.rmSync(dir, { recursive: true, force: true }));

function writeJson(file, value) {
  fs.writeFileSync(file, `${JSON.stringify(value, null, 2)}\n`);
}

test('endpoint agreement on included account ids across today, trends, and spending', async () => {
  resetApi();
  writeJson(process.env.ACCOUNT_OVERRIDES_PATH, {
    schemaVersion: 2,
    accounts: {
      'acc-check': { name: 'Everyday', role: 'operating_cash' },
      'acc-save': { role: 'protected_savings' },
      'acc-credit': { role: 'credit_card' },
      'acc-hidden': { hidden: true, role: 'credit_card' },
      'acc-excluded': { role: 'excluded' },
      'acc-splitwise': { role: 'operating_cash' },
    },
  });
  writeJson(process.env.MANUAL_ASSETS_PATH, { items: [{ id: 'm1', name: 'Car', value: 100, kind: 'asset', updated: '2026-07-01' }] });

  const [today, trends, spending, accounts] = await Promise.all([
    getToday(),
    getTrends({ months: 6 }),
    getSpending({}),
    getAccounts(),
  ]);

  assert.equal(today.metrics.netWorth.complete, true);
  assert.ok(today.scope.accountProjectionRevision);
  assert.deepEqual(today.scope.netWorthIncludedAccountIds.sort(), trends.scope.netWorthIncludedAccountIds.sort());
  assert.ok(!today.scope.netWorthIncludedAccountIds.includes('acc-hidden'));
  assert.ok(!today.scope.netWorthIncludedAccountIds.includes('acc-excluded'));
  assert.ok(!today.scope.netWorthIncludedAccountIds.includes('acc-splitwise'));
  assert.ok(spending.scope.spendingIncludedAccountIds.includes('acc-splitwise'));
  assert.ok(!spending.scope.spendingIncludedAccountIds.includes('acc-hidden'));
  assert.equal(accounts.find((account) => account.id === 'acc-check').name, 'Everyday');
  assert.equal(accounts.find((account) => account.id === 'acc-check').inclusion.netWorth, true);
});

test('renamed account display propagates to transactions', async () => {
  resetApi();
  writeJson(process.env.ACCOUNT_OVERRIDES_PATH, {
    schemaVersion: 2,
    accounts: { 'acc-check': { name: 'Everyday', role: 'operating_cash' } },
  });
  const today = await getToday();
  const txn = today.activity.recent.find((row) => row.accountId === 'acc-check');
  assert.equal(txn.account, 'Everyday');
});
