'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');

const { addDays, daysInMonth } = require('../lib/date-only');
const { fromCents, sumCents, toCents } = require('../lib/domain/money');
const {
  ALLOCATION_METHOD,
  allocateCentsOverDays,
  pastAndRemainingCents,
  buildForecastBudgetDailyCents,
  buildForecastGenericBudgetContext,
  readCategoryMoneyCents,
  trySumCategoryFieldCents,
} = require('../lib/domain/cent-allocation');

const round2 = (n) => Math.round(n * 100) / 100;

function oracleQuotientRemainderCents(totalCents, dayCount) {
  if (!Number.isSafeInteger(totalCents) || !Number.isInteger(dayCount) || dayCount <= 0) {
    throw new RangeError('oracle inputs must be safe integers');
  }
  if (totalCents === 0) return Array(dayCount).fill(0);
  const sign = totalCents < 0 ? -1 : 1;
  const absTotal = Math.abs(totalCents);
  const quotient = Math.floor(absTotal / dayCount);
  const remainder = absTotal % dayCount;
  const out = [];
  for (let i = 0; i < dayCount; i++) {
    out.push(sign * (quotient + (i < remainder ? 1 : 0)));
  }
  return out;
}

function legacyDailyDollarDrift(totalDollars, dayCount) {
  const daily = totalDollars / dayCount;
  return round2(round2(daily) * dayCount) - totalDollars;
}

test('reproduction: rounded daily dollars drift for $1 and signed month lengths', () => {
  assert.notEqual(legacyDailyDollarDrift(100, 31), 0);
  assert.notEqual(legacyDailyDollarDrift(100, 28), 0);
  assert.notEqual(legacyDailyDollarDrift(1, 31), 0);
  assert.notEqual(legacyDailyDollarDrift(-100, 31), 0);
  assert.notEqual(legacyDailyDollarDrift(100.01, 3), 0);
});

test('allocateCentsOverDays matches independent quotient-remainder oracle', () => {
  const dayCounts = [3, 28, 29, 30, 31];
  for (const dayCount of dayCounts) {
    for (let totalCents = -4096; totalCents <= 4096; totalCents += 113) {
      const { allocationsCents } = allocateCentsOverDays(totalCents, dayCount);
      assert.deepEqual(allocationsCents, oracleQuotientRemainderCents(totalCents, dayCount));
    }
  }
});

test('allocateCentsOverDays conserves exact cents for explicit ±$1 and sub-dollar amounts', () => {
  for (const dayCount of [3, 28, 29, 30, 31]) {
    for (const totalCents of [100, -100, 1, -1, 99, 50, -50, 10001]) {
      const { allocationsCents, provenance } = allocateCentsOverDays(totalCents, dayCount);
      assert.equal(allocationsCents.length, dayCount);
      assert.equal(sumCents(allocationsCents), totalCents);
      assert.equal(provenance.method, ALLOCATION_METHOD);
      assert.equal(provenance.totalCents, totalCents);
      assert.equal(provenance.dayCount, dayCount);
      assert.ok(allocationsCents.every((value) => Number.isSafeInteger(value)));
    }
  }
});

test('property-style: broad safe integer totals and all positions conserve cents', () => {
  const dayCounts = [3, 28, 29, 30, 31];
  for (const dayCount of dayCounts) {
    for (let totalCents = -500; totalCents <= 500; totalCents += 17) {
      const { allocationsCents } = allocateCentsOverDays(totalCents, dayCount);
      assert.equal(sumCents(allocationsCents), totalCents);
      for (let position = 0; position <= dayCount; position++) {
        const split = pastAndRemainingCents(allocationsCents, position);
        assert.equal(split.pastCents + split.remainingCents, totalCents);
        assert.equal(split.totalCents, totalCents);
      }
    }
  }
});

