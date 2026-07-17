'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const os = require('os');
const path = require('path');

const { addDays, daysInMonth, todayYMD } = require('../lib/date-only');
const { fromCents, sumCents, toCents } = require('../lib/domain/money');
const {
  allocateCentsOverDays,
  buildForecastBudgetDailyCents,
  GENERIC_BUDGET_SKIP_WARNING,
} = require('../lib/domain/cent-allocation');

const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'darkfinances-forecast-cent-allocation-'));
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
const { getForecast, getToday, getBudgets, resetApi } = require('../dataModule');

test.after(() => fs.rmSync(dir, { recursive: true, force: true }));

function writeJson(file, value) {
  fs.writeFileSync(file, `${JSON.stringify(value, null, 2)}\n`);
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
  writeJson(process.env.GOALS_PATH, fixture.goals);
  resetApi();
}

function genericCategoriesFromBudgets(budgets) {
  const billCat = /(util|electric|subscription|software|hosting)/i;
  return budgets.groups.flatMap((group) => (group.categories || [])
    .filter((category) => !billCat.test(`${group.name || ''} ${category.name || ''}`)));
}

function expectedBudgetCentsForMonth(events, month) {
  return sumCents(
    events
      .filter((event) => event.kind === 'budget' && event.date.startsWith(month))
      .map((event) => toCents(Math.abs(event.amount))),
  );
}

function forecastNetEventCents(forecast) {
  return sumCents(forecast.events.map((event) => toCents(event.amount)));
}

function expectedEndingBalanceCents(forecast) {
  return sumCents([toCents(forecast.startBalance), forecastNetEventCents(forecast)]);
}

test('getForecast budget events conserve remaining cents for the current month', async () => {
  const fixture = fixtures.complete.fixture;
  await bootstrap(fixture);
  const forecast = await getForecast({ days: 45 });
  const today = forecast.range.start;
  const budgetEvents = forecast.events.filter((event) => event.kind === 'budget');
  assert.ok(budgetEvents.length > 0);

  const month = today.slice(0, 7);
  const budgetCents = expectedBudgetCentsForMonth(forecast.events, month);
  const budgets = await getBudgets({});
  const expectedRemaining = sumCents(
    genericCategoriesFromBudgets(budgets).map((category) => toCents(category.remaining || 0)),
  );
  assert.equal(budgetCents, expectedRemaining);
  assert.equal(forecast.assumptions.genericBudget.complete, true);
  assert.equal(forecast.assumptions.genericBudget.remaining, fromCents(expectedRemaining));
});

test('getForecast conserves full future-month target when horizon covers the month', async () => {
  await bootstrap(fixtures.complete.fixture);
  const forecast = await getForecast({ days: 90 });
  const today = forecast.range.start;
  const currentMonth = today.slice(0, 7);
  const nextMonthDate = addDays(`${currentMonth}-28`, 10);
  const nextMonth = nextMonthDate.slice(0, 7);
  if (nextMonth === currentMonth) return;

  const budgets = await getBudgets({});
  const expectedTarget = sumCents(
    genericCategoriesFromBudgets(budgets).map((category) => toCents(category.target || 0)),
  );
  const monthEvents = forecast.events.filter((event) => event.kind === 'budget' && event.date.startsWith(nextMonth));
  if (monthEvents.length === daysInMonth(nextMonth)) {
    assert.equal(expectedBudgetCentsForMonth(forecast.events, nextMonth), expectedTarget);
  }
});

test('partial horizon emits a conserving prefix of current-month remaining', async () => {
  await bootstrap(fixtures.complete.fixture);
  const forecast = await getForecast({ days: 45 });
  const today = forecast.range.start;
  const month = today.slice(0, 7);
  const remainingDays = Math.max(1, daysInMonth(month) - Number(today.slice(8, 10)) + 1);
  const horizonDays = 7;
  const entries = buildForecastBudgetDailyCents({
    today,
    horizonDays,
    currentMonthRemainingCents: toCents(forecast.assumptions.genericBudget.remaining),
    fullMonthTargetCents: toCents(forecast.assumptions.genericBudget.target),
    addDays,
    daysInMonth,
  });
  const expectedDays = Math.min(horizonDays + 1, remainingDays);
  const partialEvents = entries.filter((entry) => entry.date.startsWith(month));
  assert.equal(partialEvents.length, expectedDays);

  const { allocationsCents } = allocateCentsOverDays(
    toCents(forecast.assumptions.genericBudget.remaining),
    remainingDays,
  );
  assert.deepEqual(
    partialEvents.map((entry) => entry.centsCents),
    allocationsCents.slice(0, expectedDays),
  );
});

test('getForecast month boundary transitions from remaining to full target without drift', async () => {
  const today = '2026-01-30';
  const totalCents = toCents(31);
  const entries = buildForecastBudgetDailyCents({
    today,
    horizonDays: 5,
    currentMonthRemainingCents: totalCents,
    fullMonthTargetCents: totalCents,
    addDays,
    daysInMonth,
  });
  const jan = entries.filter((entry) => entry.date.startsWith('2026-01'));
  const feb = entries.filter((entry) => entry.date.startsWith('2026-02'));
  assert.equal(jan.length, 2);
  assert.equal(feb.length, 4);
  assert.equal(sumCents(jan.map((entry) => entry.centsCents)), totalCents);
  const febAlloc = allocateCentsOverDays(totalCents, daysInMonth('2026-02')).allocationsCents;
  assert.deepEqual(
    feb.map((entry) => entry.centsCents),
    febAlloc.slice(0, 4),
  );
});

