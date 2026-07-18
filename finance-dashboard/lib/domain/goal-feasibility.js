'use strict';

const { fromCents, sumCents, toCents } = require('./money');

function goalRemainingCents(goal) {
  return Math.max(0, toCents(goal.target) - toCents(goal.current ?? 0));
}

function deadlinePressure(financeDate, deadline) {
  if (!deadline || !/^\d{4}-\d{2}$/.test(deadline)) {
    return { months: null, overdue: false, monthlyRequiredCents: null };
  }
  const nowMonth = financeDate.slice(0, 7);
  const [nowYear, nowMonthNum] = nowMonth.split('-').map(Number);
  const [endYear, endMonth] = deadline.split('-').map(Number);
  const monthsRaw = (endYear - nowYear) * 12 + endMonth - nowMonthNum + 1;
  const overdue = monthsRaw < 1;
  const months = Math.max(1, monthsRaw);
  return { months, overdue, monthlyRequiredCents: null };
}

function ceilDiv(numerator, denominator) {
  if (!Number.isSafeInteger(numerator) || !Number.isSafeInteger(denominator) || denominator <= 0) {
    throw new RangeError('ceilDiv requires safe integer numerator and positive denominator');
  }
  return Math.ceil(numerator / denominator);
}

function accountStatusForGoal(account, { accountId }) {
  if (!accountId) return { status: 'manual', role: null, missing: false, closed: false, excluded: false };
  if (!account) return { status: 'missing', role: null, missing: true, closed: false, excluded: false };
  if (account.closed) return { status: 'closed', role: account.role || null, missing: false, closed: true, excluded: false };
  if (account.hidden) return { status: 'hidden', role: account.role || null, missing: false, closed: false, excluded: true };
  if (account.role === 'excluded') {
    return { status: 'excluded', role: account.role, missing: false, closed: false, excluded: true };
  }
  return {
    status: 'linked',
    role: account.role || null,
    missing: false,
    closed: false,
    excluded: false,
  };
}

function accountAllocationSummary({ goals, accountId, balanceCents, role = null, accountStatus = 'linked' }) {
  const linked = (goals || []).filter((goal) => goal.accountId === accountId);
  const allocatedCents = sumCents(linked.map((goal) => toCents(goal.current ?? 0)));
  const capacityCents = Math.max(0, balanceCents);
  return {
    accountId,
    role,
    accountStatus,
    capacityCents,
    allocatedCents,
    unallocatedCents: Math.max(0, capacityCents - allocatedCents),
    overAllocatedCents: Math.max(0, allocatedCents - capacityCents),
    goalIds: linked.map((goal) => goal.id),
  };
}

function enrichGoalFeasibility(goal, {
  financeDate,
  accountSummary = null,
  accountStatus = null,
}) {
  const remainingCents = goalRemainingCents(goal);
  const pressure = deadlinePressure(financeDate, goal.deadline);
  const monthlyRequiredCents = pressure.months != null
    ? ceilDiv(remainingCents, pressure.months)
    : null;
  const linked = Boolean(goal.accountId);
  const overAllocatedCents = linked && accountSummary ? accountSummary.overAllocatedCents : 0;
  return {
    remainingCents,
    monthlyRequiredCents,
    deadlineOverdue: pressure.overdue,
    accountStatus: accountStatus?.status ?? (linked ? 'linked' : 'manual'),
    accountRole: accountStatus?.role ?? accountSummary?.role ?? null,
    overAllocated: linked && overAllocatedCents > 0,
    overAllocatedCents: linked ? overAllocatedCents : 0,
    feasible: linked
      ? (accountStatus?.missing || accountStatus?.closed ? null : overAllocatedCents === 0)
      : null,
    advisoryOnly: true,
  };
}

function buildAccountSummaries({ goals, accountsById, balanceCentsById, financeDate }) {
  const accountIds = [...new Set((goals || []).map((goal) => goal.accountId).filter(Boolean))];
  return accountIds.map((accountId) => {
    const account = accountsById.get(accountId) || null;
    const status = accountStatusForGoal(account, { accountId });
    const balanceCents = balanceCentsById.get(accountId) ?? 0;
    return accountAllocationSummary({
      goals,
      accountId,
      balanceCents: status.missing || status.closed ? 0 : balanceCents,
      role: status.role,
      accountStatus: status.status,
    });
  });
}

function buildGoalAdvisory({ goals, accountSummaries }) {
  const totalRemainingCents = sumCents((goals || []).map((goal) => {
    if (Number.isSafeInteger(goal.feasibility?.remainingCents)) return goal.feasibility.remainingCents;
    return goalRemainingCents(goal);
  }));
  const monthlyPressureCents = sumCents(
    (goals || [])
      .map((goal) => goal.feasibility?.monthlyRequiredCents ?? null)
      .filter((value) => Number.isSafeInteger(value)),
  );
  const overAllocatedAccounts = (accountSummaries || []).filter((summary) => summary.overAllocatedCents > 0);
  return {
    complete: true,
    advisoryOnly: true,
    totalRemainingCents,
    monthlyPressureCents: monthlyPressureCents || 0,
    overAllocatedAccounts,
    overAllocatedAccountCount: overAllocatedAccounts.length,
  };
}

function enrichGoalsResponse({
  goals,
  accounts = [],
  balanceCentsById = new Map(),
  financeDate,
}) {
  const accountsById = new Map((accounts || []).map((account) => [account.id, account]));
  const accountSummaries = buildAccountSummaries({ goals, accountsById, balanceCentsById, financeDate });
  const summaryByAccount = new Map(accountSummaries.map((summary) => [summary.accountId, summary]));
  const enrichedGoals = (goals || []).map((goal) => {
    const account = goal.accountId ? accountsById.get(goal.accountId) : null;
    const status = accountStatusForGoal(account, { accountId: goal.accountId });
    const feasibility = enrichGoalFeasibility(goal, {
      financeDate,
      accountSummary: goal.accountId ? summaryByAccount.get(goal.accountId) || null : null,
      accountStatus: status,
    });
    const monthlyRequired = feasibility.monthlyRequiredCents != null
      ? fromCents(feasibility.monthlyRequiredCents)
      : null;
    return {
      ...goal,
      monthlyRequired,
      feasibility: {
        ...feasibility,
        remaining: fromCents(feasibility.remainingCents),
        monthlyRequired,
      },
    };
  });
  return {
    goals: enrichedGoals,
    accountSummaries: accountSummaries.map((summary) => ({
      ...summary,
      capacity: fromCents(summary.capacityCents),
      allocated: fromCents(summary.allocatedCents),
      unallocated: fromCents(summary.unallocatedCents),
      overAllocated: fromCents(summary.overAllocatedCents),
    })),
    goalAdvisory: buildGoalAdvisory({
      goals: enrichedGoals,
      accountSummaries,
    }),
  };
}

module.exports = {
  goalRemainingCents,
  deadlinePressure,
  accountStatusForGoal,
  accountAllocationSummary,
  enrichGoalFeasibility,
  buildAccountSummaries,
  buildGoalAdvisory,
  enrichGoalsResponse,
};
