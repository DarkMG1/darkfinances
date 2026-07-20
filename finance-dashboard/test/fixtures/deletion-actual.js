'use strict';

let state = {
  rows: [],
  accounts: [{ id: 'account', name: 'Account', closed: false, offbudget: false }],
  payees: [{ id: 'payee', name: 'Merchant' }],
  categoryGroups: [{
    id: 'group',
    name: 'Spending',
    is_income: false,
    categories: [{ id: 'category', name: 'Dining' }],
  }],
  counts: { delete: 0, add: 0, update: 0, sync: 0, createAccount: 0, createCategory: 0 },
  sequence: 0,
  faults: {},
};

function configure(next = {}) {
  const preserveCounts = Boolean(next.preserveCounts);
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
      categories: [{ id: 'category', name: 'Dining' }],
    }]),
    counts: preserveCounts
      ? { ...state.counts }
      : { delete: 0, add: 0, update: 0, sync: 0, createAccount: 0, createCategory: 0 },
    sequence: preserveCounts ? state.sequence : 0,
    faults: structuredClone(next.faults || {}),
  };
}

function setFault(name, handler) {
  state.faults[name] = handler;
}

function clearFaults() {
  state.faults = {};
}

async function invoke(name, fallback) {
  const handler = state.faults[name];
  if (typeof handler === 'function') return handler();
  return fallback();
}

function inspect() {
  return structuredClone({
    rows: state.rows,
    accounts: state.accounts,
    payees: state.payees,
    categoryGroups: state.categoryGroups,
    counts: state.counts,
    sequence: state.sequence,
  });
}

async function init() {}
async function downloadBudget() {}
async function shutdown() {}

async function getTransactions(accountId, start, end) {
  return invoke('getTransactions', () => state.rows
    .filter((row) => row.account === accountId && row.date >= start && row.date <= end)
    .map((row) => structuredClone(row)));
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
  return invoke('getAccounts', () => structuredClone(state.accounts));
}

async function getPayees() {
  return structuredClone(state.payees);
}

async function getCategoryGroups() {
  return invoke('getCategoryGroups', () => structuredClone(state.categoryGroups));
}

async function createAccount({ name, offbudget }) {
  state.counts.createAccount += 1;
  const id = `account-${state.accounts.length + 1}`;
  state.accounts.push({ id, name, offbudget: Boolean(offbudget), closed: false });
  return id;
}

async function createCategory({ name, group_id: groupId }) {
  state.counts.createCategory += 1;
  const group = state.categoryGroups.find((candidate) => candidate.id === groupId);
  const id = `category-${group?.categories?.length || 0}`;
  if (group) group.categories.push({ id, name });
  return id;
}

module.exports = {
  addTransactions,
  clearFaults,
  configure,
  createAccount,
  createCategory,
  deleteTransaction,
  downloadBudget,
  getAccounts,
  getCategoryGroups,
  getPayees,
  getTransactions,
  init,
  inspect,
  setFault,
  shutdown,
  sync,
  updateTransaction,
};
