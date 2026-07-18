import { fmt, html } from '../format.js';
import { applyTextTone } from '../dom.js';
import { state } from '../state.js';

export function renderGoalAdvisory(advisory) {
  const host = document.getElementById('goalAdvisoryNote');
  if (!host) return;
  if (!advisory?.overAllocatedAccountCount) {
    host.innerHTML = '';
    host.hidden = true;
    return;
  }
  host.hidden = false;
  host.innerHTML = `<div aria-label="Goal allocation advisory">${advisory.overAllocatedAccountCount} linked account${advisory.overAllocatedAccountCount === 1 ? '' : 's'} show allocations above current balance. Advisory only — does not reduce Safe to Spend.</div>`;
}

export function renderSafeToSpend(metric, payload = null) {
  const available = metric?.complete === true && Number.isFinite(metric.value);
  const value = document.getElementById('safeToSpendValue');
  const detail = document.getElementById('safeToSpendDetail');
  const reasonsHost = document.getElementById('safeToSpendReasons');
  const reasons = available ? [] : (metric?.incompleteReasons || []);
  value.textContent = available ? fmt(metric.value) : 'Unavailable';
  applyTextTone(value, available && metric.value < 0 ? 'red' : available ? 'default' : 'yellow');
  detail.textContent = available
    ? (metric.provenance?.method || 'Decision inputs complete')
    : 'Required inputs are missing or unresolved; no estimate is shown.';
  if (reasonsHost) {
    reasonsHost.innerHTML = reasons.length
      ? `<ul aria-label="Safe-to-Spend incomplete reasons">${reasons.map((reason) => `<li>${html(reason)}</li>`).join('')}</ul>`
      : '';
    reasonsHost.hidden = reasons.length === 0;
  }
  const reservedHost = document.getElementById('safeToSpendReserved');
  if (reservedHost) {
    const reserved = payload?.data?.obligations?.reserved || payload?.data?.obligationGraph?.reservations || [];
    reservedHost.innerHTML = reserved.length
      ? reserved.slice(0, 4).map((item) => `<div class="stat-sub">${item.label}: ${fmt(Math.abs(item.amountCents) / 100)} on ${item.date}</div>`).join('')
      : '';
  }
}

export async function loadToday() {
  try {
    const response = await fetch('/api/v1/today');
    if (!response.ok) throw new Error('Today unavailable');
    const payload = await response.json();
    const metric = payload?.data?.metrics?.netWorth;
    state.netWorthHasServerMetric = metric != null && typeof metric.complete === 'boolean';
    state.netWorthAuthoritative = metric?.complete === true && metric?.value != null;
    state.netWorth = state.netWorthAuthoritative
      ? metric.value
      : (state.netWorthHasServerMetric ? null : state.netWorth);
    state.netWorthIncompleteReasons = metric?.complete === false ? (metric.incompleteReasons || []) : [];
    renderSafeToSpend(payload?.data?.liquidity?.safeToSpend, payload);
    renderGoalAdvisory(payload?.data?.liquidity?.goalAdvisory);
  } catch (error) {
    renderSafeToSpend(null);
    throw error;
  }
}
