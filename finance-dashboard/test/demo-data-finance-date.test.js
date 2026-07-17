const test = require('node:test');
const assert = require('node:assert/strict');
const path = require('node:path');

function loadDemoData(nowIso) {
  process.env.FINANCE_TIME_ZONE = 'America/Los_Angeles';
  process.env.DEMO_FINANCE_NOW = nowIso;
  const demoPath = path.resolve(__dirname, '../demoData.js');
  delete require.cache[require.resolve(demoPath)];
  delete require.cache[require.resolve('../lib/date-only.js')];
  return require(demoPath);
}

test('demo budgets derive daysElapsed and daily pace from finance anchor', () => {
  const demo = loadDemoData('2026-07-09T17:01:00-07:00');
  const budgets = demo.budgets();
  assert.equal(budgets.month, '2026-07');
  assert.equal(budgets.daysElapsed, 9);
  assert.equal(budgets.daysInMonth, 31);
  const groceries = budgets.groups.flatMap((g) => g.categories).find((c) => c.name === 'Groceries');
  assert.equal(groceries.dailyPace, Math.round((512.34 / 9) * 100) / 100);
});

test('demo spending and reimbursement windows honor frozen finance today', () => {
  const demo = loadDemoData('2026-01-15T17:01:00-08:00');
  const today = demo.today();
  assert.equal(today.financeDate, '2026-01-15');
  const spending = demo.spending();
  assert.equal(spending.month, '2026-01');
  assert.equal(spending.current.totalSpend >= 0, true);
  const reimb = demo.reimbursement();
  assert.equal(reimb.range.to, '2026-01-15');
});

test('demo trends and merchant history use finance month keys', () => {
  const demo = loadDemoData('2026-07-09T17:01:00-07:00');
  const trendMonths = demo.trends(6).months.map((m) => m.month);
  assert.deepEqual(trendMonths, ['2026-02', '2026-03', '2026-04', '2026-05', '2026-06', '2026-07']);
  const merchant = demo.merchantHistory({ payee: 'Netflix', months: 3 });
  assert.deepEqual(merchant.months.map((m) => m.month), ['2026-05', '2026-06', '2026-07']);
});

test('demo recurring lastCharged is relative to finance anchor, not device today', () => {
  const demo = loadDemoData('2026-07-09T17:01:00-07:00');
  const netflix = demo.recurring().items.find((item) => item.payee === 'Netflix');
  assert.equal(netflix.lastCharged, '2026-07-01');
  assert.equal(netflix.nextRenewal, '2026-07-31');
});
