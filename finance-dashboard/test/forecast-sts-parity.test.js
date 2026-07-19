'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const os = require('os');
const path = require('path');

const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'darkfinances-forecast-sts-parity-'));
const fixturePath = path.join(__dirname, 'fixtures', 'safe-to-spend.js');
process.env.ACTUAL_API_PATH = fixturePath;
process.env.ACTUAL_DATA_DIR = path.join(dir, 'actual-cache');
process.env.FINANCE_TIME_ZONE = 'America/Los_Angeles';
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
})) process.env[env] = path.join(dir, filename);

const fixtures = require(fixturePath);
const { getToday, getForecast, resetApi } = require('../dataModule');
const { SAFE_TO_SPEND_REASON } = require('../lib/safe-to-spend');

test.after(() => fs.rmSync(dir, { recursive: true, force: true }));

function writeJson(file, value) {
  fs.writeFileSync(file, `${JSON.stringify(value, null, 2)}\n`);
}

function financeToday() {
  return new Intl.DateTimeFormat('en-CA', { timeZone: 'America/Los_Angeles' }).format(new Date());
}

function monthShift(key, delta) {
  const [year, month] = key.split('-').map(Number);
  const value = new Date(Date.UTC(year, month - 1 + delta, 1));
  return `${value.getUTCFullYear()}-${String(value.getUTCMonth() + 1).padStart(2, '0')}`;
}

function buildPrevMonthTransferMismatchFixture() {
  const fixture = fixtures.buildFixture();
  const today = financeToday();
  const prevMonth = monthShift(today.slice(0, 7), -1);
  fixture.accounts.push({
    id: 'acc-savings',
    name: 'Savings',
    closed: false,
    offbudget: false,
    balance: 100000,
    role: 'operating_cash',
  });
  fixture.transactions.push(
    {
      id: 'xfer-a',
      account: 'acc-check',
      date: `${prevMonth}-20`,
      amount: -50000,
      transfer_id: 'xfer-b',
      category: 'groceries',
      payee: 'dining-payee',
      cleared: true,
    },
    {
      id: 'xfer-b',
      account: 'acc-savings',
      date: `${today.slice(0, 7)}-05`,
      amount: 25000,
      transfer_id: 'xfer-a',
      cleared: true,
    },
  );
  return fixture;
}

async function bootstrap(fixture) {
  fixtures.configure(fixture);
  writeJson(process.env.ACCOUNT_OVERRIDES_PATH, {
    schemaVersion: 2,
    accounts: Object.fromEntries(fixture.accounts.map((account) => [
      account.id,
      { name: account.name, role: account.role },
    ])),
  });
  writeJson(process.env.BUDGET_SETTINGS_PATH, fixture.budgetSettings);
  writeJson(process.env.GOALS_PATH, fixture.goals || []);
  resetApi();
}

test('getForecast STS containment mirrors Today when prev-month transfer pairing is unresolved', async () => {
  await bootstrap(buildPrevMonthTransferMismatchFixture());
  const today = await getToday();
  const forecast = await getForecast({ days: 45 });
  assert.equal(today.liquidity.safeToSpend.complete, false);
  assert.ok(today.liquidity.safeToSpend.incompleteReasons.includes(SAFE_TO_SPEND_REASON.transferIdentityUnresolved));
  assert.equal(forecast.assumptions.stsContainment.complete, today.liquidity.safeToSpend.complete);
  for (const reason of today.liquidity.safeToSpend.incompleteReasons) {
    assert.ok(
      forecast.assumptions.stsContainment.incompleteReasons.includes(reason),
      `forecast STS missing ${reason}`,
    );
  }
  assert.equal(forecast.assumptions.projectionContainment.stsContainmentIncomplete, true);
});

test('getForecast STS containment mirrors Today rollover quarantine reasons', async () => {
  await bootstrap(fixtures.buildFixture({ rolloverExplicit: false }));
  const [today, forecast] = await Promise.all([
    getToday(),
    getForecast({ days: 30 }),
  ]);
  assert.ok(today.liquidity.safeToSpend.incompleteReasons.includes(SAFE_TO_SPEND_REASON.rolloverTreatmentUnknown));
  for (const reason of today.liquidity.safeToSpend.incompleteReasons) {
    assert.ok(forecast.assumptions.stsContainment.incompleteReasons.includes(reason));
  }
});
