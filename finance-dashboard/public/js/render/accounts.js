import { fmt, fmtPos, html } from '../format.js';
import { state, accounts, setAccounts } from '../state.js';
import { accountBadge, applyTextTone } from '../dom.js';

let accountFilterHandler = null;

export function registerAccountFilterHandler(handler) {
  accountFilterHandler = handler;
}

export function renderNetWorthChange() {
  const ch = document.getElementById('netWorthChange');
  if (!ch || state.accountOnlyNetWorth == null || state.trendFirstNW == null || state.trendMonths == null) return;
  if (state.netWorthHasServerMetric && (state.netWorthIncompleteReasons || []).length) {
    ch.textContent = '';
    return;
  }
  const diff = state.accountOnlyNetWorth - state.trendFirstNW;
  ch.textContent = `${diff >= 0 ? '▲' : '▼'} ${fmt(Math.abs(diff))} over ${state.trendMonths} mo (synced accounts only)`;
  applyTextTone(ch, diff >= 0 ? 'green' : 'red');
}

export async function loadAccounts() {
  let hasServerNetWorthMetric = false;
  try {
    const todayPayload = await (await fetch('/api/v1/today')).json();
    const metric = todayPayload?.data?.metrics?.netWorth;
    hasServerNetWorthMetric = metric != null && typeof metric.complete === 'boolean';
    state.netWorthHasServerMetric = hasServerNetWorthMetric;
    if (hasServerNetWorthMetric) {
      state.netWorthAuthoritative = metric.complete === true && metric.value != null;
      state.netWorthIncompleteReasons = metric.complete === false ? (metric.incompleteReasons || []) : [];
      if (state.netWorthAuthoritative) state.netWorth = metric.value;
    }
  } catch { /* keep local fallback when server metric absent */ }

  const response = await fetch('/api/accounts');
  setAccounts((await response.json()).filter((account) => !account.hidden));
  const hasInclusion = accounts.some((account) => account.inclusion);
  let totalAssets = 0;
  let totalLiabilities = 0;
  const grid = document.getElementById('accountsGrid');
  grid.innerHTML = '';
  for (const account of accounts) {
    if (hasInclusion && !account.inclusion?.netWorth) continue;
    if (account.balance > 0) totalAssets += account.balance;
    else totalLiabilities += account.balance;
    const [type, cls] = accountBadge(account.name);
    const active = state.accountFilter && state.accountFilter.id === account.id;
    const div = document.createElement('div');
    div.className = 'account-card' + (active ? ' active' : '');
    div.innerHTML = `<div class="account-name">${html(account.name)}</div>
      <div class="account-balance ${account.balance < 0 ? 'negative' : ''}">${fmt(account.balance)}</div>
      <span class="account-type-badge ${cls}">${html(type)}</span>`;
    div.addEventListener('click', () => accountFilterHandler?.(account));
    grid.appendChild(div);
  }
  const netWorth = state.netWorthAuthoritative
    ? state.netWorth
    : (state.netWorthHasServerMetric ? null : (totalAssets + totalLiabilities));
  state.netWorth = netWorth;
  state.accountOnlyNetWorth = totalAssets + totalLiabilities;
  const nwEl = document.getElementById('netWorth');
  if (state.netWorthAuthoritative && netWorth != null) {
    nwEl.textContent = fmt(netWorth);
  } else if (state.netWorthHasServerMetric && (state.netWorthIncompleteReasons || []).length) {
    nwEl.textContent = 'Unavailable';
  } else if (netWorth != null) {
    nwEl.textContent = fmt(netWorth);
  } else {
    nwEl.textContent = 'Unavailable';
  }
  applyTextTone(nwEl, netWorth != null && netWorth >= 0 ? 'default' : 'red');
  const aggregatesUnavailable = state.netWorthHasServerMetric && (state.netWorthIncompleteReasons || []).length;
  document.getElementById('netWorthBreakdown').textContent =
    state.netWorthAuthoritative
      ? `${fmtPos(totalAssets)} assets · ${fmtPos(Math.abs(totalLiabilities))} liabilities · server projection`
      : (aggregatesUnavailable
        ? 'Asset/liability breakdown unavailable — server projection incomplete'
        : `${fmtPos(totalAssets)} assets · ${fmtPos(Math.abs(totalLiabilities))} liabilities · local estimate (inclusion-aware)`);
  renderNetWorthChange();
}
