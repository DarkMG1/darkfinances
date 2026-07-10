const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const os = require('os');
const path = require('path');

const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'darkfinances-reports-'));
process.env.PERSONAL_CONFIG_PATH = path.join(dir, 'personal.json');
const { buildReportsPayload } = require('../dataModule');
test.after(() => fs.rmSync(dir, { recursive: true, force: true }));

test('report totals and field mappings obey their financial invariants', () => {
  const largest = [{ id: 'txn', payee: 'Merchant', amount: -250 }];
  const report = buildReportsPayload({
    month: '2026-07',
    generatedAt: '2026-07-10T00:00:00.000Z',
    monthly: {
      transactions: [
        { payee: 'Merchant', amount: -250 },
        { payee: 'Grocer', amount: -150 },
        { payee: 'Payroll', amount: 1000 },
      ],
      summary: {
        totalIncome: 1000,
        totalSpend: 400,
        spending: { Shopping: 250, Groceries: 150 },
      },
    },
    trends: { months: [{ month: '2026-07', income: 1000, spend: 400, net: 600, netWorth: 5000 }] },
    insights: { largestCharges: largest, uncategorized: [] },
    tags: { tags: [{ raw: '#trip', count: 1 }] },
  });
  assert.equal(report.monthlyReview.net, 600);
  assert.deepEqual(report.monthlyReview.largest, largest);
  assert.deepEqual(report.categoryTrends, [
    { name: 'Shopping', spend: 250, pct: 62.5 },
    { name: 'Groceries', spend: 150, pct: 37.5 },
  ]);
  assert.equal(report.merchantTrends[0].payee, 'Merchant');
  assert.equal(report.cashFlow[0].month, '2026-07');
});
