import { html } from './format.js';
import { state } from './state.js';
import { loadAccounts } from './render/accounts.js';

let afterFilterChange = () => {};

export function registerAfterFilterChange(handler) {
  afterFilterChange = handler;
}

export function toggleAccountFilter(account) {
  state.accountFilter = (state.accountFilter && state.accountFilter.id === account.id)
    ? null
    : { id: account.id, name: account.name };
  loadAccounts();
  renderActiveFilters();
  state.txnPage = 50;
  afterFilterChange();
  document.querySelector('.txn-table')?.scrollIntoView({ behavior: 'smooth', block: 'start' });
}

export function setCategoryFilter(cat) {
  state.categoryFilter = state.categoryFilter === cat ? null : cat;
  renderActiveFilters();
  state.txnPage = 50;
  afterFilterChange();
  document.querySelector('.txn-table')?.scrollIntoView({ behavior: 'smooth', block: 'start' });
}

export function clearFilter(kind) {
  if (kind === 'account') {
    state.accountFilter = null;
    loadAccounts();
  }
  if (kind === 'category') state.categoryFilter = null;
  renderActiveFilters();
  state.txnPage = 50;
  afterFilterChange();
}

export function renderActiveFilters() {
  const el = document.getElementById('activeFilters');
  let markup = '';
  if (state.accountFilter) {
    markup += `<span class="chip">${html(state.accountFilter.name)}<button type="button" data-clear-filter="account">×</button></span>`;
  }
  if (state.categoryFilter) {
    markup += `<span class="chip">${html(state.categoryFilter)}<button type="button" data-clear-filter="category">×</button></span>`;
  }
  el.innerHTML = markup;
  el.querySelectorAll('[data-clear-filter]').forEach((button) => {
    button.addEventListener('click', () => clearFilter(button.dataset.clearFilter));
  });
}
