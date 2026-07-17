const SPENDING_AMOUNT_EPSILON = 0.005;
const UNTRACKED_METRIC_LABEL = 'Not tracked';

function isNegligibleAmount(amount) {
  return Math.abs(amount) < SPENDING_AMOUNT_EPSILON;
}

function fmtPosPlain(n) {
  return `$${Math.abs(n).toLocaleString('en-US', { minimumFractionDigits: 2, maximumFractionDigits: 2 })}`;
}

function computedMoneyMetric(amount, { signedCredit = false } = {}) {
  const zero = isNegligibleAmount(amount);
  const display = !zero && signedCredit ? `-${fmtPosPlain(amount)}` : fmtPosPlain(amount);
  return {
    kind: 'computed',
    display,
    accessibilityValue: display,
    announceAsZero: zero,
  };
}

function untrackedSpendingMetric(label) {
  return {
    kind: 'untracked',
    display: UNTRACKED_METRIC_LABEL,
    accessibilityLabel: `${label}, not tracked`,
  };
}

function loadingSpendingMetric(label) {
  return {
    kind: 'loading',
    display: '…',
    accessibilityLabel: `${label}, loading`,
  };
}

function buildNonSpendingMetrics({ reimbursementTotal, refundTotal }) {
  return {
    taxDeductible: untrackedSpendingMetric('Tax Deductible'),
    reimbursements: computedMoneyMetric(reimbursementTotal),
    refunds: computedMoneyMetric(refundTotal, { signedCredit: true }),
    transfers: untrackedSpendingMetric('Transfers'),
  };
}

module.exports = {
  SPENDING_AMOUNT_EPSILON,
  UNTRACKED_METRIC_LABEL,
  buildNonSpendingMetrics,
  computedMoneyMetric,
  loadingSpendingMetric,
  untrackedSpendingMetric,
  isNegligibleAmount,
  fmtPosPlain,
};
