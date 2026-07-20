import { fmtPos, html, cadenceLabel, cap } from '../format.js';
import { dueLabel, daysUntil } from '../finance-date.js';

export async function loadRecurring() {
  const data = await (await fetch('/api/recurring')).json();
  document.getElementById('subSummary').textContent = data.count
    ? `${fmtPos(data.monthlyTotal)}/mo · ${data.activeCount} active · ${fmtPos(data.annualTotal)}/yr`
    : '';
  const card = document.getElementById('recurringCard');
  const items = data.items || [];
  if (!items.length) {
    card.innerHTML = '<div class="empty-state">No recurring charges detected</div>';
    return;
  }
  const rowHtml = (it) => {
    const k = String(it.key || '');
    const hike = it.priceChange
      ? `<div class="hike ${it.priceChange.pct > 0 ? 'up' : 'down'}">${it.priceChange.pct > 0 ? '▲' : '▼'} ${Math.abs(it.priceChange.pct)}%</div>` : '';
    const status = it.status === 'active'
      ? (it.nextRenewal ? `estimated ${dueLabel(it.nextRenewal)}` : 'estimated date uncertain')
      : (it.status === 'cancelled' ? 'cancelled' : 'inactive');
    const toggle = it.status === 'cancelled'
      ? `<button class="sub-action" data-sub-key="${html(k)}" data-sub-status="active">reactivate</button>`
      : `<button class="sub-action" data-sub-key="${html(k)}" data-sub-status="cancelled">cancel</button>`;
    return `<div class="sub-row ${it.status !== 'active' ? 'inactive' : ''}">
      <div class="sub-icon">${html((it.payee || '?').slice(0, 1).toUpperCase())}</div>
      <div class="sub-main"><div class="sub-payee">${html(it.payee)}</div><div class="sub-sub">${html(cadenceLabel(it.cadence))} · ${html(it.category)} · ${html(status)}</div></div>
      <div class="sub-right"><div class="sub-amt">${fmtPos(it.amount)}</div>${hike}</div>
      <div class="sub-actions">${toggle}<button class="sub-action" data-sub-key="${html(k)}" data-sub-hidden="true">hide</button></div>
    </div>`;
  };
  const active = items.filter((i) => i.status === 'active');
  const inactive = items.filter((i) => i.status !== 'active');
  let markup = '';
  if (active.length) markup += `<div class="sub-group-label">Active · ${fmtPos(data.monthlyTotal)}/mo</div>` + active.map(rowHtml).join('');
  if (inactive.length) markup += '<div class="sub-group-label">Inactive &amp; Cancelled</div>' + inactive.map(rowHtml).join('');
  card.innerHTML = markup;
  card.querySelectorAll('[data-sub-key]').forEach((button) => {
    button.addEventListener('click', () => {
      const body = button.dataset.subHidden === 'true'
        ? { hidden: true }
        : { status: button.dataset.subStatus };
      subOverride(button.dataset.subKey, body);
    });
  });
}

async function subOverride(key, body) {
  await fetch(`/api/recurring/${encodeURIComponent(key)}/override`, {
    method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body),
  });
  await Promise.all([loadRecurring(), loadBills()]);
}

export async function loadBills() {
  const data = await (await fetch('/api/bills')).json();
  document.getElementById('billsTitle').textContent = data.count
    ? `Upcoming Bills · ${fmtPos(data.total)} / ${data.horizonDays}d` : 'Upcoming Bills';
  const card = document.getElementById('billsCard');
  const bills = data.bills || [];
  if (!bills.length) {
    card.innerHTML = '<div class="empty-state">No upcoming bills</div>';
    return;
  }
  const buckets = [{ t: 'This week', items: [] }, { t: 'Next week', items: [] }, { t: 'Later', items: [] }];
  bills.forEach((b) => {
    const d = daysUntil(b.dueDate);
    (d <= 7 ? buckets[0] : d <= 14 ? buckets[1] : buckets[2]).items.push(b);
  });
  card.innerHTML = buckets.filter((x) => x.items.length).map((x) =>
    `<div class="bill-bucket">${html(x.t)}</div>` + x.items.map((b) => `
      <div class="bill-row"><div class="bill-due">${html(`est. ${dueLabel(b.dueDate)}`)}</div>
        <div class="bill-main"><div class="bill-payee">${html(cap(b.payee))}</div><div class="bill-cat">${html(b.category)} · ${html(cadenceLabel(b.cadence))}</div></div>
        <div class="bill-amt">${fmtPos(b.amount)}</div></div>`).join(''),
  ).join('');
}
