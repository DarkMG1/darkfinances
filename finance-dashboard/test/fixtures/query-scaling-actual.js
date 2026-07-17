'use strict';

const state = {
  accounts: [],
  rowsByAccount: new Map(),
  callLog: [],
};

function mulberry32(seed) {
  let a = seed | 0;
  return () => {
    a |= 0;
    a = (a + 0x6D2B79F5) | 0;
    let t = Math.imul(a ^ (a >>> 15), 1 | a);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

function reset({ accountCount = 2, rowsPerAccount = 100, anchorMonth = '2024-06', seed = 42 } = {}) {
  state.callLog.length = 0;
  state.accounts = [];
  state.rowsByAccount = new Map();
  const rand = mulberry32(seed);
  const [year, month] = anchorMonth.split('-').map(Number);
  for (let a = 0; a < accountCount; a++) {
    const id = `acct-${a + 1}`;
    state.accounts.push({
      id,
      name: `Account ${a + 1}`,
      closed: false,
      offbudget: false,
      hidden: false,
    });
    const rows = [];
    for (let i = 0; i < rowsPerAccount; i++) {
      const day = 1 + Math.floor(rand() * 28);
      const date = `${year}-${String(month).padStart(2, '0')}-${String(day).padStart(2, '0')}`;
      const amount = rand() > 0.8 ? Math.round(rand() * 50000) : -Math.round(rand() * 25000);
      rows.push({
        id: `${id}-tx-${i}`,
        date,
        amount,
        payee: `Merchant ${Math.floor(rand() * 20)}`,
        notes: `#tag-${i % 5}`,
        cleared: true,
        category: amount < 0 ? 'cat-spend' : 'cat-income',
        is_parent: false,
      });
    }
    state.rowsByAccount.set(id, rows);
  }
}

async function init() {
  return undefined;
}

async function downloadBudget() {
  return undefined;
}

async function shutdown() {
  return undefined;
}

async function getAccounts() {
  return state.accounts.map((account) => ({ ...account }));
}

async function getCategoryGroups() {
  return [{
    id: 'grp-income',
    name: 'Income',
    is_income: true,
    categories: [{ id: 'cat-income', name: 'Salary' }],
  }, {
    id: 'grp-spend',
    name: 'Regular',
    is_income: false,
    categories: [{ id: 'cat-spend', name: 'Groceries' }],
  }];
}

async function getPayees() {
  return [{ id: 'pay-1', name: 'Merchant 1' }];
}

async function getTransactions(accountId, start, end) {
  state.callLog.push({ accountId, start, end });
  const rows = state.rowsByAccount.get(String(accountId)) || [];
  return rows
    .filter((row) => row.date >= start && row.date <= end)
    .map((row) => structuredClone(row));
}

module.exports = {
  init,
  downloadBudget,
  shutdown,
  getAccounts,
  getCategoryGroups,
  getPayees,
  getTransactions,
  reset,
  state,
};
