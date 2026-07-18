'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const os = require('os');
const path = require('path');

const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'darkfinances-today-goals-projection-'));
const fixturePath = path.join(__dirname, 'fixtures', 'account-projection-actual.js');
process.env.ACTUAL_API_PATH = fixturePath;
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
const { QueryAbortedError } = require('../lib/errors');
const {
  getToday,
  getGoalsWithAdvisory,
  resetApi,
} = require('../dataModule');

test.after(() => fs.rmSync(dir, { recursive: true, force: true }));

function writeJson(file, value) {
  fs.writeFileSync(file, `${JSON.stringify(value, null, 2)}\n`);
}

function withBalanceInstrumentation(fn) {
  const api = require(process.env.ACTUAL_API_PATH);
  const original = api.getAccountBalance.bind(api);
  let calls = 0;
  api.getAccountBalance = async (id) => {
    calls += 1;
    return fn(id, original);
  };
  return {
    restore() {
      api.getAccountBalance = original;
    },
    callCount: () => calls,
  };
}

function baseOverrides() {
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

test('getToday returns full payload with null metrics and empty STS sources when operating balance unavailable', async () => {
  resetApi();
  writeJson(process.env.ACCOUNT_OVERRIDES_PATH, baseOverrides());
  const instrument = withBalanceInstrumentation(async (id, original) => (
    id === 'acc-check' ? null : original(id)
  ));
  try {
    const today = await getToday();
    assert.equal(today.metrics.operatingCash.complete, false);
    assert.equal(today.metrics.operatingCash.value, null);
    assert.deepEqual(today.metrics.operatingCash.provenance?.sources, []);
    assert.equal(today.metrics.liquidCash.complete, false);
    assert.equal(today.metrics.netWorth.complete, false);
    assert.equal(today.liquidity.safeToSpend.complete, false);
    assert.equal(today.liquidity.safeToSpend.value, null);
    assert.deepEqual(today.liquidity.safeToSpend.provenance?.sources, []);
    assert.ok(today.liquidity.safeToSpend.incompleteReasons.includes('account_balance_unavailable'));
    assert.ok(today.accounts.length > 0);
    assert.ok(today.spending);
    assert.equal(today.liquidity.goalAdvisory?.complete, false);
  } finally {
    instrument.restore();
  }
});

test('getToday performs one balance read pass shared with goals advisory materialization', async () => {
  resetApi();
  writeJson(process.env.ACCOUNT_OVERRIDES_PATH, baseOverrides());
  writeJson(process.env.GOALS_PATH, [{
    id: 'g1',
    name: 'Emergency',
    target: 1000,
    current: 200,
    accountId: 'acc-save',
  }]);
  const instrument = withBalanceInstrumentation((_id, original) => original(_id));
  try {
    await getToday();
    assert.equal(instrument.callCount(), fixture.accounts.length);
  } finally {
    instrument.restore();
  }
});

test('getGoalsWithAdvisory returns incomplete advisory and null feasible when linked balance unavailable', async () => {
  resetApi();
  writeJson(process.env.ACCOUNT_OVERRIDES_PATH, baseOverrides());
  writeJson(process.env.GOALS_PATH, [{
    id: 'g1',
    name: 'Emergency',
    target: 1000,
    current: 200,
    accountId: 'acc-check',
  }]);
  const instrument = withBalanceInstrumentation(async (id, original) => (
    id === 'acc-check' ? null : original(id)
  ));
  try {
    const { goals, goalAdvisory } = await getGoalsWithAdvisory();
    assert.equal(goalAdvisory.complete, false);
    assert.ok(goalAdvisory.incompleteReasons.includes('account_balance_unavailable'));
    assert.equal(goals[0].feasibility.feasible, null);
    assert.equal(goals[0].availableInAccount, null);
  } finally {
    instrument.restore();
  }
});

test('getToday rethrows QueryAbortedError from balance reads', async () => {
  resetApi();
  writeJson(process.env.ACCOUNT_OVERRIDES_PATH, baseOverrides());
  const instrument = withBalanceInstrumentation(async () => {
    throw new QueryAbortedError('balance read aborted');
  });
  try {
    await assert.rejects(() => getToday(), QueryAbortedError);
  } finally {
    instrument.restore();
  }
});

test('getGoalsWithAdvisory rethrows QueryAbortedError from balance reads', async () => {
  resetApi();
  writeJson(process.env.ACCOUNT_OVERRIDES_PATH, baseOverrides());
  const instrument = withBalanceInstrumentation(async () => {
    throw new QueryAbortedError('balance read aborted');
  });
  try {
    await assert.rejects(() => getGoalsWithAdvisory(), QueryAbortedError);
  } finally {
    instrument.restore();
  }
});
