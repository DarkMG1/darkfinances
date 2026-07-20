'use strict';

const {
  addDays,
  addMonths,
  daysBetween,
  daysInMonth,
  monthEnd,
  monthRange,
  parseYMD,
} = require('./date-only');

// Typical day-length hints for cadence classification and monthly-equivalent math.
// Projection uses calendar rules below, not these fractional values.
const CADENCE_DAYS = {
  weekly: 7,
  biweekly: 14,
  semimonthly: 15.22,
  monthly: 30.44,
  bimonthly: 60.88,
  quarterly: 91.3,
  semiannual: 182.6,
  annual: 365.25,
};

const MONTH_STEPS = {
  monthly: 1,
  bimonthly: 2,
  quarterly: 3,
  semiannual: 6,
  annual: 12,
};

const INACTIVE_GAP_DAYS = {
  weekly: 14,
  biweekly: 28,
  semimonthly: 40,
  monthly: 55,
  bimonthly: 95,
  quarterly: 140,
  semiannual: 280,
  annual: 450,
};

const SEMIMONTHLY_PATTERNS = {
  first_and_fifteenth: 'first_and_fifteenth',
  fifteenth_and_eom: 'fifteenth_and_eom',
};

function addCalendarMonths(date, count, anchorDay) {
  const { year, month } = parseYMD(date);
  const targetFirst = new Date(Date.UTC(year, month - 1 + Number(count), 1));
  const targetYear = targetFirst.getUTCFullYear();
  const targetMonth = targetFirst.getUTCMonth();
  const lastDay = new Date(Date.UTC(targetYear, targetMonth + 1, 0)).getUTCDate();
  const day = anchorDay === 31 ? lastDay : Math.min(anchorDay, lastDay);
  return `${targetYear}-${String(targetMonth + 1).padStart(2, '0')}-${String(day).padStart(2, '0')}`;
}

function dayOfMonth(value) {
  return Number(String(value).slice(8, 10));
}

function monthKeyOf(value) {
  return String(value).slice(0, 7);
}

function isLastDayOfMonth(value) {
  return value === monthEnd(monthKeyOf(value));
}

function classifyCadence(gap) {
  if (gap >= 5 && gap <= 9) return 'weekly';
  if (gap >= 12 && gap <= 14) return 'biweekly';
  if (gap >= 15 && gap <= 18) return 'semimonthly';
  if (gap >= 25 && gap <= 35) return 'monthly';
  if (gap >= 55 && gap <= 70) return 'bimonthly';
  if (gap >= 80 && gap <= 100) return 'quarterly';
  if (gap >= 170 && gap <= 200) return 'semiannual';
  if (gap >= 330 && gap <= 400) return 'annual';
  return null;
}

function monthlyEquivalentAmount(amount, cadence) {
  const period = CADENCE_DAYS[cadence];
  if (!period) return amount;
  return amount * (30.44 / period);
}

function inactiveGapDays(cadence) {
  return INACTIVE_GAP_DAYS[cadence] || Math.round((CADENCE_DAYS[cadence] || 30.44) * 1.8);
}

function nearestSemimonthlyAnchor(date, pattern) {
  const month = monthKeyOf(date);
  const day = dayOfMonth(date);
  const anchors = pattern === SEMIMONTHLY_PATTERNS.first_and_fifteenth
    ? [`${month}-01`, `${month}-15`]
    : [`${month}-15`, monthEnd(month)];
  let best = null;
  let bestDist = Infinity;
  for (const anchor of anchors) {
    const dist = Math.abs(daysBetween(anchor, date));
    if (dist < bestDist) {
      bestDist = dist;
      best = anchor;
    }
  }
  return { anchor: best, distance: bestDist };
}

function scoreSemimonthlyPattern(dates, pattern) {
  let score = 0;
  for (const date of dates) {
    const { distance } = nearestSemimonthlyAnchor(date, pattern);
    if (distance <= 2) score += 1;
    else if (distance <= 4) score += 0.5;
  }
  return score;
}

function inferSemimonthlyPattern(dates) {
  const firstScore = scoreSemimonthlyPattern(dates, SEMIMONTHLY_PATTERNS.first_and_fifteenth);
  const eomScore = scoreSemimonthlyPattern(dates, SEMIMONTHLY_PATTERNS.fifteenth_and_eom);
  const bestScore = Math.max(firstScore, eomScore);
  if (bestScore < Math.max(2, dates.length * 0.6)) {
    return { uncertain: true, reasons: ['semimonthly-history-mismatch'] };
  }
  if (Math.abs(firstScore - eomScore) <= 0.5 && dates.length >= 3) {
    return { uncertain: true, reasons: ['ambiguous-semimonthly-pattern'] };
  }
  return {
    uncertain: false,
    pattern: firstScore > eomScore
      ? SEMIMONTHLY_PATTERNS.first_and_fifteenth
      : SEMIMONTHLY_PATTERNS.fifteenth_and_eom,
  };
}

