const test = require('node:test');
const assert = require('node:assert/strict');

process.env.FINANCE_TIME_ZONE = 'America/Los_Angeles';
const { addDays, addMonths, daysBetween, daysInMonth, monthRange, todayYMD } = require('../lib/date-only');

test('finance today stays Pacific around UTC midnight', () => {
  assert.equal(todayYMD(new Date('2026-07-10T06:30:00.000Z')), '2026-07-09');
  assert.equal(todayYMD(new Date('2026-07-10T07:30:00.000Z')), '2026-07-10');
});

test('date-only arithmetic does not drift across daylight-saving boundaries', () => {
  assert.equal(addDays('2026-03-07', 2), '2026-03-09');
  assert.equal(addDays('2026-11-01', 1), '2026-11-02');
  assert.equal(daysBetween('2026-03-07', '2026-03-09'), 2);
});

test('month ranges and leap days are calendar-correct', () => {
  assert.deepEqual(monthRange(2024, 1), {
    key: '2024-02',
    start: '2024-02-01',
    end: '2024-02-29',
  });
  assert.equal(daysInMonth('2026-02'), 28);
  assert.throws(() => addDays('2026-02-30', 1), /real calendar date/);
  assert.equal(addMonths('2026-01-31', 1), '2026-02-28');
  assert.equal(addMonths('2024-01-31', 1), '2024-02-29');
});
