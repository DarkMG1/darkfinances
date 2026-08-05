import { fmtPos, html } from '../format.js';
import { accounts, goalsData, setGoalsData } from '../state.js';
import { setHidden } from '../dom.js';
import { mutateFinance } from '../api.js';

export async function loadGoals() {
  const response = await fetch('/api/goals');
  const payload = await response.json();
  setGoalsData(Array.isArray(payload) ? payload : (payload.data ?? payload.goals ?? []));
  const card = document.getElementById('goalsCard');
  if (!goalsData.length) {
    card.innerHTML = '<div class="empty-state">No goals yet — tap “+ Add goal”.</div>';
    return;
  }
  card.innerHTML = goalsData.map((g, i) => {
    const pct = g.pct != null ? Math.max(0, Math.min(100, g.pct)) : 0;
    const warn = g.feasibility?.overAllocated
      ? '<div class="goal-warn">Advisory: linked allocations exceed account balance.</div>'
      : '';
    return `<div class="goal-row" data-goal-index="${i}">
      <div class="goal-head"><span class="goal-name">${html(g.name)}</span><span class="goal-pct">${g.pct != null ? html(g.pct + '%') : ''}</span></div>
      <progress class="bar-progress" value="${pct}" max="100" aria-label="${html(g.name)} progress"></progress>
      <div class="goal-sub">${fmtPos(g.current)} allocated of ${fmtPos(g.target)}</div>
      ${warn}
    </div>`;
  }).join('');
  card.querySelectorAll('[data-goal-index]').forEach((row) => {
    row.addEventListener('click', () => openGoalForm(Number(row.dataset.goalIndex)));
  });
}

export function openGoalForm(index) {
  const g = (typeof index === 'number') ? goalsData[index] : null;
  document.getElementById('goalModalTitle').textContent = g ? 'Edit goal' : 'New goal';
  document.getElementById('goalId').value = g ? g.id : '';
  document.getElementById('goalName').value = g ? g.name : '';
  document.getElementById('goalTarget').value = g ? g.target : '';
  document.getElementById('goalCurrent').value = g ? g.current : '0';
  document.getElementById('goalDeadline').value = g && g.deadline ? g.deadline : '';
  const sel = document.getElementById('goalAccount');
  sel.innerHTML = '<option value="">Manual (no account)</option>' + accounts.map((a) => `<option value="${html(a.id)}">${html(a.name)}</option>`).join('');
  sel.value = (g && g.accountId) ? g.accountId : '';
  setHidden(document.getElementById('goalDeleteBtn'), !g);
  document.getElementById('goalModal').classList.add('open');
}

export function closeGoalForm() {
  document.getElementById('goalModal').classList.remove('open');
}

export async function submitGoal() {
  const id = document.getElementById('goalId').value || undefined;
  const name = document.getElementById('goalName').value.trim();
  const target = parseFloat(document.getElementById('goalTarget').value);
  const current = parseFloat(document.getElementById('goalCurrent').value);
  const deadline = document.getElementById('goalDeadline').value.trim();
  const accountId = document.getElementById('goalAccount').value || null;
  if (!name || !(target > 0) || !(current >= 0)) {
    alert('Enter a name, target > 0, and non-negative allocation.');
    return;
  }
  await mutateFinance('/goals', {
    body: { id, name, target, current, accountId, deadline: deadline || null },
  });
  closeGoalForm();
  await loadGoals();
}

export async function deleteGoal() {
  const id = document.getElementById('goalId').value;
  if (!id || !confirm('Delete this goal?')) return;
  await mutateFinance('/goals/' + encodeURIComponent(id), { method: 'DELETE' });
  closeGoalForm();
  await loadGoals();
}
