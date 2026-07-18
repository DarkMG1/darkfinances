import { installDemoFetch, applyDemoIndicator, toggleDemo, demoOnlyPage } from './demo.js';
import { loadFinanceContext, loadSection, refreshData } from './api.js';
import {
  buildMonthPicker, applyMonthTags, onMonthChange, exportCsv,
} from './router.js';
import {
  registerAccountFilterHandler, loadAccounts,
} from './render/accounts.js';
import { loadToday } from './render/safe-to-spend.js';
import { loadSpending, loadTrends } from './render/charts-pages.js';
import { loadBudgets } from './render/budgets.js';
import { loadReimbursement, loadInsights } from './render/reimbursement.js';
import { loadRecurring, loadBills } from './render/recurring.js';
import {
  loadGoals, openGoalForm, closeGoalForm, submitGoal, deleteGoal,
} from './render/goals.js';
import {
  loadTransactions, loadCategories, filterTxns, setFilter, loadMore, renderTxns,
} from './render/transactions.js';
import {
  registerAfterFilterChange, toggleAccountFilter,
} from './filters.js';

function bindUiEvents() {
  document.getElementById('monthPicker')?.addEventListener('change', onMonthChange);
  document.getElementById('demoToggle')?.addEventListener('click', toggleDemo);
  document.getElementById('refreshBtn')?.addEventListener('click', () => {
    refreshData().catch(console.error);
  });
  document.getElementById('trendRange')?.addEventListener('change', () => {
    loadTrends().catch(console.error);
  });
  document.getElementById('openGoalFormBtn')?.addEventListener('click', () => openGoalForm());
  document.getElementById('goalCancelBtn')?.addEventListener('click', closeGoalForm);
  document.getElementById('goalSaveBtn')?.addEventListener('click', () => {
    submitGoal().catch(console.error);
  });
  document.getElementById('goalDeleteBtn')?.addEventListener('click', () => {
    deleteGoal().catch(console.error);
  });
  document.getElementById('searchInput')?.addEventListener('input', filterTxns);
  document.getElementById('loadMoreBtn')?.addEventListener('click', loadMore);
  document.getElementById('exportCsvBtn')?.addEventListener('click', exportCsv);
  document.querySelectorAll('.filter-btn').forEach((button) => {
    button.addEventListener('click', () => setFilter(button.dataset.filter, button));
  });
}

function showBootstrapError(error) {
  console.error(error);
  const main = document.querySelector('main');
  if (main && !main.querySelector('.empty-state[data-bootstrap-error]')) {
    const banner = document.createElement('div');
    banner.className = 'empty-state';
    banner.dataset.bootstrapError = '1';
    banner.textContent = 'Dashboard failed to start. Refresh to retry.';
    main.prepend(banner);
  }
}

async function init() {
  installDemoFetch();
  registerAccountFilterHandler(toggleAccountFilter);
  registerAfterFilterChange(renderTxns);
  bindUiEvents();

  await loadFinanceContext().catch(console.error);
  buildMonthPicker();
  applyDemoIndicator();
  applyMonthTags();

  await Promise.all([
    loadSection(loadCategories, []),
    loadSection(loadToday, []),
    loadSection(loadAccounts, ['accountsGrid']),
    loadSection(loadSpending, ['categoryList']),
    loadSection(loadTrends, []),
    loadSection(loadBudgets, ['budgetCard']),
    loadSection(loadReimbursement, ['oweList', 'eventList']),
    loadSection(loadInsights, ['largestList', 'uncatList', 'anomalyList']),
    loadSection(loadTransactions, ['txnBody']),
    loadSection(loadRecurring, ['recurringCard']),
    loadSection(loadBills, ['billsCard']),
    loadSection(loadGoals, ['goalsCard']),
  ]);
}

init().catch(showBootstrapError);

export { demoOnlyPage };
