const test = require('node:test');
const assert = require('node:assert/strict');
const { financeTodayAt, previousMonth } = require('../src/lib/finance-date-core');

test('notification transaction window uses canonical finance today', () => {
  const financeToday = financeTodayAt(new Date('2026-07-16T12:00:00-07:00'), 'America/Los_Angeles');
  const windowStart = `${previousMonth(financeToday.slice(0, 7))}-01`;
  assert.equal(financeToday, '2026-07-16');
  assert.equal(windowStart, '2026-06-01');
});

test('notification transaction window rolls with Pacific finance midnight', () => {
  const before = financeTodayAt(new Date('2026-07-09T16:59:00-07:00'), 'America/Los_Angeles');
  const after = financeTodayAt(new Date('2026-07-09T17:01:00-07:00'), 'America/Los_Angeles');
  assert.equal(before, after);
  assert.equal(`${previousMonth(before.slice(0, 7))}-01`, '2026-06-01');
});
