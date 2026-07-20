const test = require('node:test');
const assert = require('node:assert/strict');
const { categoryRangeWindow } = require('../src/lib/finance-date-core');

const ANCHOR = '2026-07-09';

test('category month window anchors on finance today at Pacific boundary', () => {
  assert.deepEqual(categoryRangeWindow('month', ANCHOR), {
    start: '2026-07-01',
    end: ANCHOR,
    label: 'This month',
  });
});

test('category 3M window ignores device-local month math', () => {
  assert.deepEqual(categoryRangeWindow('3m', ANCHOR), {
    start: '2026-05-01',
    end: ANCHOR,
    label: 'Last 3 months',
  });
});

test('category year window uses finance year boundary', () => {
  assert.deepEqual(categoryRangeWindow('year', ANCHOR), {
    start: '2026-01-01',
    end: ANCHOR,
    label: 'This year',
  });
});

test('Pacific 16:59 and 17:01 share the same month window end during DST', () => {
  const { financeTodayAt } = require('../src/lib/finance-date-core');
  const before = financeTodayAt(new Date('2026-07-09T16:59:00-07:00'), 'America/Los_Angeles');
  const after = financeTodayAt(new Date('2026-07-09T17:01:00-07:00'), 'America/Los_Angeles');
  assert.equal(before, after);
  assert.deepEqual(categoryRangeWindow('month', before), categoryRangeWindow('month', after));
});
