'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const { mock } = require('node:test');
const fs = require('fs');
const os = require('os');
const path = require('path');

const { addDays, monthStart } = require('../lib/date-only');

process.env.FINANCE_TIME_ZONE = 'America/Los_Angeles';
process.env.REIMB_SUGGEST_FROM = '2020-01-01';

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

const {
  getToday,
  getTrends,
  getSpending,
  getAccounts,
  getForecast,
  resetApi,
} = require('../dataModule');

test.after(() => fs.rmSync(dir, { recursive: true, force: true }));

const FINANCE_ANCHORS = [
  {
    label: 'mid-month summer',
    iso: '2026-07-15T17:01:00-07:00',
    financeDate: '2026-07-15',
  },
  {
    label: 'year boundary',
    iso: '2025-12-31T17:01:00-08:00',
    financeDate: '2025-12-31',
  },
];

function writeJson(file, value) {
  fs.writeFileSync(file, `${JSON.stringify(value, null, 2)}\n`);
}

async function withFinanceAnchor(iso, fn) {
  mock.timers.enable({ apis: ['Date'], now: new Date(iso) });
  try {
    return await fn();
  } finally {
    mock.timers.reset();
  }
}

function baseAccountOverrides() {
  return {
    schemaVersion: 2,
    accounts: {
      'acc-check': { name: 'Everyday', role: 'operating_cash' },
      'acc-save': { role: 'protected_savings' },
      'acc-credit': { role: 'credit_card' },
      'acc-hidden': { hidden: true, role: 'credit_card' },
      'acc-excluded': { role: 'excluded' },
      'acc-splitwise': { role: 'operating_cash' },
    },
  };
}

async function assertEndpointAgreement(financeDate) {
  resetApi();
  writeJson(process.env.ACCOUNT_OVERRIDES_PATH, baseAccountOverrides());
  writeJson(process.env.MANUAL_ASSETS_PATH, {
    items: [{ id: 'm1', name: 'Car', value: 100, kind: 'asset', updated: monthStart(financeDate) }],
  });

  const [today, trends, spending, accounts] = await Promise.all([
    getToday(),
    getTrends({ months: 6 }),
    getSpending({}),
    getAccounts(),
  ]);

  assert.equal(today.financeDate, financeDate);
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

  const recentTxn = today.activity.recent.find((row) => row.accountId === 'acc-check');
  assert.equal(recentTxn.account, 'Everyday');
  assert.equal(recentTxn.date, addDays(financeDate, -5));
}

for (const anchor of FINANCE_ANCHORS) {
  test(`endpoint agreement on included account ids across today, trends, and spending at ${anchor.label}`, async () => {
    await withFinanceAnchor(anchor.iso, () => assertEndpointAgreement(anchor.financeDate));
  });
}

test('renamed account display propagates to transactions', async () => {
  const anchor = FINANCE_ANCHORS[0];
  await withFinanceAnchor(anchor.iso, async () => {
    resetApi();
    writeJson(process.env.ACCOUNT_OVERRIDES_PATH, {
      schemaVersion: 2,
      accounts: { 'acc-check': { name: 'Everyday', role: 'operating_cash' } },
    });
    const today = await getToday();
    const txn = today.activity.recent.find((row) => row.accountId === 'acc-check');
    assert.equal(txn.account, 'Everyday');
    assert.equal(txn.date, addDays(anchor.financeDate, -5));
  });
});

test('trends spend/income/net withheld when spending projection is incomplete', async () => {
  const anchor = FINANCE_ANCHORS[0];
  const previousMirror = process.env.SPLITWISE_MIRROR_ACCOUNT_ID;
  await withFinanceAnchor(anchor.iso, async () => {
    try {
      resetApi();
      delete process.env.SPLITWISE_MIRROR_ACCOUNT_ID;
      writeJson(process.env.ACCOUNT_OVERRIDES_PATH, {
        schemaVersion: 2,
        accounts: {
          'acc-check': { role: 'operating_cash' },
          'acc-save': { role: 'protected_savings' },
          'acc-credit': { role: 'credit_card' },
          'acc-splitwise': { role: 'operating_cash' },
        },
      });
      const trends = await getTrends({ months: 6 });
      assert.equal(trends.scope.spendingProjectionComplete, false);
      assert.ok(trends.months.every((month) => month.spend == null && month.income == null && month.net == null));
    } finally {
      if (previousMirror === undefined) delete process.env.SPLITWISE_MIRROR_ACCOUNT_ID;
      else process.env.SPLITWISE_MIRROR_ACCOUNT_ID = previousMirror;
    }
  });
});

test('getForecast withholds start balance when operating cash projection is incomplete', async () => {
  const anchor = FINANCE_ANCHORS[0];
  await withFinanceAnchor(anchor.iso, async () => {
    resetApi();
    process.env.SPLITWISE_MIRROR_ACCOUNT_ID = 'acc-splitwise';
    writeJson(process.env.ACCOUNT_OVERRIDES_PATH, {
      schemaVersion: 2,
      accounts: {
        'acc-save': { role: 'protected_savings' },
        'acc-credit': { role: 'credit_card' },
      },
    });
    const forecast = await getForecast({ days: 45 });
    assert.equal(forecast.startBalance, null);
    assert.ok(forecast.warnings.some((warning) => /operating cash projection incomplete/i.test(warning)));
    assert.ok(forecast.assumptions.operatingCashComplete === false);
  });
});