function dayClusterConsistent(dates, monthDay) {
  if (monthDay === 31) {
    return dates.every((d) => isLastDayOfMonth(d) || dayOfMonth(d) >= 28);
  }
  const days = dates.map(dayOfMonth);
  return Math.max(...days) - Math.min(...days) <= 2;
}

function inferMonthlyDayAnchor(dates, cadence = 'monthly') {
  if (!dates.length) return null;
  if (dates.every((d) => isLastDayOfMonth(d))) return 31;
  const candidates = [...new Set(dates.map(dayOfMonth))].sort((a, b) => b - a);
  for (const candidate of candidates) {
    if (!calendarHistoryMatches(dates, cadence, candidate)) continue;
    if (dates.length >= 3 && !dayClusterConsistent(dates, candidate)) continue;
    return candidate;
  }
  const days = dates.map(dayOfMonth);
  const maxDay = Math.max(...days);
  const minDay = Math.min(...days);
  if (maxDay - minDay <= 2) {
    const average = Math.round(days.reduce((sum, d) => sum + d, 0) / days.length);
    if (calendarHistoryMatches(dates, cadence, average) && dayClusterConsistent(dates, average)) return average;
  }
  return null;
}

function gapsBetween(dates) {
  const gaps = [];
  for (let i = 1; i < dates.length; i++) gaps.push(daysBetween(dates[i - 1], dates[i]));
  return gaps;
}

function gapMatchesCadence(dates, cadence) {
  const gaps = gapsBetween(dates);
  if (!gaps.length) return cadence === 'monthly';
  const expected = cadence === 'weekly' ? 7 : cadence === 'biweekly' ? 14 : null;
  if (expected == null) return true;
  return gaps.every((gap) => Math.abs(gap - expected) <= 1);
}

function calendarHistoryMatches(dates, cadence, monthDay) {
  if (dates.length < 2) return true;
  const steps = MONTH_STEPS[cadence] || 1;
  let cursor = dates[0];
  for (let i = 1; i < dates.length; i++) {
    const expected = addCalendarMonths(cursor, steps, monthDay);
    if (Math.abs(daysBetween(expected, dates[i])) > 4) return false;
    cursor = dates[i];
  }
  return true;
}

function inferRecurrenceSchedule({ dates, cadence, forced = false } = {}) {
  const sorted = [...new Set(dates || [])].sort();
  const anchorDate = sorted[sorted.length - 1] || null;
  const schedule = {
    cadence,
    anchorDate,
    uncertain: false,
    reasons: [],
  };
  if (!cadence || !sorted.length) {
    schedule.uncertain = true;
    schedule.reasons.push('missing-cadence-or-dates');
    return schedule;
  }

  if (cadence === 'weekly' || cadence === 'biweekly') {
    if (!gapMatchesCadence(sorted, cadence)) {
      schedule.uncertain = true;
      schedule.reasons.push('inconsistent-interval-gaps');
    }
    return schedule;
  }

  if (cadence === 'semimonthly') {
    const inferred = inferSemimonthlyPattern(sorted);
    if (inferred.uncertain) {
      schedule.uncertain = true;
      schedule.reasons.push(...(inferred.reasons || ['ambiguous-semimonthly']));
    } else {
      schedule.semimonthlyPattern = inferred.pattern;
    }
    return schedule;
  }

  if (MONTH_STEPS[cadence]) {
    const monthDay = inferMonthlyDayAnchor(sorted, cadence) ?? (forced ? dayOfMonth(anchorDate) : null);
    if (monthDay == null) {
      schedule.uncertain = true;
      schedule.reasons.push('ambiguous-monthly-anchor');
      return schedule;
    }
    schedule.monthDay = monthDay;
    if (!calendarHistoryMatches(sorted, cadence, monthDay)) {
      schedule.uncertain = true;
      schedule.reasons.push('monthly-history-mismatch');
    }
    return schedule;
  }

  schedule.uncertain = true;
  schedule.reasons.push('unsupported-cadence');
  return schedule;
}

function stepBackwardSemimonthly(date, pattern) {
  const day = dayOfMonth(date);
  if (pattern === SEMIMONTHLY_PATTERNS.first_and_fifteenth) {
    if (day > 15) return `${monthKeyOf(date)}-15`;
    if (day === 15) return `${monthKeyOf(date)}-01`;
    return `${addMonths(date, -1).slice(0, 7)}-15`;
  }
  if (isLastDayOfMonth(date)) return `${monthKeyOf(date)}-15`;
  if (day > 15) return `${monthKeyOf(date)}-15`;
  return monthEnd(addMonths(date, -1).slice(0, 7));
}

function stepBackward(date, schedule) {
  if (!date || !schedule || schedule.uncertain) return null;
  const { cadence } = schedule;
  if (cadence === 'weekly') return addDays(date, -7);
  if (cadence === 'biweekly') return addDays(date, -14);
  if (cadence === 'semimonthly') {
    return stepBackwardSemimonthly(date, schedule.semimonthlyPattern || SEMIMONTHLY_PATTERNS.fifteenth_and_eom);
  }
  const steps = MONTH_STEPS[cadence];
  if (steps) {
    const anchorDay = schedule.monthDay ?? dayOfMonth(date);
    return addCalendarMonths(date, -steps, anchorDay);
  }
  return null;
}

