'use strict';

let rows = [];
let payees = [];
let sequence = 0;
let createPayeeCalls = 0;
let syncError = null;

function configure({ transactions, payeeRows = [] }) {
  rows = structuredClone(transactions || []);
  payees = structuredClone(payeeRows);
  sequence = 0;
  createPayeeCalls = 0;
  syncError = null;
}

function inspect() {
  return {
    rows: structuredClone(rows),
    payees: structuredClone(payees),
    createPayeeCalls,
  };
}

async function init() {}
async function downloadBudget() {}
async function sync() {
  if (syncError) throw syncError;
}
async function shutdown() {}

function setSyncError(error) {
  syncError = error;
}

async function getTransactions(accountId, start, end) {
  return rows
    .filter((row) => row.account === accountId && row.date >= start && row.date <= end)
    .map((row) => structuredClone(row));
}

async function deleteTransaction(id) {
  rows = rows.filter((row) => String(row.id) !== String(id));
}

async function addTransactions(accountId, [transaction]) {
  const id = `caller-replacement-${++sequence}`;
  const subtransactions = (transaction.subtransactions || []).map((leg, index) => ({
    ...structuredClone(leg),
    id: `${id}-leg-${index + 1}`,
    parent_id: id,
  }));
  rows.push({
    ...structuredClone(transaction),
    id,
    account: accountId,
    is_parent: subtransactions.length > 0,
    subtransactions,
  });
}

async function updateTransaction(id, fields) {
  const row = rows.find((candidate) => String(candidate.id) === String(id));
  if (row) Object.assign(row, structuredClone(fields));
}

async function getPayees() {
  return structuredClone(payees);
}

async function createPayee({ name }) {
  createPayeeCalls += 1;
  const payee = { id: `payee-${payees.length + 1}`, name };
  payees.push(payee);
  return payee.id;
}

module.exports = {
  addTransactions,
  configure,
  createPayee,
  deleteTransaction,
  downloadBudget,
  getPayees,
  getTransactions,
  init,
  inspect,
  setSyncError,
  shutdown,
  sync,
  updateTransaction,
};
