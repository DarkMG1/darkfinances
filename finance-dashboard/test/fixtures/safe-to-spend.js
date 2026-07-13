'use strict';

const REASON = Object.freeze({
  creditCardCoverageUnknown: 'credit_card_coverage_unknown',
  budgetTargetsMissing: 'budget_targets_missing',
  budgetTargetCoveragePartial: 'budget_target_coverage_partial',
  targetlessCategorySpending: 'targetless_category_spending',
  nonBillRecurrenceUnresolved: 'non_bill_recurrence_unresolved',
  goalCommitmentUnknown: 'goal_commitment_unknown',
  rolloverTreatmentUnknown: 'rollover_treatment_unknown',
});

function financeToday() {
  const parts = Object.fromEntries(new Intl.DateTimeFormat('en-US', {
    timeZone: 'America/Los_Angeles',
    year: 'numeric',
    month: '2-digit',
    day: '2-digit',
  }).formatToParts(new Date()).filter((part) => part.type !== 'literal').map((part) => [part.type, part.value]));
  return `${parts.year}-${parts.month}-${parts.day}`;
}

function addDays(date, days) {
  const [year, month, day] = date.split('-').map(Number);
  const value = new Date(Date.UTC(year, month - 1, day + days));
  return value.toISOString().slice(0, 10);
}

function category(id, name, target, spent) {
  return {
    id,
    name,
    budgeted: Math.round(target * 100),
    spent: -Math.round(spent * 100),
    balance: Math.round((target - spent) * 100),
  };
}

function buildFixture({
  cardBalance = 0,
  targets = { groceries: 100, dining: 200 },
  spending = {},
  recurring = false,
  goals = [],
  rolloverExplicit = true,
} = {}) {
  const today = financeToday();
  const categories = [
    category('groceries', 'Groceries', targets.groceries || 0, spending.groceries || 0),
    category('dining', 'Dining', targets.dining || 0, spending.dining || 0),
    category('software', 'Software', targets.software || 0, spending.software || 0),
    category('reimbursement', 'Reimbursement', 0, 0),
  ];
  const transactions = [];
  if (spending.dining) {
    transactions.push({
      id: 'targetless-spend',
      account: 'cash',
      date: addDays(today, -2),
      amount: -Math.round(spending.dining * 100),
      category: 'dining',
      payee: 'dining-payee',
      cleared: true,
    });
  }
  if (recurring) {
    for (const [index, days] of [65, 35, 5].entries()) {
      transactions.push({
        id: `subscription-${index}`,
        account: 'cash',
        date: addDays(today, -days),
        amount: -1500,
        category: 'software',
        payee: 'software-payee',
        cleared: true,
      });
    }
  }

  return {
    accounts: [
      { id: 'cash', name: 'Checking', closed: false, offbudget: false, balance: 500000, role: 'operating_cash' },
      { id: 'card', name: 'Credit Card', closed: false, offbudget: false, balance: Math.round(cardBalance * 100), role: 'credit_card' },
    ],
    categoryGroups: [
      { id: 'income-group', name: 'Income', is_income: true, categories: [{ id: 'salary', name: 'Salary' }] },
      {
        id: 'spending-group',
        name: 'Everyday Spending',
        is_income: false,
        categories: categories.map(({ id, name }) => ({ id, name })),
      },
    ],
    budgetMonth: {
      categoryGroups: [
        { id: 'income-group', name: 'Income', is_income: true, categories: [] },
        { id: 'spending-group', name: 'Everyday Spending', is_income: false, categories },
      ],
    },
    payees: [
      { id: 'dining-payee', name: 'Cafe' },
      { id: 'software-payee', name: 'Software Service' },
    ],
    transactions,
    budgetSettings: rolloverExplicit ? { defaults: { rolloverMode: 'none' }, categories: {} } : {},
    goals,
  };
}

const scenarios = [
  {
    name: 'negative credit-card liability without explicit coverage policy',
    fixture: buildFixture({ cardBalance: -900 }),
    reasons: [REASON.creditCardCoverageUnknown],
  },
  {
    name: 'no positive budget targets',
    fixture: buildFixture({ targets: {} }),
    reasons: [REASON.budgetTargetsMissing],
  },
  {
    name: 'partial target coverage',
    fixture: buildFixture({ targets: { groceries: 100 } }),
    reasons: [REASON.budgetTargetCoveragePartial],
  },
  {
    name: 'spending in a targetless category',
    fixture: buildFixture({ targets: { groceries: 100 }, spending: { dining: 50 } }),
    reasons: [REASON.budgetTargetCoveragePartial, REASON.targetlessCategorySpending],
  },
  {
    name: 'active non-bill recurrence',
    fixture: buildFixture({ recurring: true }),
    reasons: [REASON.nonBillRecurrenceUnresolved],
  },
  {
    name: 'unknown goal commitment',
    fixture: buildFixture({ goals: [{ id: 'goal', name: 'Future purchase', target: 1200, current: 300 }] }),
    reasons: [REASON.goalCommitmentUnknown],
  },
  {
    name: 'unknown rollover treatment',
    fixture: buildFixture({ rolloverExplicit: false }),
    reasons: [REASON.rolloverTreatmentUnknown],
  },
  {
    name: 'multiple unresolved inputs have stable ordered reasons',
    fixture: buildFixture({
      cardBalance: -900,
      targets: {},
      spending: { dining: 50 },
      recurring: true,
      goals: [{ id: 'goal', name: 'Future purchase', target: 1200, current: 300 }],
      rolloverExplicit: false,
    }),
    reasons: [
      REASON.creditCardCoverageUnknown,
      REASON.budgetTargetsMissing,
      REASON.targetlessCategorySpending,
      REASON.nonBillRecurrenceUnresolved,
      REASON.goalCommitmentUnknown,
      REASON.rolloverTreatmentUnknown,
    ],
  },
];

const complete = {
  name: 'complete inputs remain available',
  fixture: buildFixture(),
};

let current = structuredClone(complete.fixture);

function configure(fixture) {
  current = structuredClone(fixture);
}

async function init() {}
async function downloadBudget() {}
async function sync() {}
async function shutdown() {}
async function getAccounts() {
  return current.accounts.map(({ balance, role, ...account }) => ({ ...account }));
}
async function getAccountBalance(id) {
  return current.accounts.find((account) => account.id === id)?.balance || 0;
}
async function getCategoryGroups() {
  return structuredClone(current.categoryGroups);
}
async function getBudgetMonth() {
  return structuredClone(current.budgetMonth);
}
async function getPayees() {
  return structuredClone(current.payees);
}
async function getTransactions(accountId, start, end) {
  return current.transactions
    .filter((transaction) => transaction.account === accountId && (!start || transaction.date >= start) && (!end || transaction.date <= end))
    .map(({ account, ...transaction }) => structuredClone(transaction));
}

module.exports = {
  REASON,
  complete,
  configure,
  downloadBudget,
  getAccountBalance,
  getAccounts,
  getBudgetMonth,
  getCategoryGroups,
  getPayees,
  getTransactions,
  init,
  scenarios,
  shutdown,
  sync,
};
