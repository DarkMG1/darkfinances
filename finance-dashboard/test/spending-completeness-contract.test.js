'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const { mock } = require('node:test');
const fs = require('fs');
const os = require('os');
const path = require('path');

process.env.FINANCE_TIME_ZONE = 'America/Los_Angeles';

const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'darkfinances-spending-completeness-'));
process.env.ACTUAL_API_PATH = path.join(__dirname, 'fixtures', 'account-projection-actual.js');
process.env.ACTUAL_DATA_DIR = path.join(dir, 'actual-cache');
process.env.SPLITWISE_MIRROR_ACCOUNT_ID = 'acc-splitwise';
for (const [env, filename] of Object.entries({
  ACCOUNT_OVERRIDES_PATH: 'account-overrides.json',
  MANUAL_ASSETS_PATH: 'manual-assets.json',
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
  VENMO_TRUTH_PATH: 'venmo-truth.json',
  DEBT_PLANNER_PATH: 'debt-planner.json',
})) process.env[env] = path.join(dir, filename);

const { getToday, getSpending, resetApi } = require('../dataModule');

test.after(() => fs.rmSync(dir, { recursive: true, force: true }));

function writeJson(file, value) {
  fs.writeFileSync(file, `${JSON.stringify(value, null, 2)}\n`);
}

async function withFinanceAnchor(fn) {
  mock.timers.enable({ apis: ['Date'], now: new Date('2026-07-15T17:01:00-07:00') });
  try {
    return await fn();
  } finally {
    mock.timers.reset();
  }
}

test('missing spending completeness fails Today closed', async () => {
  await withFinanceAnchor(async () => {
    resetApi();
    writeJson(process.env.ACCOUNT_OVERRIDES_PATH, {
      schemaVersion: 2,
      accounts: { 'acc-check': { role: 'operating_cash' } },
    });
    writeJson(process.env.MANUAL_ASSETS_PATH, { items: [] });
    const today = await getToday();
    assert.ok('complete' in today.spending.completeness);
    if (today.spending.completeness.complete !== true) {
      assert.equal(today.complete, false);
    }
  });
});

test('getSpending exposes current completeness separately from comparisonCompleteness', async () => {
  await withFinanceAnchor(async () => {
    resetApi();
    writeJson(process.env.ACCOUNT_OVERRIDES_PATH, {
      schemaVersion: 2,
      accounts: { 'acc-check': { role: 'operating_cash' } },
    });
    const spending = await getSpending({});
    assert.ok(spending.completeness);
    assert.ok(spending.comparisonCompleteness);
    assert.deepEqual(spending.completeness, spending.current.completeness);
  });
});

test('spending projection incompleteness marks current completeness incomplete', async () => {
  const previousMirror = process.env.SPLITWISE_MIRROR_ACCOUNT_ID;
  await withFinanceAnchor(async () => {
    try {
      resetApi();
      delete process.env.SPLITWISE_MIRROR_ACCOUNT_ID;
      writeJson(process.env.ACCOUNT_OVERRIDES_PATH, {
        schemaVersion: 2,
        accounts: {
          'acc-check': { role: 'operating_cash' },
          'acc-splitwise': { role: 'operating_cash' },
        },
      });
      const today = await getToday();
      assert.equal(today.spending.completeness.complete, false);
      assert.ok(today.spending.completeness.incompleteReasons.length > 0);
      assert.equal(today.complete, false);
    } finally {
      if (previousMirror === undefined) delete process.env.SPLITWISE_MIRROR_ACCOUNT_ID;
      else process.env.SPLITWISE_MIRROR_ACCOUNT_ID = previousMirror;
    }
  });
});
