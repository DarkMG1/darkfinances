'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const os = require('os');
const path = require('path');

const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'darkfinances-goal-rollover-'));
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
const {
  assembleObligationGraphInputs,
  buildBudgetReservations,
} = require('../lib/obligation-graph-bridge');
const { categoryEnvelopeFields } = require('../lib/domain/budget-envelope');
const {
  buildObligationGraph,
  safeToSpendFromGraph,
  verifyGraphInvariants,
} = require('../lib/domain/obligation-graph');
const { toCents, sumCents } = require('../lib/domain/money');
const { daysInMonth } = require('../lib/date-only');
const { getToday, getGoals, saveGoal, getBudgets, getForecast, resetApi } = require('../dataModule');
const { buildForecastGenericBudgetContext } = require('../lib/domain/cent-allocation');

test.after(() => fs.rmSync(dir, { recursive: true, force: true }));

function writeJson(file, value) {
  fs.writeFileSync(file, `${JSON.stringify(value, null, 2)}\n`);
}

function seedFixture(fixture, { goals = [], budgetSettings = null } = {}) {
  fixtures.configure(fixture);
  writeJson(process.env.ACCOUNT_OVERRIDES_PATH, {
    schemaVersion: 2,
    accounts: Object.fromEntries(fixture.accounts.map((account) => [
      account.id,
      { name: account.name, role: account.role },
    ])),
  });
  writeJson(process.env.BUDGET_SETTINGS_PATH, budgetSettings || fixture.budgetSettings);
  writeJson(process.env.GOALS_PATH, goals);
  writeJson(process.env.RECURRING_OVERRIDES_PATH, {});
  writeJson(process.env.DEBT_PLANNER_PATH, { debts: [] });
  resetApi();
}

test('goals present no longer quarantine Safe-to-Spend', async () => {
  seedFixture(fixtures.complete.fixture, {
    goals: [{ id: 'goal', name: 'Trip', target: 1200, current: 300, accountId: 'acc-check' }],
  });
  const today = await getToday();
  assert.equal(today.liquidity.safeToSpend.complete, true);
  assert.ok(!today.liquidity.safeToSpend.incompleteReasons.includes('goal_commitment_unknown'));
  assert.equal(today.liquidity.goalAdvisory?.complete, true);
});

test('balance decline after save keeps goal readable and re-save succeeds', async () => {
  seedFixture(fixtures.complete.fixture, {
    goals: [{ id: 'g1', name: 'Trip', target: 200, current: 60, accountId: 'acc-check' }],
  });
  const initial = await getGoals();
  assert.equal(initial[0].feasibility.overAllocated, false);

  const dropped = structuredClone(fixtures.complete.fixture);
  dropped.accounts = dropped.accounts.map((account) => (
    account.id === 'acc-check' ? { ...account, balance: 5000 } : account
  ));
  fixtures.configure(dropped);
  resetApi();
  const afterDrop = await getGoals();
  assert.equal(afterDrop[0].feasibility.overAllocated, true);

  const saved = await saveGoal({ id: 'g1', name: 'Trip', target: 200, current: 60, accountId: 'acc-check' });
  assert.equal(saved.ok, true);
  assert.equal(saved.feasibility.overAllocated, true);
});

test('carryover envelope reserve replaces legacy remaining in obligation graph', () => {
  const fields = categoryEnvelopeFields({
    target: 200,
    spent: 50,
    balance: 250,
    rolloverMode: 'carryover',
    rolloverConfigured: true,
  });
  const category = {
    id: 'annual',
    name: 'Annual',
    target: 200,
    spent: 50,
    balance: 250,
    rolloverMode: 'carryover',
    rolloverConfigured: true,
    resolved: fields.resolved,
    reserveCents: fields.reserveCents,
  };
  const { reservations } = buildBudgetReservations({
    budgets: { supported: true, groups: [{ categories: [category] }] },
  });
  assert.equal(reservations[0].remainingCents, toCents(250));
  assert.notEqual(reservations[0].remainingCents, toCents(150));
});

