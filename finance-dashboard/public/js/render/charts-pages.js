import { CATEGORY_COLORS, categoryColorClass } from '../constants.js';
import { fmt, fmtPos, fmtK, html, monthLabel } from '../format.js';
import { monthQS } from '../finance-date.js';
import { destroyChart, setChart, state } from '../state.js';
import { requireChart } from '../chart-runtime.js';
import { renderNetWorthChange } from './accounts.js';
import { setCategoryFilter } from '../filters.js';
import { applyTextTone } from '../dom.js';

export async function loadSpending() {
  const data = await (await fetch('/api/spending' + monthQS())).json();
  const { current, prev } = data;
  const complete = data.completeness?.complete === true;
  const comparisonComplete = data.comparisonCompleteness?.complete === true;
  document.getElementById('statSpent').textContent = complete && current.totalSpend != null ? fmtPos(current.totalSpend) : 'Unavailable';
  document.getElementById('statIncome').textContent = complete && current.totalIncome != null ? fmtPos(current.totalIncome) : 'Unavailable';
  const net = complete && current.totalIncome != null && current.totalSpend != null ? current.totalIncome - current.totalSpend : null;
  const netEl = document.getElementById('statNet');
  netEl.textContent = net != null ? fmt(net) : 'Unavailable';
  applyTextTone(netEl, net != null && net >= 0 ? 'green' : net != null ? 'red' : 'muted');

  const dEl = document.getElementById('statSpentDelta');
  if (complete && comparisonComplete && prev.totalSpend > 0 && current.totalSpend != null) {
    const delta = current.totalSpend - prev.totalSpend;
    const pct = Math.abs((delta / prev.totalSpend) * 100).toFixed(0);
    dEl.textContent = (delta > 0 ? '▲' : '▼') + ' ' + pct + '% vs prev month';
    dEl.className = 'stat-delta ' + (delta > 0 ? 'delta-down' : 'delta-up');
  } else dEl.textContent = '';

  document.getElementById('chartCenterAmt').textContent = complete && current.totalSpend != null ? fmtPos(current.totalSpend) : 'Unavailable';
  const entries = Object.entries(current.spending).sort((a, b) => b[1] - a[1]);
  const top = entries.slice(0, 10);
  const labels = top.map((e) => e[0]);
  const values = top.map((e) => e[1]);
  const colors = labels.map((_, i) => CATEGORY_COLORS[i % CATEGORY_COLORS.length]);

  destroyChart('spending');
  const Chart = requireChart();
  const ctx = document.getElementById('spendingChart').getContext('2d');
  setChart('spending', new Chart(ctx, {
    type: 'doughnut',
    data: { labels, datasets: [{ data: values, backgroundColor: colors, borderWidth: 0, hoverOffset: 4 }] },
    options: {
      cutout: '72%',
      onClick: (e, els) => { if (els.length) setCategoryFilter(labels[els[0].index]); },
      plugins: { legend: { display: false }, tooltip: { callbacks: { label: (c) => ` ${c.label}: ${fmtPos(c.raw)}` } } },
      animation: { duration: 500 },
    },
  }));

  const max = values[0] || 1;
  const categoryList = document.getElementById('categoryList');
  categoryList.innerHTML = entries.slice(0, 8).map(([cat, amt], i) => {
    const colorClass = categoryColorClass(i);
    const pct = Math.round((amt / max) * 100);
    return `
    <div class="category-row" data-category="${html(cat)}">
      <div class="cat-dot ${colorClass}"></div>
      <div class="cat-name">${html(cat)}</div>
      <progress class="cat-progress ${colorClass}" value="${pct}" max="100" aria-label="${html(cat)} share"></progress>
      <div class="cat-amount">${fmtPos(amt)}</div>
    </div>`;
  }).join('') || '<div class="empty-state">No spending this month</div>';
  categoryList.querySelectorAll('[data-category]').forEach((row) => {
    row.addEventListener('click', () => setCategoryFilter(row.dataset.category));
  });
}

export async function loadTrends() {
  const months = document.getElementById('trendRange').value;
  const data = await (await fetch('/api/trends?months=' + months)).json();
  const labels = data.months.map((m) => monthLabel(m.month));
  const nwComplete = data.scope?.netWorthHistoryComplete !== false;
  const nw = data.months.map((m) => (m.netWorth == null ? null : m.netWorth));
  const monthTrendComplete = (m) => m.completeness?.complete !== false && m.complete !== false;
  const inc = data.months.map((m) => monthTrendComplete(m) && m.income != null ? m.income : null);
  const spd = data.months.map((m) => monthTrendComplete(m) && m.spend != null ? m.spend : null);
  const net = data.months.map((m) => monthTrendComplete(m) && m.net != null ? m.net : null);

  state.trendFirstNW = nwComplete && nw.length ? nw.find((v) => v != null) ?? null : null;
  state.trendMonths = months;
  renderNetWorthChange();

  const grid = { color: 'rgba(255,255,255,0.05)' };
  const ticks = { color: '#6b6b80', font: { size: 10 } };
  const Chart = requireChart();

  destroyChart('netWorth');
  const netWorthChartEl = document.getElementById('netWorthChart');
  const netWorthChartBox = netWorthChartEl?.closest('.chart-box');
  if (netWorthChartBox) netWorthChartBox.setAttribute('aria-label', 'Net worth trend chart, synced accounts only');
  if (nwComplete && nw.some((v) => v != null)) {
    setChart('netWorth', new Chart(document.getElementById('netWorthChart'), {
      type: 'line',
      data: { labels, datasets: [{ data: nw, borderColor: '#7c6ef7', backgroundColor: 'rgba(124,110,247,0.12)', fill: true, tension: 0.3, pointRadius: 2, borderWidth: 2, spanGaps: false }] },
      options: {
        maintainAspectRatio: false,
        plugins: { legend: { display: false }, tooltip: { callbacks: { label: (c) => (c.raw == null ? ' unavailable' : ' ' + fmt(c.raw)) } } },
        scales: { x: { grid, ticks }, y: { grid, ticks: { ...ticks, callback: (v) => fmtK(v) } } },
      },
    }));
  } else {
    const breakdown = document.getElementById('netWorthBreakdown');
    if (breakdown) breakdown.textContent = 'Net worth history incomplete for this range';
  }

  destroyChart('ive');
  setChart('ive', new Chart(document.getElementById('iveChart'), {
    data: {
      labels,
      datasets: [
        { type: 'bar', label: 'Income', data: inc, backgroundColor: 'rgba(34,197,94,0.7)', borderRadius: 3, order: 3 },
        { type: 'bar', label: 'Spending', data: spd, backgroundColor: 'rgba(239,68,68,0.65)', borderRadius: 3, order: 2 },
        { type: 'line', label: 'Net', data: net, borderColor: '#a898ff', backgroundColor: '#a898ff', borderWidth: 2, tension: 0.3, pointRadius: 2, pointHoverRadius: 4, order: 1 },
      ],
    },
    options: {
      maintainAspectRatio: false,
      plugins: { legend: { labels: { color: '#6b6b80', font: { size: 10 }, boxWidth: 10 } }, tooltip: { callbacks: { label: (c) => ` ${c.dataset.label}: ${fmt(c.raw)}` } } },
      scales: { x: { grid, ticks }, y: { grid, ticks: { ...ticks, callback: (v) => fmtK(v) } } },
    },
  }));
}
