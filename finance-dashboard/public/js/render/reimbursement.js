import { fmtPos, fmtDay, html, formatDate } from '../format.js';
import { financeToday, monthQS } from '../finance-date.js';
import { renderMetricPos } from '../metrics.js';

export async function loadReimbursement() {
  const data = await (await fetch('/api/reimbursement')).json();
  document.getElementById('oweTotal').textContent = renderMetricPos(data.totalOwed);
  const owers = data.owes || [];
  const oweList = document.getElementById('oweList');
  if (!owers.length) oweList.innerHTML = '<div class="empty-state">All settled up 🎉</div>';
  else {
    oweList.innerHTML = owers.map((p) => {
      const parts = [];
      if (p.misc > 0) parts.push(`${fmtPos(p.misc)} misc`);
      (p.trips || []).forEach((t) => parts.push(`${fmtPos(t.remaining)} ${html(t.event)}`));
      const sub = parts.join(' · ') || `${(p.legs || []).length} item${(p.legs || []).length === 1 ? '' : 's'}`;
      return `
        <div class="owe-row">
          <div><div class="owe-name">${html(p.slug)}</div><div class="owe-sub">${sub}</div></div>
          <div class="owe-amt owed">${fmtPos(p.owed)}</div>
        </div>`;
    }).join('');
  }

  const evList = document.getElementById('eventList');
  const events = data.events.filter((e) => e.n > 0);
  if (!events.length) {
    evList.innerHTML = '<div class="empty-state">No tagged events</div>';
    return;
  }

  const [fy, fm, fd] = financeToday().split('-').map(Number);
  const cutoffDate = new Date(Date.UTC(fy, fm - 2, fd));
  const cutoffYMD = `${cutoffDate.getUTCFullYear()}-${String(cutoffDate.getUTCMonth() + 1).padStart(2, '0')}-${String(cutoffDate.getUTCDate()).padStart(2, '0')}`;
  const isOld = (e) => e.status !== 'open' && e.settledDate && e.settledDate < cutoffYMD;

  const row = (e) => {
    const open = e.status === 'open';
    const pill = open
      ? '<span class="status-pill pill-open">open</span>'
      : `<span class="status-pill pill-paid">${html(e.status.replace(/_/g, ' '))}</span>`;
    const right = open
      ? `${fmtPos(Math.abs(e.net))} ${pill}`
      : `${e.settledDate ? `<span class="e-settled">settled ${fmtDay(e.settledDate)}</span>` : ''}${pill}`;
    return `<div class="event-row${isOld(e) ? ' event-old' : ''}"><span class="e-name">${html(e.event)}</span><span>${right}</span></div>`;
  };

  const oldCount = events.filter(isOld).length;
  let markup = events.map(row).join('');
  if (oldCount) markup += `<button class="reveal-btn" id="revealTrips" type="button">Show ${oldCount} older trip${oldCount === 1 ? '' : 's'}</button>`;
  evList.classList.remove('show-old');
  evList.innerHTML = markup;

  const btn = document.getElementById('revealTrips');
  if (btn) {
    btn.addEventListener('click', () => {
      const shown = evList.classList.toggle('show-old');
      btn.textContent = shown ? 'Hide older trips' : `Show ${oldCount} older trip${oldCount === 1 ? '' : 's'}`;
    });
  }
}

export async function loadInsights() {
  const data = await (await fetch('/api/insights' + monthQS())).json();
  document.getElementById('largestList').innerHTML = data.largestCharges.length ? data.largestCharges.map((c) => `
    <div class="insight-item"><div class="insight-main"><div class="insight-name">${html(c.payee)}</div><div class="insight-sub">${html(formatDate(c.date))} · ${html(c.category)}</div></div>
    <div class="insight-amt">${fmtPos(Math.abs(c.amount))}</div></div>`).join('') : '<div class="empty-state">None</div>';

  const uncatEl = document.getElementById('uncatList');
  uncatEl.innerHTML = data.uncategorized.length ? data.uncategorized.map((u) => `
    <div class="insight-item"><div class="insight-main"><div class="insight-name">${html(u.payee)}</div><div class="insight-sub">${html(formatDate(u.date))}</div></div>
    <div class="insight-amt">${fmtPos(Math.abs(u.amount))}</div></div>`).join('') : '<div class="empty-state">All categorized ✓</div>';

  const anomEl = document.getElementById('anomalyList');
  anomEl.innerHTML = data.anomalies.length ? data.anomalies.map((a) => `
    <div class="insight-item"><div class="insight-main"><div class="insight-name">${html(a.category)}</div><div class="insight-sub">avg ${fmtPos(a.avg)}/mo</div></div>
    <div class="insight-amt">${fmtPos(a.current)} <span class="anomaly-up">${a.deltaPct != null ? '+' + a.deltaPct + '%' : ''}</span></div></div>`).join('') : '<div class="empty-state">Nothing unusual ✓</div>';

  const im = document.getElementById('insightsMeta');
  if (im) {
    const reviewCount = data.uncategorized.length + data.anomalies.length;
    im.innerHTML = reviewCount ? `<span class="over">${reviewCount} to review</span>` : 'all clear';
  }
}
