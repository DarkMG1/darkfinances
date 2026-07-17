'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const os = require('os');
const path = require('path');

const { addDays, daysInMonth, todayYMD } = require('../lib/date-only');
const { sumCents, toCents } = require('../lib/domain/money');
const { buildForecastBudgetDailyCents } = require('../lib/domain/cent-allocation');

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
const { getForecast, getToday, resetApi } = require('../dataModule');

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

test('getForecast budget events conserve remaining cents for the current month', async () => {
  const fixture = fixtures.complete.fixture;
  await bootstrap(fixture);
  const forecast = await getForecast({ days: 45 });
  const today = forecast.range.start;
  const budgetEvents = forecast.events.filter((event) => event.kind === 'budget');
  assert.ok(budgetEvents.length > 0);

  const month = today.slice(0, 7);
  const currentMonthEvents = budgetEvents.filter((event) => event.date.startsWith(month));
  const budgetCents = sumCents(currentMonthEvents.map((event) => toCents(Math.abs(event.amount))));
  const expectedRemaining = sumCents(
    (await (async () => {
      const { getBudgets } = require('../dataModule');
      const budgets = await getBudgets({});
      return budgets.groups.flatMap((group) => group.categories || [])
        .filter((category) => !/(util|electric|subscription|software|hosting)/i.test(category.name))
        .map((category) => toCents(category.remaining || 0));
    })())
  );
  assert.equal(budgetCents, expectedRemaining);
});

test('repeated getForecast calls produce identical budget totals', async () => {
  await bootstrap(fixtures.complete.fixture);
  const first = await getForecast({ days: 60 });
  const second = await getForecast({ days: 60 });
  const budgetSum = (forecast) => sumCents(
    forecast.events.filter((event) => event.kind === 'budget').map((event) => toCents(Math.abs(event.amount)))
  );
  assert.equal(budgetSum(first), budgetSum(second));
  assert.deepEqual(
    first.events.filter((event) => event.kind === 'budget').map((event) => [event.date, event.amount]),
    second.events.filter((event) => event.kind === 'budget').map((event) => [event.date, event.amount]),
  );
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
  const { allocateCentsOverDays } = require('../lib/domain/cent-allocation');
  // US spring-forward week: finance dates stay YMD; March 2026 has 31 calendar days.
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
