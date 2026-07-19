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

function withSecondAccount(fixture) {
  fixture.accounts.push({
    id: 'acc-savings',
    name: 'Savings',
    closed: false,
    offbudget: false,
    balance: 100000,
    role: 'operating_cash',
  });
  return fixture;
}

function buildPrevMonthTransferMismatchFixture() {
  const fixture = withSecondAccount(fixtures.buildFixture());
  const today = financeToday();
  const prevMonth = monthShift(today.slice(0, 7), -1);
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

function buildPrevMonthOnlyMismatchFixture() {
  const fixture = withSecondAccount(fixtures.buildFixture());
  const today = financeToday();
  const prevMonth = monthShift(today.slice(0, 7), -1);
  fixture.transactions.push(
    {
      id: 'prev-a',
      account: 'acc-check',
      date: `${prevMonth}-10`,
      amount: -50000,
      transfer_id: 'prev-b',
      category: 'groceries',
      payee: 'dining-payee',
      cleared: true,
    },
    {
      id: 'prev-b',
      account: 'acc-savings',
      date: `${prevMonth}-11`,
      amount: 25000,
      transfer_id: 'prev-a',
      cleared: true,
    },
    {
      id: 'mtd-spend',
      account: 'acc-check',
      date: `${today.slice(0, 7)}-05`,
      amount: -1000,
      category: 'groceries',
      payee: 'dining-payee',
      cleared: true,
    },
  );
  return fixture;
}

function buildFutureNextMonthCounterpartMismatchFixture() {
  const fixture = withSecondAccount(fixtures.buildFixture());
  const today = financeToday();
  const nextMonth = monthShift(today.slice(0, 7), 1);
  fixture.transactions.push(
    {
      id: 'mtd-a',
      account: 'acc-check',
      date: `${today.slice(0, 7)}-10`,
      amount: -50000,
      transfer_id: 'future-b',
      category: 'groceries',
      payee: 'dining-payee',
      cleared: true,
    },
    {
      id: 'future-b',
      account: 'acc-savings',
      date: `${nextMonth}-05`,
      amount: 25000,
      transfer_id: 'mtd-a',
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

function assertTransferIdentityParity(today, forecast) {
  const todayHas = today.liquidity.safeToSpend.incompleteReasons
    .includes(SAFE_TO_SPEND_REASON.transferIdentityUnresolved);
  const forecastHas = forecast.assumptions.stsContainment.incompleteReasons
    .includes(SAFE_TO_SPEND_REASON.transferIdentityUnresolved);
  assert.equal(forecastHas, todayHas, 'transfer_identity_unresolved parity');
}

function assertTodayStsReasonsSubsetOfForecast(today, forecast) {
  for (const reason of today.liquidity.safeToSpend.incompleteReasons) {
    assert.ok(
      forecast.assumptions.stsContainment.incompleteReasons.includes(reason),
      `forecast STS missing Today reason ${reason}`,
    );
  }
}

test('getForecast STS transfer quarantine mirrors Today for prev+current transfer mismatch', async () => {
  await bootstrap(buildPrevMonthTransferMismatchFixture());
  const today = await getToday();
  const forecast = await getForecast({ days: 45 });
  assert.equal(today.spending.current.completeness.complete, false);
  assert.equal(today.liquidity.safeToSpend.complete, false);
  assert.ok(today.liquidity.safeToSpend.incompleteReasons.includes(SAFE_TO_SPEND_REASON.transferIdentityUnresolved));
  assertTransferIdentityParity(today, forecast);
  assertTodayStsReasonsSubsetOfForecast(today, forecast);
  assert.equal(forecast.assumptions.projectionContainment.stsContainmentIncomplete, true);
});

test('getForecast STS ignores prev-month-only transfer mismatch when current month is clean', async () => {
  await bootstrap(buildPrevMonthOnlyMismatchFixture());
  const today = await getToday();
  const forecast = await getForecast({ days: 45 });
  assert.equal(today.spending.current.completeness.complete, true);
  assert.equal(today.liquidity.safeToSpend.incompleteReasons.includes(SAFE_TO_SPEND_REASON.transferIdentityUnresolved), false);
  assertTransferIdentityParity(today, forecast);
  assert.equal(
    forecast.assumptions.stsContainment.incompleteReasons.includes(SAFE_TO_SPEND_REASON.transferIdentityUnresolved),
    false,
  );
});

test('getForecast STS ignores future next-month counterpart mismatch outside Today envelope', async () => {
  await bootstrap(buildFutureNextMonthCounterpartMismatchFixture());
  const today = await getToday();
  const forecast = await getForecast({ days: 120 });
  assert.equal(today.spending.current.completeness.complete, true);
  assertTransferIdentityParity(today, forecast);
  assert.equal(
    forecast.assumptions.stsContainment.incompleteReasons.includes(SAFE_TO_SPEND_REASON.transferIdentityUnresolved),
    false,
  );
});

test('getForecast STS containment mirrors Today rollover quarantine reasons', async () => {
  await bootstrap(fixtures.buildFixture({ rolloverExplicit: false }));
  const today = await getToday();
  const forecast = await getForecast({ days: 30 });
  assert.ok(today.liquidity.safeToSpend.incompleteReasons.includes(SAFE_TO_SPEND_REASON.rolloverTreatmentUnknown));
  assertTodayStsReasonsSubsetOfForecast(today, forecast);
});

test('getForecast STS derivation reuses the horizon scan without extra ledger reads', async () => {
  await bootstrap(fixtures.buildFixture());
  let ledgerCalls = 0;
  const original = fixtures.getTransactions;
  fixtures.getTransactions = async (...args) => {
    ledgerCalls += 1;
    return original(...args);
  };
  try {
    await getForecast({ days: 90 });
    const firstPassCalls = ledgerCalls;
    ledgerCalls = 0;
    await getForecast({ days: 90 });
    assert.equal(ledgerCalls, firstPassCalls);
    assert.ok(firstPassCalls > 0);
  } finally {
    fixtures.getTransactions = original;
  }
});
