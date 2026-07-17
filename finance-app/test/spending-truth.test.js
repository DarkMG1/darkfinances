const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const path = require('path');
const {
  UNTRACKED_METRIC_LABEL,
  buildNonSpendingMetrics,
  computedMoneyMetric,
  loadingSpendingMetric,
  untrackedSpendingMetric,
} = require('../src/lib/spending-metrics');

const spendingSource = fs.readFileSync(
  path.resolve(__dirname, '..', 'src', 'app', '(tabs)', 'spending.tsx'),
  'utf8',
);

test('untracked non-spending metrics never announce fabricated zero amounts', () => {
  const metrics = buildNonSpendingMetrics({ reimbursementTotal: 0, refundTotal: 0 });

  assert.equal(metrics.taxDeductible.kind, 'untracked');
  assert.equal(metrics.taxDeductible.display, UNTRACKED_METRIC_LABEL);
  assert.equal(metrics.taxDeductible.accessibilityLabel, 'Tax Deductible, not tracked');
  assert.doesNotMatch(metrics.taxDeductible.display, /\$0/);

  assert.equal(metrics.transfers.kind, 'untracked');
  assert.equal(metrics.transfers.accessibilityLabel, 'Transfers, not tracked');
  assert.doesNotMatch(metrics.transfers.display, /^0$/);
});

test('computed non-spending metrics distinguish genuine zero from nonzero totals', () => {
  const empty = buildNonSpendingMetrics({ reimbursementTotal: 0, refundTotal: 0 });
  assert.equal(empty.reimbursements.kind, 'computed');
  assert.equal(empty.reimbursements.display, '$0.00');
  assert.equal(empty.reimbursements.announceAsZero, true);
  assert.equal(empty.refunds.display, '$0.00');
  assert.equal(empty.refunds.announceAsZero, true);

  const active = buildNonSpendingMetrics({ reimbursementTotal: 142.5, refundTotal: 28.4 });
  assert.equal(active.reimbursements.display, '$142.50');
  assert.equal(active.reimbursements.announceAsZero, false);
  assert.equal(active.refunds.display, '-$28.40');
  assert.equal(active.refunds.announceAsZero, false);
});

test('loading metric state avoids numeric placeholders', () => {
  const loading = loadingSpendingMetric('Tax Deductible');
  assert.equal(loading.kind, 'loading');
  assert.equal(loading.display, '…');
  assert.equal(loading.accessibilityLabel, 'Tax Deductible, loading');
  assert.doesNotMatch(loading.display, /\$0|^0$/);
});

test('computed money metric helper preserves signed credit formatting', () => {
  assert.equal(computedMoneyMetric(0, { signedCredit: true }).display, '$0.00');
  assert.equal(computedMoneyMetric(12.5, { signedCredit: true }).display, '-$12.50');
  assert.equal(untrackedSpendingMetric('Transfers').display, UNTRACKED_METRIC_LABEL);
});

test('spending screen wires non-spending rows through spending-metrics helper', () => {
  assert.match(spendingSource, /buildNonSpendingMetrics/);
  assert.doesNotMatch(spendingSource, /label="Tax Deductible"\s+value="\$0"/);
  assert.doesNotMatch(spendingSource, /label="Transfers"\s+value="0"/);
  assert.match(spendingSource, /testID="spending-non-spending-tax-deductible"/);
  assert.match(spendingSource, /testID="spending-non-spending-transfers"/);
  assert.match(spendingSource, /nonSpending\.taxDeductible\.accessibilityLabel/);
  assert.match(spendingSource, /nonSpending\.transfers\.accessibilityLabel/);
});

test('spending screen preserves PR-19 finance-date hooks for period windows', () => {
  assert.match(spendingSource, /useFinanceToday/);
  assert.match(spendingSource, /useSelectedMonth/);
  assert.match(spendingSource, /periodWindow\(/);
  assert.doesNotMatch(spendingSource, /new Date\(\)\.toISOString\(\)/);
});
