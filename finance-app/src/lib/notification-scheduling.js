'use strict';

const {
  addDateOnlyDays,
  daysUntilDateOnly,
  financeTodayAt,
} = require('./finance-date-core');

/** @typedef {'dayBefore' | 'sameDayLate' | 'overdue'} BillReminderKind */

/**
 * @param {{ key: string; dueDate: string; paid?: boolean }} bill
 * @param {number} [now]
 * @param {string} [scope]
 * @param {string} [financeTodayAnchor]
 */
function billSameDayKey(scope, billKey, dueDate) {
  return `notif.billSameDay.v2.${scope}.${billKey}-${dueDate}`;
}

function legacyBillSameDayKey(billKey, dueDate) {
  return `notif.billSameDay.${billKey}-${dueDate}`;
}

function localNineAmOnDateOnly(ymd) {
  const [y, m, d] = ymd.split('-').map(Number);
  return new Date(y, m - 1, d, 9, 0, 0);
}

/**
 * Bill due/day classification uses canonical finance dates; 9am local wall-clock is
 * delivery time only for the day-before reminder.
 *
 * @param {{ key: string; dueDate: string; paid?: boolean }} bill
 * @param {number} [now]
 * @param {string} [scope]
 * @param {string} [financeTodayAnchor]
 */
function classifyBillReminder(bill, now = Date.now(), scope = 'default', financeTodayAnchor) {
  if (bill.paid) return null;
  const anchor = financeTodayAnchor ?? financeTodayAt(new Date(now));
  const daysUntil = daysUntilDateOnly(bill.dueDate, anchor);
  const dayBeforeYmd = addDateOnlyDays(bill.dueDate, -1);
  const remindAt = localNineAmOnDateOnly(dayBeforeYmd);

  if (daysUntil < 0) {
    return { kind: 'overdue', triggerDate: null, sameDayKey: null };
  }
  if (daysUntil === 0 || (daysUntil === 1 && remindAt.getTime() <= now)) {
    return {
      kind: 'sameDayLate',
      triggerDate: new Date(now + 5_000),
      sameDayKey: billSameDayKey(scope, bill.key, bill.dueDate),
    };
  }
  return { kind: 'dayBefore', triggerDate: remindAt, sameDayKey: null };
}

module.exports = {
  billSameDayKey,
  classifyBillReminder,
  legacyBillSameDayKey,
};