test('unresolved rollover skips graph reservation and quarantines forecast generic budget', async () => {
  seedFixture(fixtures.complete.fixture, {
    goals: [],
    budgetSettings: { defaults: {}, categories: {} },
  });
  const budgets = await getBudgets();
  const unresolved = budgets.groups.flatMap((group) => group.categories).find((c) => c.id === 'groceries');
  assert.equal(unresolved.resolved, false);
  assert.equal(unresolved.reserveCents, null);
  const { reservations } = buildBudgetReservations({ budgets });
  assert.ok(!reservations.some((row) => row.categoryId === 'groceries'));
  const genericCategories = budgets.groups.flatMap((group) => group.categories);
  const context = buildForecastGenericBudgetContext(genericCategories);
  assert.equal(context.complete, false);
  assert.ok(context.incompleteReasons.includes('rollover_treatment_unknown'));
  const today = await getToday();
  assert.equal(today.liquidity.safeToSpend.complete, false);
  assert.ok(today.liquidity.safeToSpend.incompleteReasons.includes('rollover_treatment_unknown'));
  const forecast = await getForecast({ days: 30 });
  assert.ok(forecast.assumptions.genericBudget.incompleteReasons.includes('rollover_treatment_unknown'));
});

test('goal invariance: STS unchanged when goals added to complete fixture', async () => {
  seedFixture(fixtures.complete.fixture, { goals: [] });
  const withoutGoals = await getToday();
  seedFixture(fixtures.complete.fixture, {
    goals: [{ id: 'goal', name: 'Trip', target: 5000, current: 1000, accountId: 'acc-check' }],
  });
  const withGoals = await getToday();
  assert.equal(withGoals.liquidity.safeToSpend.valueCents, withoutGoals.liquidity.safeToSpend.valueCents);
});

test('Jan/Feb month boundary uses reserve cents for current month only', () => {
  const { buildForecastGenericBudgetContext, buildForecastBudgetDailyCents, allocateCentsOverDays } = require('../lib/domain/cent-allocation');
  const { addDays } = require('../lib/date-only');
  const categories = [{
    target: 310,
    remaining: 310,
    reserve: 310,
    reserveCents: toCents(310),
    resolved: true,
  }];
  const context = buildForecastGenericBudgetContext(categories);
  const entries = buildForecastBudgetDailyCents({
    today: '2026-01-31',
    horizonDays: 3,
    currentMonthRemainingCents: context.reserveSum.cents,
    fullMonthTargetCents: context.targetSum.cents,
    addDays,
    daysInMonth,
  });
  assert.ok(entries.some((entry) => entry.date.startsWith('2026-02')));
  const febEntries = entries.filter((entry) => entry.date.startsWith('2026-02'));
  const febTotal = febEntries.reduce((sum, entry) => sum + entry.centsCents, 0);
  const febAlloc = allocateCentsOverDays(toCents(310), daysInMonth('2026-02'));
  const expectedFeb = sumCents(febAlloc.allocationsCents.slice(0, febEntries.length));
  assert.equal(febTotal, expectedFeb);
  assert.ok(febTotal < toCents(310));
});

test('leap-year Feb boundary allocates full-month target, not January reserve', () => {
  const { buildForecastBudgetDailyCents, allocateCentsOverDays } = require('../lib/domain/cent-allocation');
  const { addDays } = require('../lib/date-only');
  const janReserve = toCents(29);
  const febTarget = toCents(29);
  const entries = buildForecastBudgetDailyCents({
    today: '2024-01-31',
    horizonDays: 5,
    currentMonthRemainingCents: janReserve,
    fullMonthTargetCents: febTarget,
    addDays,
    daysInMonth,
  });
  const jan = entries.filter((entry) => entry.date.startsWith('2024-01'));
  const feb = entries.filter((entry) => entry.date.startsWith('2024-02'));
  assert.equal(sumCents(jan.map((entry) => entry.centsCents)), janReserve);
  const febAlloc = allocateCentsOverDays(febTarget, daysInMonth('2024-02'));
  assert.deepEqual(feb.map((entry) => entry.centsCents), febAlloc.allocationsCents.slice(0, feb.length));
  assert.notEqual(sumCents(feb.map((entry) => entry.centsCents)), janReserve);
});

