'use strict';

let rows = [];
let payees = [];
let accounts = [];
let sequence = 0;
let createPayeeCalls = 0;
let syncError = null;

function canonicalizeSplitLegPayees() {
  for (const row of rows) {
    if (!row.is_parent || !Array.isArray(row.subtransactions)) continue;
    for (const leg of row.subtransactions) {
      if (leg.payee == null || leg.payee === '') leg.payee = row.payee;
    }
  }
}

function configure({ transactions, payeeRows = [], accountRows = null }) {
  rows = structuredClone(transactions || []);
  payees = structuredClone(payeeRows);
  accounts = accountRows
    ? structuredClone(accountRows)
    : [...new Set(rows.map((row) => String(row.account || 'account')))]
      .map((id) => ({ id, name: id, closed: false, offbudget: false }));
  if (!accounts.length) {
    accounts = [{ id: 'account', name: 'account', closed: false, offbudget: false }];
  }
  sequence = 0;
  createPayeeCalls = 0;
  syncError = null;
}

function inspect() {
  return {
    rows: structuredClone(rows),
    payees: structuredClone(payees),
    accounts: structuredClone(accounts),
    createPayeeCalls,
  };
}

async function init() {}
async function downloadBudget() {}
async function sync() {
  if (syncError) throw syncError;
  canonicalizeSplitLegPayees();
}
async function shutdown() {}
async function getAccounts() {
  return structuredClone(accounts);
}

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
  if (!row) return;
  const patch = structuredClone(fields);
  if (Array.isArray(patch.subtransactions) && row.is_parent) {
    patch.subtransactions = patch.subtransactions.map((leg, index) => ({
      ...structuredClone(leg),
      id: row.subtransactions?.[index]?.id || `${id}-leg-${index + 1}`,
      parent_id: id,
    }));
    Object.assign(row, patch);
    delete row.category;
    if (patch.imported_id === '') row.imported_id = null;
    canonicalizeSplitLegPayees();
    return;
  }
  Object.assign(row, patch);
  if (patch.imported_id === '') row.imported_id = null;
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
  getAccounts,
  getPayees,
  getTransactions,
  init,
  inspect,
  setSyncError,
  shutdown,
  sync,
  updateTransaction,
};
