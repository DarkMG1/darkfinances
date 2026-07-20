'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const os = require('os');
const path = require('path');

const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'darkfinances-obligation-graph-integration-'));
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
const { getToday, getForecast, resetApi, setAccountOverride } = require('../dataModule');
const { SAFE_TO_SPEND_REASON } = require('../lib/safe-to-spend');

test.after(() => fs.rmSync(dir, { recursive: true, force: true }));

function writeJson(file, value) {
  fs.writeFileSync(file, `${JSON.stringify(value, null, 2)}\n`);
}

function addDays(date, days) {
  const [year, month, day] = date.split('-').map(Number);
  const value = new Date(Date.UTC(year, month - 1, day + days));
  return value.toISOString().slice(0, 10);
}

function withCreditCardPaymentHistory(fixture) {
  const today = new Intl.DateTimeFormat('en-CA', { timeZone: 'America/Los_Angeles' }).format(new Date());
  const paymentDates = [addDays(today, -65), addDays(today, -35), addDays(today, -5)];
  const loanCategory = { id: 'loan-payment', name: 'Loan Payment' };
  fixture.categoryGroups = fixture.categoryGroups.map((group) => {
    if (group.name !== 'Everyday Spending') return group;
    return { ...group, categories: [...group.categories, { id: loanCategory.id, name: loanCategory.name }] };
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
  fixture.payees.push({ id: 'credit-card-payment', name: 'Credit Card Payment' });
  for (const [index, date] of paymentDates.entries()) {
    fixture.transactions.push({
      id: `credit-card-payment-${index}`,
      account: 'acc-check',
      date,
      amount: -90000,
      category: loanCategory.id,
      payee: 'credit-card-payment',
      cleared: true,
    });
  }
  return fixture;
}

function withLoanPaymentHistory(fixture, { ambiguous = false } = {}) {
  const today = new Intl.DateTimeFormat('en-CA', { timeZone: 'America/Los_Angeles' }).format(new Date());
  const paymentDates = [addDays(today, -65), addDays(today, -35), addDays(today, -5)];
  const loanCategory = { id: 'loan-payment', name: 'Loan Payment' };
  fixture.categoryGroups = fixture.categoryGroups.map((group) => {
    if (group.name !== 'Everyday Spending') return group;
    return {
      ...group,
      categories: [
        ...group.categories,
        { id: loanCategory.id, name: loanCategory.name },
        ...(ambiguous ? [{ id: 'dining', name: 'Dining' }] : []),
      ],
    };
  });
  fixture.budgetMonth.categoryGroups = fixture.budgetMonth.categoryGroups.map((group) => {
    if (group.name !== 'Everyday Spending') return group;
    const extra = ambiguous
      ? [{ id: 'dining', name: 'Dining', budgeted: 20000, spent: 0, balance: 20000 }]
      : [];
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
        ...extra,
      ],
    };
  });
  fixture.payees.push({ id: 'loan-payment-payee', name: 'Loan Payment' });
  for (const [index, date] of paymentDates.entries()) {
    const category = ambiguous && index % 2 === 1 ? 'dining' : loanCategory.id;
    fixture.transactions.push({
      id: `loan-payment-${index}`,
      account: 'acc-check',
      date,
      amount: -90000,
      category,
      payee: 'loan-payment-payee',
      cleared: true,
    });
  }
  return fixture;
}

const CREDIT_CARD_PAYMENT_KEY = 'credit card payment';
const LOAN_PAYMENT_KEY = 'loan payment';

