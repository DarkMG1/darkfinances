'use strict';

const accounts = [
  { id: 'acc-check', name: 'Checking', closed: false, offbudget: false, balance: 100000, role: 'operating_cash' },
  { id: 'acc-save', name: 'Savings', closed: false, offbudget: false, balance: 50000, role: 'protected_savings' },
  { id: 'acc-credit', name: 'Card', closed: false, offbudget: false, balance: -10000, role: 'credit_card' },
  { id: 'acc-hidden', name: 'Hidden', closed: false, offbudget: false, balance: -20000, role: 'credit_card' },
  { id: 'acc-excluded', name: 'External', closed: false, offbudget: false, balance: 900000, role: 'excluded' },
  { id: 'acc-splitwise', name: 'Splitwise', closed: false, offbudget: false, balance: -1500, role: 'operating_cash' },
];

const categoryGroups = [
  { id: 'income', name: 'Income', is_income: true, categories: [{ id: 'salary', name: 'Salary' }] },
  {
    id: 'spend',
    name: 'Everyday Spending',
    categories: [
      { id: 'dining', name: 'Dining' },
      { id: 'transfer', name: 'Transfer' },
      { id: 'reimbursement', name: 'Reimbursement' },
    ],
  },
];

const transactions = [
  { id: 't1', account: 'acc-check', date: '2026-07-10', amount: -5000, category: 'dining', payee: 'cafe', cleared: true, is_parent: false, subtransactions: [] },
  { id: 't2', account: 'acc-hidden', date: '2026-07-11', amount: -8000, category: 'dining', payee: 'hidden', cleared: true, is_parent: false, subtransactions: [] },
  { id: 't3', account: 'acc-splitwise', date: '2026-07-12', amount: -1500, category: 'dining', payee: 'sw', cleared: true, is_parent: false, subtransactions: [] },
];

async function init() {}
async function downloadBudget() {}
async function sync() {}
async function shutdown() {}
async function getAccounts() {
  return accounts.map(({ balance, role, ...account }) => ({ ...account }));
}
async function getAccountBalance(id) {
  const account = accounts.find((entry) => entry.id === id);
  return account ? account.balance : null;
}
async function getCategoryGroups() {
  return structuredClone(categoryGroups);
}
async function getBudgetMonth() {
  return { categoryGroups: structuredClone(categoryGroups) };
}
async function getPayees() {
  return [
    { id: 'cafe', name: 'Cafe' },
    { id: 'hidden', name: 'Hidden Cafe' },
    { id: 'sw', name: 'Splitwise' },
  ];
}
async function getTransactions(accountId, start, end) {
  return transactions
    .filter((transaction) => transaction.account === accountId && transaction.date >= start && transaction.date <= end)
    .map(({ account, ...transaction }) => structuredClone(transaction));
}

module.exports = {
  accounts,
  categoryGroups,
  transactions,
  downloadBudget,
  getAccountBalance,
  getAccounts,
  getBudgetMonth,
  getCategoryGroups,
  getPayees,
  getTransactions,
  init,
  shutdown,
  sync,
};
