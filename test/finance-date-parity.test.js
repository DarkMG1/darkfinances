const test = require('node:test');
const assert = require('node:assert/strict');
const path = require('node:path');

const dashboard = require('../finance-dashboard/lib/date-only');
const tools = require('../actual-tools/lib/date-only');
const mobile = require('../finance-app/src/lib/finance-date-core');

const INSTANTS = [
  { label: 'DST 16:59 Pacific', iso: '2026-07-09T16:59:00-07:00', today: '2026-07-09' },
  { label: 'DST 17:01 Pacific', iso: '2026-07-09T17:01:00-07:00', today: '2026-07-09' },
  { label: 'STD 16:59 Pacific', iso: '2026-01-15T16:59:00-08:00', today: '2026-01-15' },
  { label: 'STD 17:01 Pacific', iso: '2026-01-15T17:01:00-08:00', today: '2026-01-15' },
];

process.env.FINANCE_TIME_ZONE = 'America/Los_Angeles';
mobile.configureFinanceTimeZone('America/Los_Angeles');

for (const sample of INSTANTS) {
  test(`cross-runtime parity for ${sample.label}`, () => {
    const value = new Date(sample.iso);
    assert.equal(dashboard.todayYMD(value), sample.today);
    assert.equal(tools.todayYMD(value), sample.today);
    assert.equal(mobile.financeTodayAt(value, 'America/Los_Angeles'), sample.today);
  });
}

test('cross-runtime parity for month windows and reimbursement MTD', () => {
  const anchor = '2026-07-09';
  assert.deepEqual(dashboard.reimbursementWindow('mtd', anchor), mobile.reimbursementWindow('mtd', anchor));
  assert.equal(dashboard.startMonthsAgo(3, anchor), mobile.startMonthsAgo(3, anchor));
  assert.equal(dashboard.monthEnd('2026-07'), mobile.monthEnd('2026-07'));
  assert.equal(dashboard.addDays(anchor, -6), mobile.addDateOnlyDays(anchor, -6));
});
