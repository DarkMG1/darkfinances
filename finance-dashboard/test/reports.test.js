const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const os = require('os');
const path = require('path');

const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'darkfinances-reports-'));
process.env.PERSONAL_CONFIG_PATH = path.join(dir, 'personal.json');
const { buildReportsPayload } = require('../dataModule');
const { PROVENANCE } = require('../lib/domain/classification');
test.after(() => fs.rmSync(dir, { recursive: true, force: true }));

function completeSummary(overrides = {}) {
  return {
    totalIncome: 1000,
    totalSpend: 400,
    spending: { Shopping: 250, Groceries: 150 },
    completeness: {
      complete: true,
      incompleteReasons: [],
      transferIdentityUnresolvedCount: 0,
      transferIdentityReasons: [],
    },
    ...overrides,
  };
}

function spendLeaf({ payee, amountCents, kind = 'spend', reason = 'category:Shopping' }) {
  return {
    payee,
    amount: amountCents,
    kind,
    reason,
    countsAsSpending: true,
    countsAsIncome: false,
    provenance: 'classification:category',
  };
}

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
      classifiedLeaves: [
        spendLeaf({ payee: 'Merchant', amountCents: -25000 }),
        spendLeaf({ payee: 'Grocer', amountCents: -15000, reason: 'category:Groceries' }),
      ],
      summary: completeSummary(),
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
  assert.equal(report.merchantTrendsComplete, true);
  assert.equal(report.cashFlow[0].month, '2026-07');
});

test('report monthlyReview nulls authoritative totals when transfer identity is incomplete', () => {
  const report = buildReportsPayload({
    month: '2026-07',
    generatedAt: '2026-07-10T00:00:00.000Z',
    monthly: {
      transactions: [{ payee: 'Merchant', amount: -250, transfer: true }],
      classifiedLeaves: [{
        payee: 'Merchant',
        amount: -25000,
        kind: 'incomplete',
        provenance: PROVENANCE.TRANSFER_IDENTITY,
        countsAsSpending: false,
      }],
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
      classifiedLeaves: [],
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
      classifiedLeaves: [
        spendLeaf({ payee: 'Merchant', amountCents: -25000 }),
        {
          payee: 'Internal Transfer',
          amount: -90000,
          kind: 'transfer',
          countsAsSpending: false,
          provenance: PROVENANCE.TRANSFER_IDENTITY,
        },
      ],
      summary: completeSummary({ totalSpend: 250, totalIncome: 1000, spending: { Shopping: 250 } }),
    },
    trends: { months: [] },
    insights: { largestCharges: [], uncategorized: [] },
    tags: { tags: [] },
  });
  assert.equal(report.merchantTrends.length, 1);
  assert.equal(report.merchantTrends[0].payee, 'Merchant');
  assert.equal(report.merchantTrends[0].spend, 250);
  assert.equal(report.merchantTrendsComplete, true);
});

test('report merchant trends exclude CC payments and reimbursements from classified leaves', () => {
  const report = buildReportsPayload({
    month: '2026-07',
    generatedAt: '2026-07-10T00:00:00.000Z',
    monthly: {
      transactions: [
        { payee: 'Merchant', amount: -250 },
        { payee: 'CC Payment', amount: -900 },
        { payee: 'Venmo Reimb', amount: -120 },
      ],
      classifiedLeaves: [
        spendLeaf({ payee: 'Merchant', amountCents: -25000 }),
        {
          payee: 'CC Payment',
          amount: -90000,
          kind: 'mm',
          reason: 'category:Credit Card Payment',
          countsAsSpending: false,
          provenance: 'classification:category',
        },
        {
          payee: 'Venmo Reimb',
          amount: -12000,
          kind: 'reimb',
          reason: 'category:Reimbursement',
          countsAsSpending: false,
          provenance: 'classification:category',
        },
      ],
      summary: completeSummary({ totalSpend: 250, totalIncome: 0, spending: { Shopping: 250 } }),
    },
    trends: { months: [] },
    insights: { largestCharges: [], uncategorized: [] },
    tags: { tags: [] },
  });
  assert.equal(report.merchantTrends.length, 1);
  assert.equal(report.merchantTrends[0].payee, 'Merchant');
  assert.equal(report.merchantTrendsComplete, true);
});

test('report merchant trends fail closed when classified leaves do not conserve totalSpend', () => {
  const report = buildReportsPayload({
    month: '2026-07',
    generatedAt: '2026-07-10T00:00:00.000Z',
    monthly: {
      transactions: [{ payee: 'Merchant', amount: -250 }],
      classifiedLeaves: [spendLeaf({ payee: 'Merchant', amountCents: -20000 })],
      summary: completeSummary({ totalSpend: 250, spending: { Shopping: 250 } }),
    },
    trends: { months: [] },
    insights: { largestCharges: [], uncategorized: [] },
    tags: { tags: [] },
  });
  assert.deepEqual(report.merchantTrends, []);
  assert.equal(report.merchantTrendsComplete, false);
});

test('report merchant trends exclude malformed transfer identity leaves even when raw rows lack transfer flag', () => {
  const report = buildReportsPayload({
    month: '2026-07',
    generatedAt: '2026-07-10T00:00:00.000Z',
    monthly: {
      transactions: [
        { payee: 'Merchant', amount: -250 },
        { payee: 'Mystery Move', amount: -500 },
      ],
      classifiedLeaves: [
        spendLeaf({ payee: 'Merchant', amountCents: -25000 }),
        {
          payee: 'Mystery Move',
          amount: -50000,
          kind: 'incomplete',
          provenance: PROVENANCE.TRANSFER_IDENTITY,
          countsAsSpending: false,
        },
      ],
      summary: completeSummary({ totalSpend: 250, spending: { Shopping: 250 } }),
    },
    trends: { months: [] },
    insights: { largestCharges: [], uncategorized: [] },
    tags: { tags: [] },
  });
  assert.equal(report.merchantTrends.length, 1);
  assert.equal(report.merchantTrends[0].spend, 250);
  assert.equal(report.merchantTrendsComplete, true);
});

test('report merchant trends aggregate split legs under parent payee', () => {
  const report = buildReportsPayload({
    month: '2026-07',
    generatedAt: '2026-07-10T00:00:00.000Z',
    monthly: {
      transactions: [{ payee: 'Warehouse', amount: -300 }],
      classifiedLeaves: [
        spendLeaf({ payee: 'Warehouse', amountCents: -20000, reason: 'category:Groceries' }),
        spendLeaf({ payee: 'Warehouse', amountCents: -10000, reason: 'category:Household' }),
      ],
      summary: completeSummary({ totalSpend: 300, spending: { Groceries: 200, Household: 100 } }),
    },
    trends: { months: [] },
    insights: { largestCharges: [], uncategorized: [] },
    tags: { tags: [] },
  });
  assert.equal(report.merchantTrends.length, 1);
  assert.equal(report.merchantTrends[0].payee, 'Warehouse');
  assert.equal(report.merchantTrends[0].spend, 300);
  assert.equal(report.merchantTrends[0].count, 2);
  assert.equal(report.merchantTrendsComplete, true);
});