test('zero and amounts smaller than day count distribute without fractional cents', () => {
  const zero = allocateCentsOverDays(0, 31);
  assert.deepEqual(zero.allocationsCents, Array(31).fill(0));

  const oneCent = allocateCentsOverDays(1, 31);
  assert.equal(sumCents(oneCent.allocationsCents), 1);
  assert.equal(oneCent.allocationsCents.filter((value) => value === 1).length, 1);
  assert.equal(oneCent.allocationsCents.filter((value) => value === 0).length, 30);
});

test('leap February full-month allocation conserves cents', () => {
  const { allocationsCents } = allocateCentsOverDays(10000, 29);
  assert.equal(allocationsCents.length, 29);
  assert.equal(sumCents(allocationsCents), 10000);
});

test('buildForecastBudgetDailyCents uses today-inclusive remaining days in current month', () => {
  const today = '2026-01-15';
  const remainingCents = 10000;
  const targetCents = 20000;
  const horizonDays = 20;
  const entries = buildForecastBudgetDailyCents({
    today,
    horizonDays,
    currentMonthRemainingCents: remainingCents,
    fullMonthTargetCents: targetCents,
    addDays,
    daysInMonth,
  });

  const currentMonthDays = Math.max(1, daysInMonth('2026-01') - 15 + 1);
  const janEntries = entries.filter((entry) => entry.date.startsWith('2026-01'));
  assert.equal(janEntries.length, Math.min(currentMonthDays, horizonDays + 1));
  assert.equal(sumCents(janEntries.map((entry) => entry.centsCents)), remainingCents);

  const febEntries = entries.filter((entry) => entry.date.startsWith('2026-02'));
  if (febEntries.length === daysInMonth('2026-02')) {
    assert.equal(sumCents(febEntries.map((entry) => entry.centsCents)), targetCents);
  } else {
    assert.ok(febEntries.length > 0);
    assert.ok(febEntries.length < daysInMonth('2026-02'));
  }
});

test('buildForecastBudgetDailyCents conserves at every position within each period', () => {
  const today = '2024-02-10';
  const remainingCents = 7777;
  const targetCents = 12345;
  const entries = buildForecastBudgetDailyCents({
    today,
    horizonDays: 45,
    currentMonthRemainingCents: remainingCents,
    fullMonthTargetCents: targetCents,
    addDays,
    daysInMonth,
  });

  const byMonth = new Map();
  for (const entry of entries) {
    const month = entry.date.slice(0, 7);
    if (!byMonth.has(month)) byMonth.set(month, []);
    byMonth.get(month).push(entry);
  }

  const feb = byMonth.get('2024-02') || [];
  for (let position = 0; position <= feb.length; position++) {
    const past = sumCents(feb.slice(0, position).map((entry) => entry.centsCents));
    const rest = sumCents(feb.slice(position).map((entry) => entry.centsCents));
    assert.equal(past + rest, remainingCents);
  }

  const mar = byMonth.get('2024-03') || [];
  if (mar.length === daysInMonth('2024-03')) {
    assert.equal(sumCents(mar.map((entry) => entry.centsCents)), targetCents);
  }
});

test('repeated buildForecastBudgetDailyCents calls are deterministic', () => {
  const input = {
    today: '2026-07-17',
    horizonDays: 60,
    currentMonthRemainingCents: 4321,
    fullMonthTargetCents: 9876,
    addDays,
    daysInMonth,
  };
  const first = buildForecastBudgetDailyCents(input);
  const second = buildForecastBudgetDailyCents(input);
  assert.deepEqual(first, second);
});

test('finance-date contract: allocation spans leap and month-length boundaries via date-only', () => {
  const today = '2024-01-31';
  const entries = buildForecastBudgetDailyCents({
    today,
    horizonDays: 90,
    currentMonthRemainingCents: 3100,
    fullMonthTargetCents: 2800,
    addDays,
    daysInMonth,
  });
  assert.ok(entries.some((entry) => entry.date === '2024-02-29'));
  const jan = entries.filter((entry) => entry.date.startsWith('2024-01'));
  assert.equal(sumCents(jan.map((entry) => entry.centsCents)), 3100);
});

