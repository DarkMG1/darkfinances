const test = require('node:test');
const assert = require('node:assert/strict');
const { mock } = require('node:test');
const path = require('node:path');
const { pathToFileURL } = require('node:url');

const dashboard = require('../finance-dashboard/lib/date-only');
const tools = require('../actual-tools/lib/date-only');
const mobile = require('../finance-app/src/lib/finance-date-core');

const BROWSER_FINANCE_DATE_URL = pathToFileURL(
  path.resolve(__dirname, '../finance-dashboard/public/js/finance-date.js'),
).href;
const BROWSER_STATE_URL = pathToFileURL(
  path.resolve(__dirname, '../finance-dashboard/public/js/state.js'),
).href;

/** @type {import('../finance-dashboard/public/js/finance-date.js')} */
let browser;
/** @type {import('../finance-dashboard/public/js/state.js')} */
let browserState;

test.before(async () => {
  browser = await import(BROWSER_FINANCE_DATE_URL);
  browserState = await import(BROWSER_STATE_URL);
});

const INSTANTS = [
  { label: 'DST 16:59 Pacific', iso: '2026-07-09T16:59:00-07:00', today: '2026-07-09' },
  { label: 'DST 17:01 Pacific', iso: '2026-07-09T17:01:00-07:00', today: '2026-07-09' },
  { label: 'STD 16:59 Pacific', iso: '2026-01-15T16:59:00-08:00', today: '2026-01-15' },
  { label: 'STD 17:01 Pacific', iso: '2026-01-15T17:01:00-08:00', today: '2026-01-15' },
];

function withFrozenNow(iso, fn) {
  mock.timers.enable({ apis: ['Date'], now: new Date(iso) });
  try {
    return fn();
  } finally {
    mock.timers.reset();
  }
}

function configureAllRuntimes() {
  process.env.FINANCE_TIME_ZONE = 'America/Los_Angeles';
  mobile.configureFinanceTimeZone('America/Los_Angeles');
  browser.setFinanceTimeZone('America/Los_Angeles');
}

for (const sample of INSTANTS) {
  test(`cross-runtime parity for ${sample.label}`, () => {
    withFrozenNow(sample.iso, () => {
      configureAllRuntimes();
      const value = new Date(sample.iso);
      assert.equal(dashboard.todayYMD(value), sample.today);
      assert.equal(tools.todayYMD(value), sample.today);
      assert.equal(mobile.financeTodayAt(value, 'America/Los_Angeles'), sample.today);
      assert.equal(browser.financeToday(), sample.today);
    });
  });
}

test('cross-runtime parity for month windows and reimbursement MTD', () => {
  const anchor = '2026-07-09';
  assert.deepEqual(dashboard.reimbursementWindow('mtd', anchor), mobile.reimbursementWindow('mtd', anchor));
  assert.equal(dashboard.startMonthsAgo(3, anchor), mobile.startMonthsAgo(3, anchor));
  assert.equal(dashboard.monthEnd('2026-07'), mobile.monthEnd('2026-07'));
  assert.equal(dashboard.addDays(anchor, -6), mobile.addDateOnlyDays(anchor, -6));
});

test('browser finance-date parity for daysUntil and dueLabel', () => {
  withFrozenNow('2026-07-09T12:00:00-07:00', () => {
    configureAllRuntimes();
    const anchor = '2026-07-09';
    const cases = [
      { date: null, days: null, label: 'date uncertain' },
      { date: '2026-07-08', days: -1, label: '1d overdue' },
      { date: '2026-07-09', days: 0, label: 'today' },
      { date: '2026-07-10', days: 1, label: 'tomorrow' },
      { date: '2026-07-11', days: 2, label: 'in 2d' },
      { date: '2026-07-22', days: 13, label: 'in 13d' },
      { date: '2026-07-23', days: 14, label: 'Jul 23' },
    ];
    for (const sample of cases) {
      assert.equal(browser.daysUntil(sample.date), sample.days, `daysUntil(${sample.date})`);
      if (sample.date != null) {
        assert.equal(mobile.daysUntilDateOnly(sample.date, anchor), sample.days, `mobile daysUntil(${sample.date})`);
      }
      assert.equal(browser.dueLabel(sample.date), sample.label, `dueLabel(${sample.date})`);
    }
  });
});

test('browser finance-date parity for monthBounds leap and month-length boundaries', () => {
  withFrozenNow('2026-03-01T12:00:00-08:00', () => {
    configureAllRuntimes();
    const anchor = '2026-03-01';
    const months = ['2024-02', '2026-02', '2026-07'];
    for (const month of months) {
      browserState.state.month = month;
      const bounds = browser.monthBounds();
      const expected = mobile.calendarMonthWindow(month, anchor);
      assert.equal(bounds.start, expected.start, `${month} start`);
      assert.equal(bounds.end, expected.end, `${month} end`);
      assert.equal(bounds.end, dashboard.monthEnd(month), `${month} monthEnd`);
    }

    browserState.state.month = null;
    const current = browser.monthBounds();
    const currentExpected = mobile.calendarMonthWindow('2026-03', anchor);
    assert.equal(current.start, currentExpected.start);
    assert.equal(current.end, currentExpected.end);
  });
});

test('browser finance-date parity for leap-day addDays across month boundary', () => {
  const anchor = '2024-02-28';
  assert.equal(dashboard.addDays(anchor, 1), mobile.addDateOnlyDays(anchor, 1));
  assert.equal(dashboard.addDays(anchor, 1), '2024-02-29');
});
