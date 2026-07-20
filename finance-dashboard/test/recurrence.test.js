const test = require('node:test');
const assert = require('node:assert/strict');

process.env.FINANCE_TIME_ZONE = 'America/Los_Angeles';

const {
  addCalendarMonths,
  advanceOnce,
  advanceSemimonthly,
  classifyCadence,
  inferRecurrenceSchedule,
  nextOccurrenceAfter,
  projectOccurrences,
  SEMIMONTHLY_PATTERNS,
} = require('../lib/recurrence');
const { addDays, addMonths } = require('../lib/date-only');

test('classifyCadence maps median gaps to named cadences', () => {
  assert.equal(classifyCadence(7), 'weekly');
  assert.equal(classifyCadence(14), 'biweekly');
  assert.equal(classifyCadence(16), 'semimonthly');
  assert.equal(classifyCadence(30), 'monthly');
  assert.equal(classifyCadence(null), null);
});

test('EOM monthly anchor preserves Jan 31 through Feb and Mar', () => {
  const schedule = inferRecurrenceSchedule({
    cadence: 'monthly',
    dates: ['2024-01-31', '2024-02-29', '2024-03-31'],
  });
  assert.equal(schedule.uncertain, false);
  assert.equal(schedule.monthDay, 31);
  assert.equal(nextOccurrenceAfter('2024-03-31', schedule), '2024-04-30');
  assert.equal(addCalendarMonths('2024-02-29', 1, 31), '2024-03-31');
});

test('monthly anchors handle Jan 30 and Jan 29 without drift', () => {
  for (const start of ['2026-01-30', '2026-01-29']) {
    const schedule = inferRecurrenceSchedule({
      cadence: 'monthly',
      dates: [start, addMonths(start, 1), addMonths(start, 2)],
    });
    assert.equal(schedule.uncertain, false);
    const projected = projectOccurrences({
      schedule,
      windowStart: start,
      windowEnd: addMonths(start, 6),
    });
    assert.equal(new Set(projected).size, projected.length);
    assert.deepEqual(projected.slice(0, 3), [start, addMonths(start, 1), addMonths(start, 2)]);
  }
});

test('leap and non-leap February transitions stay calendar-correct', () => {
  assert.equal(addMonths('2024-01-31', 1), '2024-02-29');
  assert.equal(addMonths('2026-01-31', 1), '2026-02-28');
  const leapSchedule = inferRecurrenceSchedule({
    cadence: 'monthly',
    dates: ['2024-01-31', '2024-02-29', '2024-03-31'],
  });
  const plainSchedule = inferRecurrenceSchedule({
    cadence: 'monthly',
    dates: ['2026-01-31', '2026-02-28', '2026-03-31'],
  });
  assert.equal(projectOccurrences({
    schedule: leapSchedule,
    windowStart: '2024-01-31',
    windowEnd: '2024-04-30',
  }).at(-1), '2024-04-30');
  assert.equal(projectOccurrences({
    schedule: plainSchedule,
    windowStart: '2026-01-31',
    windowEnd: '2026-04-30',
  }).at(-1), '2026-04-30');
});

test('year boundary monthly projection is inclusive and exact-once', () => {
  const schedule = inferRecurrenceSchedule({
    cadence: 'monthly',
    dates: ['2025-11-15', '2025-12-15', '2026-01-15'],
  });
  const projected = projectOccurrences({
    schedule,
    windowStart: '2025-12-01',
    windowEnd: '2026-02-15',
  });
  assert.deepEqual(projected, ['2025-12-15', '2026-01-15', '2026-02-15']);
});

test('semimonthly 1st/15th and 15th/EOM patterns advance independently of DST', () => {
  assert.equal(
    advanceSemimonthly('2026-03-01', SEMIMONTHLY_PATTERNS.first_and_fifteenth),
    '2026-03-15',
  );
  assert.equal(
    advanceSemimonthly('2026-03-15', SEMIMONTHLY_PATTERNS.first_and_fifteenth),
    '2026-04-01',
  );
  assert.equal(
    advanceSemimonthly('2026-03-10', SEMIMONTHLY_PATTERNS.fifteenth_and_eom),
    '2026-03-15',
  );
  assert.equal(
    advanceSemimonthly('2026-03-15', SEMIMONTHLY_PATTERNS.fifteenth_and_eom),
    '2026-03-31',
  );
  assert.equal(addDays('2026-03-07', 14), '2026-03-21');
  assert.equal(addDays('2026-11-01', 14), '2026-11-15');
});

