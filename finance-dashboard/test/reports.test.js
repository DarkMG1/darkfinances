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
        completeness: {
          complete: true,
          incompleteReasons: [],
          transferIdentityUnresolvedCount: 0,
          transferIdentityReasons: [],
        },
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

test('report monthlyReview nulls authoritative totals when transfer identity is incomplete', () => {
  const report = buildReportsPayload({
    month: '2026-07',
    generatedAt: '2026-07-10T00:00:00.000Z',
    monthly: {
      transactions: [{ payee: 'Merchant', amount: -250, transfer: true }],
      summary: {
        totalSpend: null,
        totalIncome: null,
        knownSpendSubtotal: 250,
        knownIncomeSubtotal: 0,
        spending: { Shopping: 250 },
        completeness: {
          complete: false,
          incompleteReasons: ['transfer_identity_unresolved'],
          transferIdentityUnresolvedCount: 1,
          transferIdentityReasons: ['transfer_pair_amount_mismatch'],
        },
      },
    },
    trends: { months: [{ month: '2026-07', income: 1000, spend: 400, net: 600, netWorth: 5000 }], completeness: { complete: true, incompleteReasons: [], transferIdentityUnresolvedCount: 0, transferIdentityReasons: [] } },
    insights: { largestCharges: [], uncategorized: [], completeness: { complete: true, incompleteReasons: [], transferIdentityUnresolvedCount: 0, transferIdentityReasons: [] } },
    tags: { tags: [] },
  });
  assert.equal(report.monthlyReview.spend, null);
  assert.equal(report.monthlyReview.income, null);
  assert.equal(report.monthlyReview.knownSpendSubtotal, 250);
  assert.equal(report.completeness.complete, false);
  assert.deepEqual(report.categoryTrends, []);
  assert.deepEqual(report.merchantTrends, []);
  assert.equal(report.categoryTrendsComplete, false);
  assert.equal(report.merchantTrendsComplete, false);
});

test('report withholds merchant and category trends when monthly incomplete even if cashFlow trends complete', () => {
  const report = buildReportsPayload({
    month: '2026-07',
    generatedAt: '2026-07-10T00:00:00.000Z',
    monthly: {
      transactions: [{ payee: 'Transfer Payee', amount: -500, transfer: true }],
      summary: {
        totalSpend: null,
        totalIncome: null,
        knownSpendSubtotal: 500,
        spending: { Transfer: 500 },
        completeness: {
          complete: false,
          incompleteReasons: ['transfer_identity_unresolved'],
          transferIdentityUnresolvedCount: 1,
          transferIdentityReasons: ['transfer_pair_amount_mismatch'],
        },
      },
    },
    trends: {
      months: [{ month: '2026-07', income: 1000, spend: 400, net: 600, netWorth: 5000, complete: true }],
      completeness: { complete: true, incompleteReasons: [], transferIdentityUnresolvedCount: 0, transferIdentityReasons: [] },
    },
    insights: { largestCharges: [], uncategorized: [] },
    tags: { tags: [] },
  });
  assert.deepEqual(report.categoryTrends, []);
  assert.deepEqual(report.merchantTrends, []);
  assert.equal(report.cashFlow.length, 1);
  assert.equal(report.cashFlow[0].spend, 400);
});

test('report merchant trends exclude transfer rows when monthly summary is complete', () => {
  const report = buildReportsPayload({
    month: '2026-07',
    generatedAt: '2026-07-10T00:00:00.000Z',
    monthly: {
      transactions: [
        { payee: 'Merchant', amount: -250 },
        { payee: 'Internal Transfer', amount: -900, transfer: true },
      ],
      summary: {
        totalIncome: 1000,
        totalSpend: 250,
        spending: { Shopping: 250 },
        completeness: {
          complete: true,
          incompleteReasons: [],
          transferIdentityUnresolvedCount: 0,
          transferIdentityReasons: [],
        },
      },
    },
    trends: { months: [] },
    insights: { largestCharges: [], uncategorized: [] },
    tags: { tags: [] },
  });
  assert.equal(report.merchantTrends.length, 1);
  assert.equal(report.merchantTrends[0].payee, 'Merchant');
  assert.equal(report.merchantTrends[0].spend, 250);
});
