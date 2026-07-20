import { fmtPos, html } from '../format.js';
import { monthQS } from '../finance-date.js';

export async function loadBudgets() {
  const data = await (await fetch('/api/budgets' + monthQS())).json();
  const card = document.getElementById('budgetCard');
  const meta = document.getElementById('budgetMeta');
  if (!data.supported || !data.groups.length) {
    card.innerHTML = '<div class="empty-state">No budget data for this month</div>';
    if (meta) meta.textContent = '';
    return;
  }
  const hasTargets = data.totalBudgeted > 0;
  if (meta) {
    const totalSpent = data.groups.reduce((s, g) => s + g.spent, 0);
    const overCount = data.groups.reduce((n, g) => n + g.categories.filter((c) => c.over).length, 0);
    meta.innerHTML = (hasTargets ? `${fmtPos(totalSpent)} / ${fmtPos(data.totalBudgeted)}` : fmtPos(totalSpent))
      + (overCount ? ` · <span class="over">${overCount} over</span>` : '');
  }
  let markup = '';
  if (!hasTargets) markup += '<div class="note note-spaced">No monthly targets set in Actual — showing spend by category.</div>';
  for (const g of data.groups) {
    const groupMax = Math.max(...g.categories.map((c) => c.spent), 1);
    markup += `<div class="budget-group">
      <div class="budget-group-head"><span>${html(g.name)}</span><span class="muted">${hasTargets ? fmtPos(g.spent) + ' / ' + fmtPos(g.budgeted) : fmtPos(g.spent)}</span></div>`;
    for (const c of g.categories) {
      const pct = hasTargets && c.budgeted > 0 ? Math.min(100, (c.spent / c.budgeted) * 100) : (c.spent / groupMax * 100);
      const cls = hasTargets && c.over ? 'bar-over' : (hasTargets && pct > 85 ? 'bar-warn' : '');
      const right = hasTargets && c.budgeted > 0 ? `${fmtPos(c.spent)} / ${fmtPos(c.budgeted)}` : fmtPos(c.spent);
      markup += `<div class="budget-row">
        <div class="budget-row-top"><span class="b-name">${html(c.name)}</span><span class="b-amt">${right}${hasTargets && c.over ? ' · over' : ''}</span></div>
        <progress class="bar-progress ${cls}" value="${Math.round(pct)}" max="100" aria-label="${html(c.name)} budget"></progress>
      </div>`;
    }
    markup += '</div>';
  }
  card.innerHTML = markup;
}