test('concurrent same-account goals stay advisory without blocking save', async () => {
  const reduced = structuredClone(fixtures.complete.fixture);
  reduced.accounts = reduced.accounts.map((account) => (
    account.id === 'acc-check' ? { ...account, balance: 10000 } : account
  ));
  seedFixture(reduced, {
    goals: [
      { id: 'g1', name: 'A', target: 100, current: 60, accountId: 'acc-check' },
      { id: 'g2', name: 'B', target: 100, current: 60, accountId: 'acc-check' },
    ],
  });
  const goals = await getGoals();
  assert.ok(goals.some((goal) => goal.feasibility.overAllocated));
  const today = await getToday();
  assert.ok(today.liquidity.goalAdvisory.overAllocatedAccountCount > 0);
  const saved = await saveGoal({ id: 'g1', name: 'A', target: 100, current: 60, accountId: 'acc-check' });
  assert.equal(saved.ok, true);
  assert.equal(saved.feasibility.overAllocated, true);
});

test('graph conservation with carryover envelope reservations', () => {
  const financeDate = '2026-07-18';
  const inputs = assembleObligationGraphInputs({
    financeDate,
    windowStart: financeDate,
    windowEnd: '2026-07-31',
    accounts: [
      { id: 'acc-check', name: 'Checking', role: 'operating_cash', balance: 5000, closed: false, hidden: false },
    ],
    recurring: { items: [], hiddenItems: [] },
    income: { streams: [] },
    bills: { bills: [] },
    budgets: {
      supported: true,
      groups: [{
        categories: [{
          id: 'groceries',
          name: 'Groceries',
          target: 200,
          spent: 50,
          balance: 250,
          rolloverMode: 'carryover',
          rolloverConfigured: true,
          resolved: true,
          reserveCents: toCents(250),
        }],
      }],
    },
    debts: [],
    reimb: {},
    operatingAccountIds: ['acc-check'],
    transfers: [],
    economicTransactions: [],
  });
  const graph = buildObligationGraph(inputs);
  const check = verifyGraphInvariants(graph);
  assert.equal(check.ok, true, check.issues.join('; '));
  const stf = safeToSpendFromGraph(graph, {
    operatingCashCents: toCents(5000),
    monthStart: financeDate,
    monthEnd: '2026-07-31',
  });
  assert.equal(stf.valueCents, toCents(4750));
});

test('legacy goals list shape remains a plain array for old clients', async () => {
  seedFixture(fixtures.complete.fixture, {
    goals: [{ id: 'goal', name: 'Trip', target: 500, current: 100 }],
  });
  const payload = await getGoals();
  assert.ok(Array.isArray(payload));
  assert.equal(typeof payload.map, 'function');
  assert.equal(payload[0].feasibility.advisoryOnly, true);
});

test('saveGoal preserves omitted current allocation on edit', async () => {
  seedFixture(fixtures.complete.fixture, {
    goals: [{ id: 'g1', name: 'Trip', target: 200, current: 42, accountId: 'acc-check' }],
  });
  const saved = await saveGoal({ id: 'g1', name: 'Trip', target: 200, accountId: 'acc-check' });
  assert.equal(saved.ok, true);
  const goals = await getGoals();
  assert.equal(goals[0].current, 42);
});

test('stale missing linked account edit succeeds and surfaces missing status', async () => {
  seedFixture(fixtures.complete.fixture, {
    goals: [{ id: 'g1', name: 'Trip', target: 200, current: 42, accountId: 'acc-missing' }],
  });
  const saved = await saveGoal({ id: 'g1', name: 'Trip renamed', target: 250, accountId: 'acc-missing' });
  assert.equal(saved.ok, true);
  assert.equal(saved.feasibility.accountStatus, 'missing');
  assert.equal(saved.feasibility.feasible, false);
});
