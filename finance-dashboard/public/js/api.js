import { setFinanceTimeZone } from './finance-date.js';

export async function loadFinanceContext() {
  const response = await fetch('/api/v1/ping');
  if (!response.ok) return;
  const payload = await response.json();
  const data = payload && payload.data;
  if (data && typeof data.financeTimeZone === 'string') setFinanceTimeZone(data.financeTimeZone);
}

export async function loadSection(load, targetIds) {
  try {
    await load();
  } catch (error) {
    console.error(error);
    for (const id of targetIds) {
      const target = document.getElementById(id);
      if (target) target.innerHTML = '<div class="empty-state">Could not load this section. Refresh to retry.</div>';
    }
  }
}

export async function refreshData() {
  await fetch('/api/refresh', { method: 'POST' });
  location.reload();
}
