import { monthLabel } from './format.js';
import { financeParts } from './finance-date.js';
import { state } from './state.js';
import { demoCsvUrl } from './demo.js';
import { loadSpending } from './render/charts-pages.js';
import { loadBudgets } from './render/budgets.js';
import { loadInsights } from './render/reimbursement.js';
import { loadTransactions } from './render/transactions.js';

export function buildMonthPicker() {
  const sel = document.getElementById('monthPicker');
  const { year, month } = financeParts();
  let markup = '';
  for (let i = 0; i < 12; i++) {
    const d = new Date(Date.UTC(year, month - 1 - i, 1));
    const key = `${d.getUTCFullYear()}-${String(d.getUTCMonth() + 1).padStart(2, '0')}`;
    const label = i === 0 ? 'This month' : monthLabel(key);
    markup += `<option value="${i === 0 ? '' : key}">${label}</option>`;
  }
  sel.innerHTML = markup;
}

export function applyMonthTags() {
  const label = state.month ? '· ' + monthLabel(state.month) : '';
  ['spendingMonthTag', 'budgetMonthTag', 'insightsMonthTag', 'txnMonthTag'].forEach((id) => {
    const el = document.getElementById(id);
    if (el) el.textContent = label;
  });
}

export function onMonthChange() {
  state.month = document.getElementById('monthPicker').value || null;
  document.getElementById('statsLabel').textContent = state.month ? monthLabel(state.month) : 'This Month';
  applyMonthTags();
  Promise.all([loadSpending(), loadBudgets(), loadInsights(), loadTransactions()]).catch(console.error);
}

export function exportCsv() {
  let url = '/api/report.csv' + (state.month ? `?month=${state.month}` : '');
  window.location.href = demoCsvUrl(url);
}
