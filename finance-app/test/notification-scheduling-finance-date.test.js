'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const { classifyBillReminder } = require('../src/lib/notification-scheduling');
const { addDateOnlyDays, financeTodayAt } = require('../src/lib/finance-date-core');

test('classifyBillReminder anchors due/day comparisons to finance today', () => {
  const dueDate = '2026-07-16';
  const financeToday = '2026-07-15';
  const [y, m, d] = financeToday.split('-').map(Number);
  const beforeNine = new Date(y, m - 1, d, 8, 30, 0).getTime();
  const afterNine = new Date(y, m - 1, d, 10, 0, 0).getTime();
  const dueDay = Date.parse('2026-07-16T12:00:00');
  const overdueDay = Date.parse('2026-07-17T12:00:00');

  assert.equal(
    classifyBillReminder({ key: 'rent', dueDate, paid: false }, beforeNine, 'scope', financeToday).kind,
    'dayBefore',
  );
  assert.equal(
    classifyBillReminder({ key: 'rent', dueDate, paid: false }, afterNine, 'scope', financeToday).kind,
    'sameDayLate',
  );
  assert.equal(
    classifyBillReminder({ key: 'rent', dueDate, paid: false }, dueDay, 'scope', '2026-07-16').kind,
    'sameDayLate',
  );
  assert.equal(
    classifyBillReminder({ key: 'rent', dueDate, paid: false }, overdueDay, 'scope', '2026-07-17').kind,
    'overdue',
  );
});

test('classifyBillReminder keeps day-before delivery at 9am local wall clock', () => {
  const dueDate = '2026-03-10';
  const financeToday = addDateOnlyDays(dueDate, -1);
  const [y, m, d] = financeToday.split('-').map(Number);
  const beforeNine = new Date(y, m - 1, d, 8, 0, 0).getTime();
  const plan = classifyBillReminder({ key: 'rent', dueDate, paid: false }, beforeNine, 'scope', financeToday);
  assert.equal(plan.kind, 'dayBefore');
  assert.equal(plan.triggerDate.getHours(), 9);
  assert.equal(plan.triggerDate.getMinutes(), 0);
});

test('classifyBillReminder defaults finance today from now via financeTodayAt', () => {
  const now = Date.parse('2026-01-15T12:00:00-08:00');
  const anchor = financeTodayAt(new Date(now), 'America/Los_Angeles');
  const plan = classifyBillReminder(
    { key: 'rent', dueDate: anchor, paid: false },
    now,
    'scope',
  );
  assert.equal(plan.kind, 'sameDayLate');
});
