'use strict';

let state = {
  rows: [],
  accounts: [{ id: 'account', name: 'Account', closed: false, offbudget: false }],
  payees: [{ id: 'payee', name: 'Merchant' }],
  categoryGroups: [{
    id: 'group',
    name: 'Spending',
    is_income: false,
    categories: [
      { id: 'reimb-category', name: 'Reimbursement' },
      { id: 'dining', name: 'Dining' },
    ],
  }],
  counts: { delete: 0, add: 0, update: 0, sync: 0 },
  sequence: 0,
};

function configure(next = {}) {
  state = {
    rows: structuredClone(next.rows || []),
    accounts: structuredClone(next.accounts || [
      { id: 'account', name: 'Account', closed: false, offbudget: false },
    ]),
    payees: structuredClone(next.payees || [{ id: 'payee', name: 'Merchant' }]),
    categoryGroups: structuredClone(next.categoryGroups || [{
      id: 'group',
      name: 'Spending',
      is_income: false,
      categories: [
        { id: 'reimb-category', name: 'Reimbursement' },
        { id: 'dining', name: 'Dining' },
      ],
    }]),
    counts: { delete: 0, add: 0, update: 0, sync: 0 },
    sequence: 0,
  };
}

function inspect() {
  return structuredClone(state);
}

async function init() {}
async function downloadBudget() {}
async function shutdown() {}

async function getTransactions(accountId, start, end) {
  return state.rows
    .filter((row) => row.account === accountId && row.date >= start && row.date <= end)
    .map((row) => structuredClone(row));
}

async function deleteTransaction(id) {
  state.counts.delete += 1;
  state.rows = state.rows.filter((row) => String(row.id) !== String(id));
}

async function addTransactions(accountId, transactions) {
  state.counts.add += transactions.length;
  for (const transaction of transactions) {
    const id = `added-${++state.sequence}`;
    state.rows.push({
      ...structuredClone(transaction),
      id,
      account: accountId,
      is_parent: Boolean(transaction.subtransactions?.length),
      subtransactions: (transaction.subtransactions || []).map((leg, index) => ({
        ...structuredClone(leg),
        id: `${id}-leg-${index + 1}`,
        parent_id: id,
      })),
    });
  }
}

async function updateTransaction(id, fields) {
  state.counts.update += 1;
  const row = state.rows.find((candidate) => String(candidate.id) === String(id));
  if (row) Object.assign(row, structuredClone(fields));
}

async function sync() {
  state.counts.sync += 1;
}

async function getAccounts() {
  return structuredClone(state.accounts);
}

async function getPayees() {
  return structuredClone(state.payees);
}

async function getCategoryGroups() {
  return structuredClone(state.categoryGroups);
}

async function getCategories() {
  return state.categoryGroups.flatMap((group) => group.categories || []);
}

module.exports = {
  addTransactions,
  configure,
  deleteTransaction,
  downloadBudget,
  getAccounts,
  getCategories,
  getCategoryGroups,
  getPayees,
  getTransactions,
  init,
  inspect,
  shutdown,
  sync,
  updateTransaction,
};