function creditLiabilityOverrides(paymentKey = CREDIT_CARD_PAYMENT_KEY) {
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

test('getToday and getForecast share legacy recurrence reasons and withhold forecast on incomplete graph', async () => {
  const fixture = fixtures.buildUncertainRentFixture();
  await bootstrap(fixture, { 'skyline apartments': { forced: true, isBill: true } });
  const today = await getToday();
  assert.equal(today.liquidity.safeToSpend.complete, false);
  assert.ok(today.liquidity.safeToSpend.incompleteReasons.includes(SAFE_TO_SPEND_REASON.billRecurrenceUnresolved));
  assert.ok(today.liquidity.safeToSpend.incompleteReasons.includes(SAFE_TO_SPEND_REASON.recurrenceUnresolved));
  assert.ok(today.obligationGraph);

  const forecast = await getForecast({ days: 45 });
  assert.equal(forecast.assumptions.obligationGraph.complete, false);
  assert.equal(forecast.assumptions.projectionContainment.graphEventsWithheld, true);
  assert.equal(forecast.assumptions.projectionContainment.complete, false);
  assert.ok(forecast.warnings.some((warning) => warning.includes('withheld')));
  assert.equal(forecast.events.filter((event) => event.kind === 'bill').length, 0);
});

test('explicit current_balance policy produces parity between graph reservations and Safe-to-Spend', async () => {
  const fixture = withCreditCardPaymentHistory(fixtures.buildFixture({ cardBalance: -900 }));
  await bootstrap(fixture, {}, {
    'acc-credit': {
      role: 'credit_card',
      creditLiabilityCoverage: 'current_balance',
      paymentRecurringKey: CREDIT_CARD_PAYMENT_KEY,
      fundingAccountId: 'acc-check',
    },
  });
  writeJson(process.env.RECURRING_OVERRIDES_PATH, {
    [CREDIT_CARD_PAYMENT_KEY]: { forced: true, isBill: true, categoryId: 'loan-payment' },
  });
  const today = await getToday();
  assert.equal(today.liquidity.safeToSpend.incompleteReasons.includes(SAFE_TO_SPEND_REASON.creditCardCoverageUnknown), false);
  assert.equal(today.liquidity.safeToSpend.complete, true);
  const card = today.accounts.find((account) => account.id === 'acc-credit');
  assert.equal(card.creditLiabilityPolicy?.coverageKind, 'current_balance');
  assert.equal(card.creditLiabilityPolicy?.eligible, true);
  assert.ok(card.creditLiabilityPolicy?.obligationCents > 0);
});

test('setAccountOverride credit policy round-trips through persisted overrides', async () => {
  const fixture = fixtures.buildFixture({ cardBalance: -500 });
  await bootstrap(fixture, {}, { 'acc-credit': { role: 'credit_card' } });
  await setAccountOverride({
    id: 'acc-credit',
    creditLiabilityCoverage: 'current_balance',
    paymentRecurringKey: CREDIT_CARD_PAYMENT_KEY,
    fundingAccountId: 'acc-check',
  });
  writeJson(process.env.RECURRING_OVERRIDES_PATH, {
    'credit card payment': { forced: true, isBill: true },
  });
  resetApi();
  const today = await getToday();
  const card = today.accounts.find((account) => account.id === 'acc-credit');
  assert.equal(card.creditLiability?.coverage, 'current_balance');
  assert.equal(card.creditLiabilityPolicy?.eligible, true);
  await setAccountOverride({ id: 'acc-credit', clearCreditLiability: true });
  resetApi();
  const cleared = await getToday();
  const clearedCard = cleared.accounts.find((account) => account.id === 'acc-credit');
  assert.equal(clearedCard.creditLiability, null);
});

test('loan payment bill without resolvable categoryId quarantines STS and skips budget reserve', async () => {
  const fixture = withLoanPaymentHistory(fixtures.buildFixture({ cardBalance: -900 }), { ambiguous: true });
  await bootstrap(fixture, {
    [LOAN_PAYMENT_KEY]: { forced: true, isBill: true },
  }, creditLiabilityOverrides(LOAN_PAYMENT_KEY));
  const today = await getToday();
  assert.equal(today.liquidity.safeToSpend.value, null);
  assert.equal(today.liquidity.safeToSpend.complete, false);
  assert.ok(today.liquidity.safeToSpend.incompleteReasons.includes(SAFE_TO_SPEND_REASON.identityOverlapAmbiguous));
  assert.equal(
    (today.obligationGraph.reservations || []).filter((item) => item.source?.categoryId === 'loan-payment').length,
    0,
  );
});

test('explicit loan payment categoryId reserves card liability once without loan budget reserve', async () => {
  const fixture = withLoanPaymentHistory(fixtures.buildFixture({ cardBalance: -900 }));
  await bootstrap(fixture, {
    [LOAN_PAYMENT_KEY]: { forced: true, isBill: true, categoryId: 'loan-payment' },
  }, creditLiabilityOverrides(LOAN_PAYMENT_KEY));
  const today = await getToday();
  assert.equal(today.liquidity.safeToSpend.incompleteReasons.includes(SAFE_TO_SPEND_REASON.identityOverlapAmbiguous), false);
  assert.equal(today.liquidity.safeToSpend.complete, true);
  const budgetReserve = (today.obligationGraph.reservations || []).filter((item) =>
    item.source?.kind === 'budget' && item.source?.categoryId === 'loan-payment');
  assert.equal(budgetReserve.length, 0);
  const forecast = await getForecast({ days: 45 });
  const liabilityEvents = forecast.events.filter((event) =>
    event.label === 'Credit Card' && Math.abs(Math.round(event.amount * 100)) === 90000);
  assert.equal(liabilityEvents.length, 1);
});

test('default credit-card policy keeps credit_card_coverage_unknown for old clients', async () => {
  const fixture = fixtures.buildFixture({ cardBalance: -900 });
  await bootstrap(fixture);
  const today = await getToday();
  assert.ok(today.liquidity.safeToSpend.incompleteReasons.includes(SAFE_TO_SPEND_REASON.creditCardCoverageUnknown));
  assert.equal(today.liquidity.safeToSpend.value, null);
});