test('getForecast points, endingBalance, and lowest conserve cent event arithmetic', async () => {
  await bootstrap(fixtures.complete.fixture);
  const forecast = await getForecast({ days: 60 });
  const expectedEnding = expectedEndingBalanceCents(forecast);
  assert.equal(toCents(forecast.endingBalance), expectedEnding);

  let balanceCents = toCents(forecast.startBalance);
  let lowest = { date: forecast.range.start, balanceCents };
  for (const point of forecast.points) {
    const dayNet = sumCents([
      toCents(point.inflow),
      -toCents(point.outflow),
    ]);
    balanceCents = sumCents([balanceCents, dayNet]);
    assert.equal(toCents(point.balance), balanceCents);
    if (point.balance < fromCents(lowest.balanceCents)) {
      lowest = { date: point.date, balanceCents: toCents(point.balance) };
    }
  }
  assert.equal(toCents(forecast.lowest.balance), lowest.balanceCents);
  assert.equal(
    toCents(forecast.totals.inflow) - toCents(forecast.totals.outflow),
    forecastNetEventCents(forecast),
  );
});

test('repeated getForecast calls produce identical budget totals', async () => {
  await bootstrap(fixtures.complete.fixture);
  const first = await getForecast({ days: 60 });
  const second = await getForecast({ days: 60 });
  const budgetSum = (forecast) => sumCents(
    forecast.events.filter((event) => event.kind === 'budget').map((event) => toCents(Math.abs(event.amount))),
  );
  assert.equal(budgetSum(first), budgetSum(second));
  assert.deepEqual(
    first.events.filter((event) => event.kind === 'budget').map((event) => [event.date, event.amount]),
    second.events.filter((event) => event.kind === 'budget').map((event) => [event.date, event.amount]),
  );
});

test('invalid category budgets skip events and expose truthful nullable assumptions', async () => {
  const { buildForecastGenericBudgetContext } = require('../lib/domain/cent-allocation');
  const invalid = buildForecastGenericBudgetContext([
    { name: 'Groceries', target: 100, remaining: Number.NaN },
    { name: 'Dining', target: '300.01', remaining: 50 },
  ]);
  assert.equal(invalid.complete, false);
  assert.equal(invalid.assumptions.target, null);
  assert.equal(invalid.assumptions.remaining, null);
  assert.deepEqual(invalid.assumptions.incompleteReasons, ['money_input_invalid']);
  assert.ok(invalid.warnings.includes(GENERIC_BUDGET_SKIP_WARNING));

  await bootstrap(fixtures.complete.fixture);
  const forecast = await getForecast({ days: 45 });
  assert.equal(forecast.assumptions.genericBudget.complete, true);
  assert.notEqual(forecast.assumptions.genericBudget.target, null);
  assert.notEqual(forecast.assumptions.genericBudget.remaining, null);
});

test('getToday Safe-to-Spend quarantine is unchanged by cent allocation work', async () => {
  const fixture = fixtures.buildUncertainRentFixture();
  await bootstrap(fixture);
  writeJson(process.env.RECURRING_OVERRIDES_PATH, {
    'skyline apartments': { forced: true, isBill: true },
  });
  const today = await getToday();
  const metric = today.liquidity.safeToSpend;
  assert.equal(metric.complete, false);
  assert.equal(metric.value, null);
  assert.ok(metric.incompleteReasons.includes('bill_recurrence_unresolved'));
});

test('forecast inclusion policy matches characterized today-inclusive remaining window', () => {
  const today = todayYMD();
  const month = today.slice(0, 7);
  const dayOfMonth = Number(today.slice(8, 10));
  const remainingDays = Math.max(1, daysInMonth(month) - dayOfMonth + 1);
  const entries = buildForecastBudgetDailyCents({
    today,
    horizonDays: remainingDays - 1,
    currentMonthRemainingCents: 100,
    fullMonthTargetCents: 200,
    addDays,
    daysInMonth,
  });
  assert.equal(entries.length, remainingDays);
  assert.equal(sumCents(entries.map((entry) => entry.centsCents)), 100);
  assert.equal(entries[0].date, today);
  assert.equal(entries[entries.length - 1].date, addDays(today, remainingDays - 1));
});

test('America/Los_Angeles DST calendar boundaries preserve cent conservation', () => {
  const today = '2026-03-07';
  const remainingDays = Math.max(1, daysInMonth('2026-03') - 7 + 1);
  const totalCents = 3100;
  const { allocationsCents } = allocateCentsOverDays(totalCents, remainingDays);
  const entries = buildForecastBudgetDailyCents({
    today,
    horizonDays: 4,
    currentMonthRemainingCents: totalCents,
    fullMonthTargetCents: totalCents,
    addDays,
    daysInMonth,
  });
  assert.equal(entries.length, 5);
  assert.deepEqual(
    entries.map((entry) => entry.centsCents),
    allocationsCents.slice(0, 5),
  );
  assert.equal(sumCents(entries.map((entry) => entry.centsCents)), sumCents(allocationsCents.slice(0, 5)));
  assert.equal(entries[0].date, '2026-03-07');
  assert.equal(entries[4].date, '2026-03-11');
});

test('long-horizon signed budget projection conserves ending balance in cents', async () => {
  await bootstrap(fixtures.complete.fixture);
  const forecast = await getForecast({ days: 120 });
  assert.equal(toCents(forecast.endingBalance), expectedEndingBalanceCents(forecast));
  for (const event of forecast.events.filter((entry) => entry.kind === 'budget')) {
    assert.ok(Number.isSafeInteger(toCents(event.amount)));
    assert.ok(event.amount < 0);
  }
});
