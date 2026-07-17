'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const os = require('os');
const path = require('path');

const {
  SAFE_TO_SPEND_REASON,
  safeToSpendIncompleteReasons,
} = require('../lib/safe-to-spend');

const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'darkfinances-recurrence-obligation-'));
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
const { getToday, getBills, getRecurring, resetApi } = require('../dataModule');

test.after(() => fs.rmSync(dir, { recursive: true, force: true }));

function writeJson(file, value) {
  fs.writeFileSync(file, `${JSON.stringify(value, null, 2)}\n`);
}

async function bootstrap(fixture, { recurringOverrides = {} } = {}) {
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
  writeJson(process.env.RECURRING_OVERRIDES_PATH, recurringOverrides);
  resetApi();
}

test('uncertain active bill adds bill_recurrence_unresolved', () => {
  const reasons = safeToSpendIncompleteReasons({
    recurring: {
      items: [{ status: 'active', isBill: true, projectionUncertain: true }],
    },
  });
  assert.ok(reasons.includes(SAFE_TO_SPEND_REASON.billRecurrenceUnresolved));
});

test('uncertain active non-bill does not add bill_recurrence_unresolved', () => {
  const reasons = safeToSpendIncompleteReasons({
    recurring: {
      items: [{ status: 'active', isBill: false, projectionUncertain: true }],
    },
  });
  assert.ok(!reasons.includes(SAFE_TO_SPEND_REASON.billRecurrenceUnresolved));
  assert.ok(reasons.includes(SAFE_TO_SPEND_REASON.nonBillRecurrenceUnresolved));
});

test('getBills omits uncertain active rent without inventing due dates', async () => {
  const fixture = fixtures.buildUncertainRentFixture();
  await bootstrap(fixture, {
    'skyline apartments': { forced: true, isBill: true },
  });
  const recurring = await getRecurring({});
  const rent = recurring.items.find((item) => /skyline/i.test(item.payee));
  assert.ok(rent, 'expected rent recurring item');
  assert.equal(rent.status, 'active');
  assert.equal(rent.isBill, true);
  assert.equal(rent.projectionUncertain, true);
  assert.equal(rent.nextRenewal, null);

  const bills = await getBills({ days: 90, recurring });
  assert.equal(bills.bills.some((bill) => bill.key === rent.key), false);
});

test('getToday quarantines Safe-to-Spend when active rent projection is uncertain', async () => {
  const fixture = fixtures.buildUncertainRentFixture();
  await bootstrap(fixture, {
    'skyline apartments': { forced: true, isBill: true },
  });
  const today = await getToday();
  const metric = today.liquidity.safeToSpend;
  assert.equal(metric.complete, false);
  assert.equal(metric.value, null);
  assert.equal(metric.valueCents, null);
  assert.ok(metric.incompleteReasons.includes(SAFE_TO_SPEND_REASON.billRecurrenceUnresolved));
});

test('web dueLabel helper treats null as date uncertain', () => {
  const browser = fs.readFileSync(path.resolve(__dirname, '..', 'public', 'index.html'), 'utf8');
  assert.match(browser, /if \(!d\) return 'date uncertain'/);
  assert.match(browser, /if \(!d\) return null/);
  assert.doesNotMatch(browser, /const dueLabel = \(d\) => \{ const n = daysUntil\(d\)/);
});