test('unsafe and non-integer allocation inputs throw instead of rounding', () => {
  assert.throws(() => allocateCentsOverDays(1.5, 3), /safe integer/);
  assert.throws(() => allocateCentsOverDays(Number.NaN, 3), /safe integer/);
  assert.throws(() => allocateCentsOverDays(100, 0), /positive integer/);
  assert.throws(() => allocateCentsOverDays(100, 1.5), /positive integer/);
  assert.throws(() => allocateCentsOverDays(100, Number.MAX_SAFE_INTEGER), /allocation span|safe integer/);
});

test('readCategoryMoneyCents treats null and missing as semantic zero', () => {
  assert.equal(readCategoryMoneyCents(null), 0);
  assert.equal(readCategoryMoneyCents(undefined), 0);
  assert.equal(readCategoryMoneyCents(0), 0);
  assert.equal(readCategoryMoneyCents(12.34), toCents(12.34));
});

test('trySumCategoryFieldCents rejects garbage and accepts explicit semantic zero', () => {
  const valid = trySumCategoryFieldCents([{ target: 12.34 }, { target: 0.01 }, { target: 0 }], 'target');
  assert.equal(valid.complete, true);
  assert.equal(valid.cents, toCents(12.34) + toCents(0.01));

  const missing = trySumCategoryFieldCents([{ name: 'Groceries' }, { target: 5 }], 'target');
  assert.equal(missing.complete, true);
  assert.equal(missing.cents, toCents(5));

  for (const bad of [
    [{ target: 'foo' }],
    [{ target: Number.NaN }],
    [{ target: Number.POSITIVE_INFINITY }],
    [{ target: '12.34' }],
    [{ target: 1.005 }],
    [{ target: Number.MAX_VALUE }],
  ]) {
    const invalid = trySumCategoryFieldCents(bad, 'target');
    assert.equal(invalid.complete, false, JSON.stringify(bad));
    assert.equal(invalid.cents, null);
    assert.deepEqual(invalid.incompleteReasons, ['money_input_invalid']);
  }
});

test('buildForecastGenericBudgetContext exposes truthful nullable assumptions', () => {
  const complete = buildForecastGenericBudgetContext([
    { target: 100, remaining: 75 },
    { target: 50, remaining: 25 },
  ]);
  assert.equal(complete.complete, true);
  assert.equal(complete.assumptions.target, 150);
  assert.equal(complete.assumptions.remaining, 100);
  assert.deepEqual(complete.assumptions.incompleteReasons, []);
  assert.deepEqual(complete.warnings, []);

  const incomplete = buildForecastGenericBudgetContext([{ target: 100, remaining: 'bad' }]);
  assert.equal(incomplete.complete, false);
  assert.equal(incomplete.assumptions.target, null);
  assert.equal(incomplete.assumptions.remaining, null);
  assert.equal(incomplete.assumptions.complete, false);
  assert.deepEqual(incomplete.assumptions.incompleteReasons, ['money_input_invalid']);
  assert.equal(incomplete.warnings.length, 1);
});

test('display conversion happens only at dollar boundary', () => {
  const { allocationsCents } = allocateCentsOverDays(100, 31);
  const dollars = allocationsCents.map((cents) => fromCents(cents));
  assert.equal(sumCents(allocationsCents), 100);
  assert.ok(dollars.every((value) => Number.isFinite(value)));
  assert.throws(() => toCents(3.333), /two decimal/);
});

test('no NaN or fractional-cent values leak from allocation helpers', () => {
  for (const dayCount of [3, 28, 29, 30, 31]) {
    for (const totalCents of [-101, -1, 0, 1, 101, 9999]) {
      const { allocationsCents } = allocateCentsOverDays(totalCents, dayCount);
      for (const cents of allocationsCents) {
        assert.ok(Number.isSafeInteger(cents));
        assert.ok(!Number.isNaN(cents));
        assert.equal(cents, Math.trunc(cents));
      }
    }
  }
});
