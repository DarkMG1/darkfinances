'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const os = require('os');
const path = require('path');

const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'darkfinances-safe-to-spend-'));
const fixturePath = path.join(__dirname, 'fixtures', 'safe-to-spend.js');
process.env.ACTUAL_API_PATH = fixturePath;
process.env.ACTUAL_DATA_DIR = path.join(dir, 'actual-cache');

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
  VENMO_TRUTH_PATH: 'venmo-truth.json',
  DEBT_PLANNER_PATH: 'debt-planner.json',
})) process.env[env] = path.join(dir, filename);

const fixtures = require(fixturePath);
const { getToday, resetApi } = require('../dataModule');

test.after(() => fs.rmSync(dir, { recursive: true, force: true }));

function writeJson(file, value) {
  fs.writeFileSync(file, `${JSON.stringify(value, null, 2)}\n`);
}

async function metricFor(fixture, { overrides } = {}) {
  fixtures.configure(fixture);
  writeJson(process.env.ACCOUNT_OVERRIDES_PATH, {
    schemaVersion: 2,
    accounts: Object.fromEntries(fixture.accounts.map((account) => [
      account.id,
      { name: account.name, role: account.role },
    ])),
  });
  writeJson(process.env.BUDGET_SETTINGS_PATH, fixture.budgetSettings);
  writeJson(process.env.GOALS_PATH, fixture.goals);
  writeJson(process.env.RECURRING_OVERRIDES_PATH, overrides || {});
  writeJson(process.env.DEBT_PLANNER_PATH, { debts: [] });
  resetApi();
  return (await getToday()).liquidity.safeToSpend;
}

test('Safe-to-Spend quarantines every unresolved decision input', async (t) => {
  for (const scenario of fixtures.scenarios) {
    await t.test(scenario.name, async () => {
      const metric = await metricFor(scenario.fixture, { overrides: scenario.overrides });
      if (scenario.complete) {
        assert.equal(metric.complete, true);
        assert.equal(metric.value, 4700);
        assert.equal(metric.valueCents, 470000);
        assert.deepEqual(metric.incompleteReasons, []);
        return;
      }
      assert.equal(metric.complete, false);
      assert.equal(metric.value, null);
      assert.equal(metric.valueCents, null);
      assert.deepEqual(metric.incompleteReasons, scenario.reasons);
      assert.equal(new Set(metric.incompleteReasons).size, metric.incompleteReasons.length);
    });
  }
});

test('Safe-to-Spend remains available when every containment input is complete', async () => {
  const metric = await metricFor(fixtures.complete.fixture);
  assert.equal(metric.complete, true);
  assert.equal(metric.value, 4700);
  assert.equal(metric.valueCents, 470000);
  assert.deepEqual(metric.incompleteReasons, []);
});