test('semimonthly inference rejects ambiguous history', () => {
  const confident = inferRecurrenceSchedule({
    cadence: 'semimonthly',
    dates: ['2026-01-01', '2026-01-15', '2026-02-01', '2026-02-15'],
  });
  assert.equal(confident.uncertain, false);
  assert.equal(confident.semimonthlyPattern, SEMIMONTHLY_PATTERNS.first_and_fifteenth);

  const ambiguous = inferRecurrenceSchedule({
    cadence: 'semimonthly',
    dates: ['2026-01-07', '2026-01-22', '2026-02-08', '2026-02-23'],
  });
  assert.equal(ambiguous.uncertain, true);
});

test('weekly and biweekly projections are exact-once across windows', () => {
  const weekly = inferRecurrenceSchedule({
    cadence: 'weekly',
    dates: ['2026-03-01', '2026-03-08', '2026-03-15', '2026-03-22'],
  });
  const biweekly = inferRecurrenceSchedule({
    cadence: 'biweekly',
    dates: ['2026-03-01', '2026-03-15', '2026-03-29'],
  });
  for (const schedule of [weekly, biweekly]) {
    const projected = projectOccurrences({
      schedule,
      windowStart: '2026-03-01',
      windowEnd: '2026-04-15',
    });
    assert.equal(new Set(projected).size, projected.length);
    assert.equal(projected[0], '2026-03-01');
  }
});

test('two-occurrence rent history projects one monthly bill per window', () => {
  const schedule = inferRecurrenceSchedule({
    cadence: 'monthly',
    dates: ['2026-05-01', '2026-06-01'],
  });
  assert.equal(schedule.uncertain, false);
  const projected = projectOccurrences({
    schedule,
    windowStart: '2026-06-01',
    windowEnd: '2026-08-01',
  });
  assert.deepEqual(projected, ['2026-06-01', '2026-07-01', '2026-08-01']);
});

test('duplicate same-day history does not create duplicate projections', () => {
  const schedule = inferRecurrenceSchedule({
    cadence: 'monthly',
    dates: ['2026-04-01', '2026-05-01', '2026-05-01', '2026-06-01'],
  });
  const projected = projectOccurrences({
    schedule,
    windowStart: '2026-05-01',
    windowEnd: '2026-07-01',
  });
  assert.deepEqual(projected, ['2026-05-01', '2026-06-01', '2026-07-01']);
});

test('legacy 30-day drift regression: calendar monthly beats rounded day count', () => {
  const last = '2026-07-01';
  const legacy = addDays(last, 30);
  const schedule = inferRecurrenceSchedule({
    cadence: 'monthly',
    dates: ['2026-05-01', '2026-06-01', last],
  });
  const calendarNext = nextOccurrenceAfter(last, schedule);
  assert.equal(legacy, '2026-07-31');
  assert.equal(calendarNext, '2026-08-01');
});

test('inconsistent monthly day-of-month marks schedule uncertain', () => {
  const schedule = inferRecurrenceSchedule({
    cadence: 'monthly',
    dates: ['2026-01-05', '2026-02-03', '2026-03-08'],
  });
  assert.equal(schedule.uncertain, true);
  assert.match(schedule.reasons.join(','), /ambiguous-monthly-anchor|monthly-history-mismatch/);
});

test('window inclusivity keeps boundary dates once', () => {
  const schedule = inferRecurrenceSchedule({
    cadence: 'monthly',
    dates: ['2026-01-10', '2026-02-10', '2026-03-10'],
  });
  const projected = projectOccurrences({
    schedule,
    windowStart: '2026-03-10',
    windowEnd: '2026-03-10',
  });
  assert.deepEqual(projected, ['2026-03-10']);
});

test('advanceOnce uses calendar month steps for quarterly cadence', () => {
  const schedule = inferRecurrenceSchedule({
    cadence: 'quarterly',
    dates: ['2025-01-15', '2025-04-15', '2025-07-15'],
  });
  assert.equal(advanceOnce('2025-07-15', schedule), '2025-10-15');
});
