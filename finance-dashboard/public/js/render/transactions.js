import { fmt, html, formatDate } from '../format.js';
import { monthBounds } from '../finance-date.js';
import {
  state, allTxns, categories, setAllTxns, setCategories,
} from '../state.js';
import { setCategoryFilter } from '../filters.js';
import { loadSpending } from './charts-pages.js';
import { loadInsights } from './reimbursement.js';
import { loadBudgets } from './budgets.js';
import { setHidden } from '../dom.js';
import { mutateFinance } from '../api.js';

export async function loadTransactions() {
  const { start, end } = monthBounds();
  const response = await fetch(`/api/transactions?start=${start}&end=${end}`);
  setAllTxns(await response.json());
  state.txnPage = 50;
  renderTxns();
}

export async function loadCategories() {
  const response = await fetch('/api/categories');
  setCategories(await response.json());
}

export function filterTxns() {
  state.txnPage = 50;
  renderTxns();
}

export function setFilter(filter, button) {
  state.txnFilter = filter;
  document.querySelectorAll('.filter-btn').forEach((b) => b.classList.remove('active'));
  button.classList.add('active');
  state.txnPage = 50;
  renderTxns();
}

export function loadMore() {
  state.txnPage += 50;
  renderTxns();
}

function filteredTxns() {
  const search = document.getElementById('searchInput').value.toLowerCase();
  return allTxns.filter((t) => {
    if (state.txnFilter === 'expense' && t.amount >= 0) return false;
    if (state.txnFilter === 'income' && t.amount <= 0) return false;
    if (state.accountFilter && t.accountId !== state.accountFilter.id) return false;
    if (state.categoryFilter && (t.category || 'Uncategorized') !== state.categoryFilter) return false;
    if (search && !t.payee.toLowerCase().includes(search) && !(t.category || '').toLowerCase().includes(search) && !t.account.toLowerCase().includes(search)) return false;
    return true;
  });
}

export function renderTxns() {
  const filtered = filteredTxns();
  const shown = filtered.slice(0, state.txnPage);
  const body = document.getElementById('txnBody');
  if (shown.length === 0) {
    body.innerHTML = '<tr><td colspan="5"><div class="empty-state">No transactions found</div></td></tr>';
    setHidden(document.getElementById('loadMoreBtn'), true);
    return;
  }

  body.innerHTML = shown.map((t, i) => {
    const isIncome = t.amount > 0;
    let catCell;
    if (t.category) catCell = `<span class="txn-cat-badge" data-category="${html(t.category)}">${html(t.category)}</span>`;
    else if (!t.isLeg) catCell = `<span class="categorize-link" data-categorize-index="${i}">+ categorize</span>`;
    else catCell = '<span class="txn-split">— split</span>';
    return `<tr data-idx="${i}">
      <td class="txn-date">${html(formatDate(t.date))}</td>
      <td><div class="txn-payee">${html(t.payee || '—')}</div>${t.notes ? `<div class="txn-notes">${html(t.notes)}</div>` : ''}</td>
      <td class="txn-account">${html(t.account)}</td>
      <td class="cat-cell">${catCell}</td>
      <td class="txn-amount ${isIncome ? 'income' : ''}">${isIncome ? '+' : ''}${fmt(t.amount)}</td>
    </tr>`;
  }).join('');
  body.querySelectorAll('[data-category]').forEach((badge) => {
    badge.addEventListener('click', () => setCategoryFilter(badge.dataset.category));
  });
  body.querySelectorAll('[data-categorize-index]').forEach((link) => {
    link.addEventListener('click', () => startCategorize(Number(link.dataset.categorizeIndex)));
  });
  setHidden(document.getElementById('loadMoreBtn'), filtered.length <= state.txnPage);
}

function startCategorize(idx) {
  const t = filteredTxns()[idx];
  const cell = document.querySelector(`tr[data-idx="${idx}"] .cat-cell`);
  if (!cell || !t) return;
  const opts = categories.map((c) => `<option value="${html(c.id)}">${html(c.group)} · ${html(c.name)}</option>`).join('');
  cell.innerHTML = `<select class="cat-select"><option value="">Select…</option>${opts}</select>`;
  const select = cell.querySelector('select');
  select.addEventListener('change', () => commitCategorize(t.id, select.value, select));
  select.focus();
}

async function commitCategorize(id, categoryId, sel) {
  if (!categoryId) return;
  sel.disabled = true;
  try {
    const res = await mutateFinance(`/transactions/${encodeURIComponent(id)}/category`, {
      body: { categoryId, isLeg: false },
    });
    if (!res.ok) throw new Error((await res.json()).error || 'failed');
    await Promise.all([loadTransactions(), loadSpending(), loadInsights(), loadBudgets()]);
  } catch (e) {
    alert('Categorize failed: ' + e.message);
    sel.disabled = false;
  }
}
