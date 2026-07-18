const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const path = require('path');
const {
  NO_TARGET_LABEL,
  UNAVAILABLE_METRIC_LABEL,
  UNTRACKED_METRIC_LABEL,
  buildBudgetMetrics,
  buildNonSpendingMetrics,
  buildReimbursementMetric,
  computedMoneyMetric,
  loadingSpendingMetric,
  unavailableSpendingMetric,
  untrackedSpendingMetric,
} = require('../src/lib/spending-metrics');
const UNTRACKED_LABEL = '#9494a8';
const SURFACE = '#111118';

const spendingSource = fs.readFileSync(
  path.resolve(__dirname, '..', 'src', 'app', '(tabs)', 'spending.tsx'),
  'utf8',
);
const appRoot = path.resolve(__dirname, '..');

function luminance(hex) {
  const rgb = [0, 2, 4].map((i) => parseInt(hex.slice(i + 1, i + 3), 16) / 255)
    .map((c) => (c <= 0.03928 ? c / 12.92 : ((c + 0.055) / 1.055) ** 2.4));
  return 0.2126 * rgb[0] + 0.7152 * rgb[1] + 0.0722 * rgb[2];
}

function contrastRatio(fg, bg) {
  const l1 = luminance(fg);
  const l2 = luminance(bg);
  const hi = Math.max(l1, l2);
  const lo = Math.min(l1, l2);
  return (hi + 0.05) / (lo + 0.05);
}

test('untracked non-spending metrics never announce fabricated zero amounts', () => {
  const metrics = buildNonSpendingMetrics({
    reimbursement: { fronted: 0, isLoading: false, isError: false, hasData: true },
    refundTotal: 0,
  });

  assert.equal(metrics.taxDeductible.kind, 'untracked');
  assert.equal(metrics.taxDeductible.display, UNTRACKED_METRIC_LABEL);
  assert.equal(metrics.taxDeductible.accessibilityLabel, 'Tax Deductible, not tracked');
  assert.doesNotMatch(metrics.taxDeductible.display, /\$0/);

  assert.equal(metrics.transfers.kind, 'untracked');
  assert.equal(metrics.transfers.accessibilityLabel, 'Transfers, not tracked');
  assert.doesNotMatch(metrics.transfers.display, /^0$/);
});

test('budget metrics never fabricate zero while loading, errored, or unsupported', () => {
  const loading = buildBudgetMetrics({ data: undefined, isLoading: true, isError: false, totalSpend: 4321.5 });
  assert.equal(loading.left.kind, 'loading');
  assert.equal(loading.left.display, '…');
  assert.equal(loading.pctLabel, '…');
  assert.equal(loading.showProgress, false);
  assert.doesNotMatch(loading.left.display, /\$0/);

  const errored = buildBudgetMetrics({ data: undefined, isLoading: false, isError: true, totalSpend: 4321.5 });
  assert.equal(errored.left.kind, 'unavailable');
  assert.equal(errored.left.display, UNAVAILABLE_METRIC_LABEL);
  assert.equal(errored.pctLabel, UNAVAILABLE_METRIC_LABEL);
  assert.equal(errored.showRetry, true);
  assert.doesNotMatch(errored.left.display, /\$0/);

  const unsupported = buildBudgetMetrics({
    data: { supported: false, totalSpent: 0, totalRemaining: 0, groups: [] },
    isLoading: false,
    isError: false,
    totalSpend: 4321.5,
  });
  assert.equal(unsupported.left.display, UNTRACKED_METRIC_LABEL);
  assert.equal(unsupported.pctLabel, UNTRACKED_METRIC_LABEL);
  assert.equal(unsupported.showProgress, false);
  assert.doesNotMatch(unsupported.pctLabel, /0%/);
});

