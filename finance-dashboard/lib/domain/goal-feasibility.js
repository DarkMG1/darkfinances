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
  if (account.role === 'excluded') {
    return { status: 'excluded', role: account.role, missing: false, closed: false, excluded: true };
  }
  if (account.hidden) {
    return { status: 'hidden', role: account.role || null, missing: false, closed: false, excluded: false };
  }
  return {
    status: 'linked',
    role: account.role || null,
    missing: false,
    closed: false,
    excluded: false,
  };
}

function accountAllocationSummary({
  goals,
  accountId,
  balanceCents,
  role = null,
  accountStatus = 'linked',
  balanceUnavailable = false,
}) {
  const linked = (goals || []).filter((goal) => goal.accountId === accountId);
  const allocatedCents = sumCents(linked.map((goal) => toCents(goal.current ?? 0)));
  if (balanceUnavailable || !Number.isSafeInteger(balanceCents)) {
    return {
      accountId,
      role,
      accountStatus,
      balanceUnavailable: true,
      capacityCents: null,
      allocatedCents,
      unallocatedCents: null,
      overAllocatedCents: null,
      goalIds: linked.map((goal) => goal.id),
    };
  }
  const capacityCents = Math.max(0, balanceCents);
  return {
    accountId,
    role,
    accountStatus,
    balanceUnavailable: false,
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
  const overAllocatedCents = linked && accountSummary && !accountSummary.balanceUnavailable
    ? accountSummary.overAllocatedCents
    : 0;
  const status = accountStatus?.status ?? (linked ? 'linked' : 'manual');
  let feasible = null;
  if (!linked) {
    feasible = null;
  } else if (accountSummary?.balanceUnavailable) {
    feasible = null;
  } else if (accountStatus?.missing || accountStatus?.closed || status === 'excluded') {
    feasible = false;
  } else {
    feasible = overAllocatedCents === 0;
  }
  return {
    remainingCents,
    monthlyRequiredCents,
    deadlineOverdue: pressure.overdue,
    accountStatus: status,
    accountRole: accountStatus?.role ?? accountSummary?.role ?? null,
    overAllocated: linked && !accountSummary?.balanceUnavailable && overAllocatedCents > 0,
    overAllocatedCents: linked && !accountSummary?.balanceUnavailable ? overAllocatedCents : 0,
    feasible,
    advisoryOnly: true,
  };
}

function buildAccountSummaries({ goals, accountsById, balanceCentsById }) {
  const accountIds = [...new Set((goals || []).map((goal) => goal.accountId).filter(Boolean))];
  return accountIds.map((accountId) => {
    const account = accountsById.get(accountId) || null;
    const status = accountStatusForGoal(account, { accountId });
    const rawBalance = balanceCentsById.get(accountId);
    const balanceUnavailable = balanceCentsById.has(accountId) && !Number.isSafeInteger(rawBalance);
    if (status.missing || status.closed) {
      return accountAllocationSummary({
        goals,
        accountId,
        balanceCents: 0,
        role: status.role,
        accountStatus: status.status,
        balanceUnavailable: false,
      });
    }
    return accountAllocationSummary({
      goals,
      accountId,
      balanceCents: Number.isSafeInteger(rawBalance) ? rawBalance : null,
      role: status.role,
      accountStatus: status.status,
      balanceUnavailable,
    });
  });
}

function buildGoalAdvisory({ goals, accountSummaries, incompleteReasons = [] }) {
  const totalRemainingCents = sumCents((goals || []).map((goal) => {
    if (Number.isSafeInteger(goal.feasibility?.remainingCents)) return goal.feasibility.remainingCents;
    return goalRemainingCents(goal);
  }));
  const monthlyPressureCents = sumCents(
    (goals || [])
      .map((goal) => goal.feasibility?.monthlyRequiredCents ?? null)
      .filter((value) => Number.isSafeInteger(value)),
  );
  const overAllocatedAccounts = (accountSummaries || []).filter(
    (summary) => !summary.balanceUnavailable && summary.overAllocatedCents > 0,
  );
  const normalizedReasons = [...new Set(
    (incompleteReasons || []).filter((reason) => typeof reason === 'string' && reason.length > 0),
  )];
  return {
    complete: normalizedReasons.length === 0,
    advisoryOnly: true,
    incompleteReasons: normalizedReasons,
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
  balanceIncompleteReasons = [],
}) {
  const accountsById = new Map((accounts || []).map((account) => [account.id, account]));
  const accountSummaries = buildAccountSummaries({ goals, accountsById, balanceCentsById });
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
      capacity: summary.capacityCents == null ? null : fromCents(summary.capacityCents),
      allocated: fromCents(summary.allocatedCents),
      unallocated: summary.unallocatedCents == null ? null : fromCents(summary.unallocatedCents),
      overAllocated: summary.overAllocatedCents == null ? null : fromCents(summary.overAllocatedCents),
    })),
    goalAdvisory: buildGoalAdvisory({
      goals: enrichedGoals,
      accountSummaries,
      incompleteReasons: balanceIncompleteReasons,
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