function advanceSemimonthly(date, pattern) {
  const day = dayOfMonth(date);
  if (pattern === SEMIMONTHLY_PATTERNS.first_and_fifteenth) {
    if (day < 15) return `${monthKeyOf(date)}-15`;
    return `${addMonths(date, 1).slice(0, 7)}-01`;
  }
  if (day < 15) return `${monthKeyOf(date)}-15`;
  if (day === 15) return monthEnd(monthKeyOf(date));
  return `${addMonths(date, 1).slice(0, 7)}-15`;
}

function advanceOnce(date, schedule) {
  if (!date || !schedule || schedule.uncertain) return null;
  const { cadence } = schedule;
  if (cadence === 'weekly') return addDays(date, 7);
  if (cadence === 'biweekly') return addDays(date, 14);
  if (cadence === 'semimonthly') {
    return advanceSemimonthly(date, schedule.semimonthlyPattern || SEMIMONTHLY_PATTERNS.fifteenth_and_eom);
  }
  const steps = MONTH_STEPS[cadence];
  if (steps) {
    const anchorDay = schedule.monthDay ?? dayOfMonth(date);
    return addCalendarMonths(date, steps, anchorDay);
  }
  return null;
}

function nextOccurrenceAfter(date, schedule) {
  if (!schedule || schedule.uncertain || !schedule.anchorDate) return null;
  if (schedule.anchorDate > date) return schedule.anchorDate;
  let cursor = schedule.anchorDate;
  let guard = 0;
  while (guard < 256) {
    const next = advanceOnce(cursor, schedule);
    if (!next || next === cursor) return null;
    if (next > date) return next;
    cursor = next;
    guard += 1;
  }
  return null;
}

function rollToOnOrAfter(targetDate, schedule) {
  if (!schedule || schedule.uncertain || !schedule.anchorDate) return null;
  let due = schedule.anchorDate;
  let guard = 0;
  while (guard < 256) {
    const prev = stepBackward(due, schedule);
    if (!prev || prev < targetDate) break;
    due = prev;
    guard += 1;
  }
  if (due >= targetDate) return due;
  while (due < targetDate && guard < 256) {
    const next = advanceOnce(due, schedule);
    if (!next || next === due) return null;
    due = next;
    guard += 1;
  }
  return due;
}

function previousOccurrenceBefore(date, schedule) {
  if (!schedule || schedule.uncertain || !schedule.anchorDate) return null;
  let cursor = schedule.anchorDate;
  let prev = null;
  let guard = 0;
  while (cursor && cursor < date && guard < 256) {
    const next = advanceOnce(cursor, schedule);
    if (!next || next >= date) break;
    prev = cursor;
    cursor = next;
    guard += 1;
  }
  if (schedule.anchorDate < date) prev = prev || schedule.anchorDate;
  return prev;
}

function projectOccurrences({
  schedule,
  windowStart,
  windowEnd,
  maxCount = 128,
} = {}) {
  if (!schedule || schedule.uncertain || !windowStart || !windowEnd) return [];
  const seen = new Set();
  const out = [];
  let due = rollToOnOrAfter(windowStart, schedule);
  let guard = 0;
  while (due && due <= windowEnd && out.length < maxCount && guard < maxCount * 4) {
    if (due >= windowStart && !seen.has(due)) {
      seen.add(due);
      out.push(due);
    }
    const next = advanceOnce(due, schedule);
    if (!next || next === due) break;
    due = next;
    guard += 1;
  }
  return out;
}

function paidMatchWindow(dueDate, schedule) {
  const prev = previousOccurrenceBefore(dueDate, schedule);
  const lo = prev ? addDays(prev, 1) : addDays(dueDate, -Math.round((CADENCE_DAYS[schedule?.cadence] || 30.44) * 0.45));
  return { lo, hi: addDays(dueDate, 7) };
}

function renewalWindow(nextDate) {
  if (!nextDate) return null;
  return { start: addDays(nextDate, -3), end: addDays(nextDate, 3) };
}

function projectionConfidencePenalty(schedule) {
  if (!schedule || !schedule.uncertain) return 0;
  return 25 + Math.min(20, (schedule.reasons || []).length * 5);
}

module.exports = {
  CADENCE_DAYS,
  INACTIVE_GAP_DAYS,
  SEMIMONTHLY_PATTERNS,
  advanceOnce,
  advanceSemimonthly,
  addCalendarMonths,
  classifyCadence,
  gapMatchesCadence,
  inactiveGapDays,
  inferRecurrenceSchedule,
  inferSemimonthlyPattern,
  monthlyEquivalentAmount,
  nextOccurrenceAfter,
  paidMatchWindow,
  previousOccurrenceBefore,
  projectOccurrences,
  projectionConfidencePenalty,
  renewalWindow,
  rollToOnOrAfter,
  stepBackward,
};