test('budget metrics distinguish no target, genuine zero remaining, and nonzero remaining', () => {
  const noTarget = buildBudgetMetrics({
    data: { supported: true, totalTarget: 0, totalBudgeted: 0, totalSpent: 1200, totalRemaining: -1200, groups: [{}] },
    isLoading: false,
    isError: false,
    totalSpend: 1200,
  });
  assert.equal(noTarget.pctLabel, NO_TARGET_LABEL);
  assert.equal(noTarget.showProgress, false);
  assert.doesNotMatch(noTarget.pctLabel, /0%/);

  const exhausted = buildBudgetMetrics({
    data: { supported: true, totalTarget: 5000, totalBudgeted: 5000, totalSpent: 5000, totalRemaining: 0, groups: [{}] },
    isLoading: false,
    isError: false,
    totalSpend: 5000,
  });
  assert.equal(exhausted.left.display, '$0.00');
  assert.equal(exhausted.left.announceAsZero, true);
  assert.equal(exhausted.pctLabel, '100% of target used');
  assert.equal(exhausted.showProgress, true);
  assert.equal(exhausted.progressPct, 100);

  const healthy = buildBudgetMetrics({
    data: { supported: true, totalTarget: 5000, totalBudgeted: 5000, totalSpent: 4150, totalRemaining: 850, groups: [{}] },
    isLoading: false,
    isError: false,
    totalSpend: 4150,
  });
  assert.equal(healthy.left.display, '$850.00');
  assert.equal(healthy.pctLabel, '83% of target used');
  assert.equal(healthy.showProgress, true);
});

test('reimbursement metric uses authoritative query states instead of spending category fallback', () => {
  assert.equal(
    buildReimbursementMetric({ fronted: undefined, isLoading: true, isError: false, hasData: false }).display,
    '…',
  );
  assert.equal(
    buildReimbursementMetric({ fronted: undefined, isLoading: false, isError: true, hasData: false }).display,
    UNAVAILABLE_METRIC_LABEL,
  );
  assert.equal(
    buildReimbursementMetric({ fronted: 142.5, isLoading: false, isError: false, hasData: true }).display,
    '$142.50',
  );
  assert.equal(
    buildReimbursementMetric({ fronted: 0, isLoading: false, isError: false, hasData: true }).display,
    '$0.00',
  );
  assert.equal(
    buildReimbursementMetric({ fronted: 0, isLoading: false, isError: false, hasData: true }).announceAsZero,
    true,
  );
});

test('computed money metric rejects NaN and non-finite payloads as unavailable', () => {
  for (const bad of [NaN, Infinity, -Infinity, null, undefined, 'nope']) {
    const metric = computedMoneyMetric(bad, { label: 'Refunds & Credits' });
    assert.equal(metric.kind, 'unavailable', `expected unavailable for ${String(bad)}`);
    assert.equal(metric.display, UNAVAILABLE_METRIC_LABEL);
    assert.doesNotMatch(metric.display, /\$NaN/);
  }
});

