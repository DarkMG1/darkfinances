'use strict';

let state = {
  accounts: [{ id: 'sw-account', name: 'Splitwise', closed: false, offbudget: false }],
  categoryGroups: [{
    id: 'group',
    name: 'Spending',
    is_income: false,
    categories: [{ id: 'sw-category', name: 'Splitwise' }],
  }],
  rows: [],
  events: [],
  shutdownCalls: 0,
  gates: {},
};

function reset(next = {}) {
  state = {
    accounts: structuredClone(next.accounts || state.accounts),
    categoryGroups: structuredClone(next.categoryGroups || state.categoryGroups),
    rows: structuredClone(next.rows || []),
    events: [],
    shutdownCalls: 0,
    gates: next.gates || {},
  };
}

async function waitGate(name) {
  const gate = state.gates[name];
  if (typeof gate === 'function') await gate();
}

async function init() {}
async function downloadBudget() {}

async function shutdown() {
  state.shutdownCalls += 1;
  state.events.push('shutdown');
}

async function sync() {
  state.events.push('sync');
}

async function setBudgetAmount() {
  state.events.push('write:start');
  await waitGate('write');
  state.events.push('write:end');
}

async function createPayee({ name }) {
  return `payee-${name}`;
}

async function addTransactions(accountId, transactions) {
  state.events.push('write:start');
  await waitGate('write');
  state.events.push('write:end');
  return [`txn-${state.rows.length + 1}`];
}

async function getAccounts() {
  state.events.push('getAccounts:start');
  await waitGate('getAccounts');
  state.events.push('getAccounts:end');
  return structuredClone(state.accounts);
}

async function getCategoryGroups() {
  state.events.push('getCategoryGroups:start');
  await waitGate('getCategoryGroups');
  state.events.push('getCategoryGroups:end');
  return structuredClone(state.categoryGroups);
}

async function getTransactions(accountId, start, end) {
  state.events.push('getTransactions:start');
  await waitGate('getTransactions');
  state.events.push('getTransactions:end');
  return state.rows.filter((row) => row.account === accountId && row.date >= start && row.date <= end);
}

function inspect() {
  return {
    events: [...state.events],
    shutdownCalls: state.shutdownCalls,
  };
}

module.exports = {
  addTransactions,
  configure: reset,
  createPayee,
  downloadBudget,
  getAccounts,
  getCategoryGroups,
  getPayees: async () => [],
  getTransactions,
  init,
  inspect,
  reset,
  setBudgetAmount,
  shutdown,
  sync,
  updateTransaction: async () => {},
};
