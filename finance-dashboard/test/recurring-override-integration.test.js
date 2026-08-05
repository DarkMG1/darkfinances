'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const { mock } = require('node:test');
const fs = require('fs');
const os = require('os');
const path = require('path');

const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'darkfinances-recurring-override-'));
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
  DEBT_PLANNER_PATH: 'debt-planner.json',
})) process.env[env] = path.join(dir, filename);

const fixtures = require(fixturePath);
const { getRecurring, resetApi, setRecurringOverride } = require('../dataModule');
const { parse, schemas } = require('../lib/validation');
const { RequestValidationError } = require('../lib/errors');

test.before(() => {
  mock.timers.enable({ apis: ['Date'], now: new Date('2026-07-15T17:01:00-07:00') });
});

test.after(() => {
  mock.timers.reset();
  fs.rmSync(dir, { recursive: true, force: true });
});

function writeJson(file, value) {
  fs.writeFileSync(file, `${JSON.stringify(value, null, 2)}\n`);
}

function addDays(date, days) {
  const [year, month, day] = date.split('-').map(Number);
  const value = new Date(Date.UTC(year, month - 1, day + days));
  return value.toISOString().slice(0, 10);
}

function withLoanPaymentHistory(fixture) {
  const today = new Intl.DateTimeFormat('en-CA', { timeZone: 'America/Los_Angeles' }).format(new Date());
  const paymentDates = [addDays(today, -65), addDays(today, -35), addDays(today, -5)];
  const loanCategory = { id: 'loan-payment', name: 'Loan Payment' };
  fixture.categoryGroups = fixture.categoryGroups.map((group) => {
    if (group.name !== 'Everyday Spending') return group;
    return {
      ...group,
      categories: [...group.categories, { id: loanCategory.id, name: loanCategory.name }],
    };
  });
  fixture.budgetMonth.categoryGroups = fixture.budgetMonth.categoryGroups.map((group) => {
    if (group.name !== 'Everyday Spending') return group;
    return {
      ...group,
      categories: [
        ...group.categories,
        {
          id: loanCategory.id,
          name: loanCategory.name,
          budgeted: 90000,
          spent: 0,
          balance: 90000,
        },
      ],
    };
  });
  fixture.payees.push({ id: 'loan-payment-payee', name: 'Loan Payment' });
  for (const [index, date] of paymentDates.entries()) {
    fixture.transactions.push({
      id: `loan-payment-${index}`,
      account: 'acc-check',
      date,
      amount: -90000,
      category: loanCategory.id,
      payee: 'loan-payment-payee',
      cleared: true,
    });
  }
  return fixture;
}

const LOAN_PAYMENT_KEY = 'loan payment';

function creditLiabilityOverrides(paymentKey) {
  return {
    'acc-credit': {
      role: 'credit_card',
      creditLiabilityCoverage: 'current_balance',
      paymentRecurringKey: paymentKey,
      fundingAccountId: 'acc-check',
    },
  };
}

async function bootstrap(fixture, overrides = {}, accountOverrides = {}) {
  fixtures.configure(fixture);
  writeJson(process.env.ACCOUNT_OVERRIDES_PATH, {
    schemaVersion: 2,
    accounts: {
      ...Object.fromEntries(fixture.accounts.map((account) => [
        account.id,
        { name: account.name, role: account.role },
      ])),
      ...accountOverrides,
    },
  });
  writeJson(process.env.BUDGET_SETTINGS_PATH, fixture.budgetSettings);
  writeJson(process.env.GOALS_PATH, fixture.goals);
  writeJson(process.env.RECURRING_OVERRIDES_PATH, overrides);
  writeJson(process.env.DEBT_PLANNER_PATH, { debts: [] });
  resetApi();
}

function recurringItem(items, key) {
  return items.find((item) => item.key === key);
}

test('setRecurringOverride categoryId round-trips programmatically with sibling preservation', async () => {
  const fixture = withLoanPaymentHistory(fixtures.buildFixture({ cardBalance: -900 }));
  await bootstrap(fixture, {
    [LOAN_PAYMENT_KEY]: {
      forced: true,
      isBill: true,
      cancellation: { notes: 'keep-me' },
    },
  }, creditLiabilityOverrides(LOAN_PAYMENT_KEY));

  await setRecurringOverride({ key: LOAN_PAYMENT_KEY, categoryId: 'loan-payment' });
  resetApi();

  const overrides = JSON.parse(fs.readFileSync(process.env.RECURRING_OVERRIDES_PATH, 'utf8'));
  assert.equal(overrides[LOAN_PAYMENT_KEY].categoryId, 'loan-payment');
  assert.equal(overrides[LOAN_PAYMENT_KEY].forced, true);
  assert.equal(overrides[LOAN_PAYMENT_KEY].isBill, true);
  assert.equal(overrides[LOAN_PAYMENT_KEY].cancellation.notes, 'keep-me');

  const written = await getRecurring({});
  assert.equal(recurringItem(written.items, LOAN_PAYMENT_KEY).categoryId, 'loan-payment');

  await setRecurringOverride({ key: LOAN_PAYMENT_KEY, categoryId: null });
  resetApi();

  const cleared = JSON.parse(fs.readFileSync(process.env.RECURRING_OVERRIDES_PATH, 'utf8'));
  assert.ok(!('categoryId' in (cleared[LOAN_PAYMENT_KEY] || {})));
  assert.equal(cleared[LOAN_PAYMENT_KEY].forced, true);
  assert.equal(cleared[LOAN_PAYMENT_KEY].isBill, true);
  assert.equal(cleared[LOAN_PAYMENT_KEY].cancellation.notes, 'keep-me');

  const readBack = await getRecurring({});
  const item = recurringItem(readBack.items, LOAN_PAYMENT_KEY);
  assert.equal(item.categoryId, 'loan-payment');
  assert.equal(item.categoryIdentityStatus, 'inferred');
});

test('recurring override validation rejects malformed categoryId payloads', () => {
  assert.throws(
    () => parse(schemas.recurringOverride, { categoryId: '   ' }, 'recurring override'),
    (error) => error instanceof RequestValidationError,
  );
  assert.throws(
    () => parse(schemas.recurringOverride, { categoryId: 42 }, 'recurring override'),
    (error) => error instanceof RequestValidationError,
  );
});