test('refunds keep signed credit formatting for genuine nonzero totals', () => {
  const empty = buildNonSpendingMetrics({
    reimbursement: { fronted: 0, isLoading: false, isError: false, hasData: true },
    refundTotal: 0,
  });
  assert.equal(empty.refunds.display, '$0.00');
  assert.equal(empty.refunds.announceAsZero, true);

  const active = buildNonSpendingMetrics({
    reimbursement: { fronted: 142.5, isLoading: false, isError: false, hasData: true },
    refundTotal: 28.4,
  });
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

test('accessibility labels cover unavailable and untracked metric states', () => {
  assert.equal(untrackedSpendingMetric('Transfers').accessibilityLabel, 'Transfers, not tracked');
  assert.equal(unavailableSpendingMetric('Reimbursements').accessibilityLabel, 'Reimbursements, unavailable');
  assert.equal(loadingSpendingMetric('Left for spending').accessibilityLabel, 'Left for spending, loading');
  assert.equal(computedMoneyMetric(12.5).accessibilityValue, '$12.50');
});

test('untracked label color meets WCAG AA on spending card surfaces', () => {
  const ratio = contrastRatio(UNTRACKED_LABEL, SURFACE);
  assert.ok(ratio >= 4.5, `untrackedLabel on surface contrast ${ratio.toFixed(2)}:1 should be >= 4.5:1`);
});

test('spending screen wires budget and reimbursement query state through spending-metrics helpers', () => {
  assert.match(spendingSource, /buildBudgetMetrics/);
  assert.match(spendingSource, /buildNonSpendingMetrics/);
  assert.match(spendingSource, /useReimbursement\(\{ from: selectedWindow\.start, to: selectedWindow\.end \}/);
  assert.match(spendingSource, /budgetMetrics\.left\.display/);
  assert.match(spendingSource, /reimb\.data\?\.summary\?\.fronted/);
  assert.doesNotMatch(spendingSource, /budgets\.data\?\.totalRemaining \?\? 0/);
  assert.doesNotMatch(spendingSource, /entries\.find\(\(\[cat\]\) => \/\^reimbursement\$\/i\.test\(cat\)\)/);
  assert.match(spendingSource, /testID="spending-non-spending-tax-deductible"/);
  assert.match(spendingSource, /colors\.untrackedLabel/);
});

test('spending screen preserves PR-19 finance-date hooks for period windows', () => {
  assert.match(spendingSource, /useFinanceToday/);
  assert.match(spendingSource, /useSelectedMonth/);
  assert.match(spendingSource, /periodWindow\(/);
  assert.doesNotMatch(spendingSource, /new Date\(\)\.toISOString\(\)/);
});

test('spending screen gates authoritative totals on projection completeness', () => {
  assert.match(spendingSource, /spendingComplete = cur\?\.completeness\?\.complete !== false/);
  assert.match(spendingSource, /totalSpend = spendingComplete && cur\?\.totalSpend != null \? cur\.totalSpend : null/);
  assert.match(spendingSource, /'Unavailable'/);
  assert.doesNotMatch(spendingSource, /cur\?\.totalSpend \?\? 0/);
  assert.doesNotMatch(spendingSource, /cur\?\.totalIncome \?\? 0/);
});

test('chart geometry preserves null incomplete trend values instead of coercing to zero', () => {
  const chartsSource = fs.readFileSync(path.join(appRoot, 'src/components/charts.tsx'), 'utf8');
  const cashflowSource = fs.readFileSync(path.join(appRoot, 'src/app/cashflow.tsx'), 'utf8');
  const budgetsSource = fs.readFileSync(path.join(appRoot, 'src/app/budgets.tsx'), 'utf8');
  assert.match(chartsSource, /ChartSeriesValue = number \| null/);
  assert.match(chartsSource, /income == null \|\| spend == null/);
  assert.match(chartsSource, /unavailable/);
  assert.doesNotMatch(cashflowSource, /m\.income : 0\)/);
  assert.doesNotMatch(cashflowSource, /m\.spend : 0\)/);
  assert.match(cashflowSource, /monthComplete\(m\) \? m\.income! : null/);
  assert.doesNotMatch(budgetsSource, /m\.income \?\? 0/);
  assert.doesNotMatch(budgetsSource, /m\.spend \?\? 0/);
  assert.doesNotMatch(spendingSource, /m\.income \?\? 0/);
  assert.doesNotMatch(spendingSource, /m\.spend \?\? 0/);
  assert.match(spendingSource, /incomeUnavailable/);
  assert.match(spendingSource, /unavailableBar/);
  assert.match(cashflowSource, /chartHasIncomplete/);
  assert.match(budgetsSource, /chartHasIncomplete/);
});

/**
 * Residual Spending fallbacks audit (post-remediation):
 * - Income/Total Spend/Net: null + Unavailable when projection completeness is incomplete.
 * - Chart net/netWorth: null buckets when trends month incomplete.
 * - Breakdown %: totalSpend > 0 guard — genuine computed.
 * - Refunds: refundEntries sum after spending gate — genuine computed; NaN guarded via computedMoneyMetric.
 * - Reimbursements: /api/v1/reimbursement summary.fronted for selectedWindow — independent query states.
 * - Budget card: buildBudgetMetrics — no ?? 0 display path; genuine $0.00 only when supported data with known target.
 */
