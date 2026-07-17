'use strict';

const { sumCents, toCents } = require('./money');

const ALLOCATION_METHOD = 'quotient_remainder_earliest';

function allocationProvenance(totalCents, dayCount, extra = {}) {
  return {
    method: ALLOCATION_METHOD,
    totalCents,
    dayCount,
    complete: true,
    incompleteReasons: [],
    ...extra,
  };
}

function assertSafeDayCount(dayCount) {
  if (!Number.isInteger(dayCount) || dayCount <= 0) {
    throw new RangeError('day count must be a positive integer');
  }
  if (!Number.isSafeInteger(dayCount)) {
    throw new RangeError('day count is outside the safe integer range');
  }
  if (dayCount > 10_000) {
    throw new RangeError('day count exceeds supported allocation span');
  }
}

function assertSafeTotalCents(totalCents) {
  if (!Number.isSafeInteger(totalCents)) {
    throw new TypeError('total cents must be a safe integer');
  }
}

function allocateCentsOverDays(totalCents, dayCount) {
  assertSafeTotalCents(totalCents);
  assertSafeDayCount(dayCount);

  if (totalCents === 0) {
    return {
      allocationsCents: Array(dayCount).fill(0),
      provenance: allocationProvenance(totalCents, dayCount),
    };
  }

  const sign = totalCents < 0 ? -1 : 1;
  const absTotal = Math.abs(totalCents);
  const base = Math.floor(absTotal / dayCount);
  const extra = absTotal % dayCount;
  const allocationsCents = [];
  for (let i = 0; i < dayCount; i++) {
    allocationsCents.push(sign * (base + (i < extra ? 1 : 0)));
  }

  return {
    allocationsCents,
    provenance: allocationProvenance(totalCents, dayCount),
  };
}

function pastAndRemainingCents(allocationsCents, positionIndex) {
  if (!Array.isArray(allocationsCents) || !allocationsCents.every((value) => Number.isSafeInteger(value))) {
    throw new TypeError('allocations must be safe integer cents');
  }
  if (!Number.isInteger(positionIndex) || positionIndex < 0 || positionIndex > allocationsCents.length) {
    throw new RangeError('position index out of range');
  }
  const pastCents = sumCents(allocationsCents.slice(0, positionIndex));
  const remainingCents = sumCents(allocationsCents.slice(positionIndex));
  return { pastCents, remainingCents, totalCents: sumCents(allocationsCents) };
}

function trySumCategoryFieldCents(categories, field) {
  try {
    return {
      cents: sumCents((categories || []).map((category) => toCents(Number(category[field]) || 0))),
      complete: true,
      incompleteReasons: [],
    };
  } catch {
    return {
      cents: null,
      complete: false,
      incompleteReasons: ['money_input_invalid'],
    };
  }
}

function buildForecastBudgetDailyCents({
  today,
  horizonDays,
  currentMonthRemainingCents,
  fullMonthTargetCents,
  addDays,
  daysInMonth,
}) {
  assertSafeTotalCents(currentMonthRemainingCents);
  assertSafeTotalCents(fullMonthTargetCents);
  if (!Number.isInteger(horizonDays) || horizonDays < 0 || !Number.isSafeInteger(horizonDays)) {
    throw new RangeError('horizon days must be a non-negative safe integer');
  }

  const currentMonth = today.slice(0, 7);
  const dayOfMonth = Number(today.slice(8, 10));
  const currentDaysRemaining = Math.max(1, daysInMonth(currentMonth) - dayOfMonth + 1);
  const currentMonthAlloc = allocateCentsOverDays(currentMonthRemainingCents, currentDaysRemaining);
  const monthAllocs = new Map();
  const entries = [];

  for (let i = 0; i <= horizonDays; i++) {
    const date = addDays(today, i);
    const month = date.slice(0, 7);
    let centsCents;
    let provenance;

    if (month === currentMonth) {
      if (i >= currentDaysRemaining) continue;
      centsCents = currentMonthAlloc.allocationsCents[i];
      provenance = allocationProvenance(currentMonthRemainingCents, currentDaysRemaining, {
        periodKind: 'current_month_remaining',
        financeDate: today,
        date,
        dateIndex: i,
      });
    } else if (month > currentMonth) {
      if (!monthAllocs.has(month)) {
        monthAllocs.set(month, allocateCentsOverDays(fullMonthTargetCents, daysInMonth(month)));
      }
      const monthAlloc = monthAllocs.get(month);
      const dayInMonth = Number(date.slice(8, 10)) - 1;
      centsCents = monthAlloc.allocationsCents[dayInMonth];
      provenance = allocationProvenance(fullMonthTargetCents, daysInMonth(month), {
        periodKind: 'full_month_target',
        financeDate: today,
        date,
        month,
      });
    } else {
      continue;
    }

    if (centsCents !== 0) {
      entries.push({ date, centsCents, provenance });
    }
  }

  return entries;
}

module.exports = {
  ALLOCATION_METHOD,
  allocateCentsOverDays,
  pastAndRemainingCents,
  trySumCategoryFieldCents,
  buildForecastBudgetDailyCents,
};
