const SPENDING_AMOUNT_EPSILON = 0.005;
const UNTRACKED_METRIC_LABEL = 'Not tracked';
const UNAVAILABLE_METRIC_LABEL = 'Unavailable';
const NO_TARGET_LABEL = 'No target set';

function isNegligibleAmount(amount) {
  return Math.abs(amount) < SPENDING_AMOUNT_EPSILON;
}

function coerceFiniteAmount(value) {
  if (value == null) return null;
  const n = Number(value);
  return Number.isFinite(n) ? n : null;
}

function fmtPosPlain(n) {
  return `$${Math.abs(n).toLocaleString('en-US', { minimumFractionDigits: 2, maximumFractionDigits: 2 })}`;
}

function computedMoneyMetric(amount, { signedCredit = false, signed = false, label } = {}) {
  const finite = coerceFiniteAmount(amount);
  if (finite == null) {
    return label ? unavailableSpendingMetric(label) : unavailableSpendingMetric('Amount');
  }
  const zero = isNegligibleAmount(finite);
  let display = fmtPosPlain(finite);
  if (!zero && signed && finite < 0) display = `-${fmtPosPlain(finite)}`;
  else if (!zero && signedCredit) display = `-${fmtPosPlain(finite)}`;
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

function unavailableSpendingMetric(label) {
  return {
    kind: 'unavailable',
    display: UNAVAILABLE_METRIC_LABEL,
    accessibilityLabel: `${label}, unavailable`,
  };
}

function loadingSpendingMetric(label) {
  return {
    kind: 'loading',
    display: '…',
    accessibilityLabel: `${label}, loading`,
  };
}

function buildReimbursementMetric({ fronted, isLoading, isError, hasData }) {
  if (isLoading && !hasData) return loadingSpendingMetric('Reimbursements');
  if ((isError && !hasData) || !hasData) return unavailableSpendingMetric('Reimbursements');
  const amount = coerceFiniteAmount(fronted);
  if (amount == null) return unavailableSpendingMetric('Reimbursements');
  return computedMoneyMetric(amount);
}

function buildNonSpendingMetrics({ reimbursement, refundTotal }) {
  return {
    taxDeductible: untrackedSpendingMetric('Tax Deductible'),
    reimbursements: buildReimbursementMetric(reimbursement),
    refunds: computedMoneyMetric(refundTotal, { signedCredit: true, label: 'Refunds & Credits' }),
    transfers: untrackedSpendingMetric('Transfers'),
  };
}

function buildBudgetMetrics({ data, isLoading, isError, totalSpend }) {
  const hasData = data != null;

  if (isLoading && !hasData) {
    return {
      kind: 'loading',
      left: loadingSpendingMetric('Left for spending'),
      pctLabel: '…',
      showProgress: false,
      progressPct: 0,
      showRetry: false,
    };
  }

  if (isError && !hasData) {
    return {
      kind: 'error',
      left: unavailableSpendingMetric('Left for spending'),
      pctLabel: UNAVAILABLE_METRIC_LABEL,
      showProgress: false,
      progressPct: 0,
      showRetry: true,
    };
  }

  if (!hasData || data.supported === false) {
    return {
      kind: data?.supported === false ? 'unsupported' : 'missing',
      left: untrackedSpendingMetric('Left for spending'),
      pctLabel: UNTRACKED_METRIC_LABEL,
      showProgress: false,
      progressPct: 0,
      showRetry: false,
    };
  }

  const target = coerceFiniteAmount(data.totalTarget ?? data.totalBudgeted) ?? 0;
  const remaining = coerceFiniteAmount(data.totalRemaining);
  const spent = coerceFiniteAmount(data.totalSpent ?? totalSpend);

  if (remaining == null || spent == null) {
    return {
      kind: 'invalid',
      left: unavailableSpendingMetric('Left for spending'),
      pctLabel: UNAVAILABLE_METRIC_LABEL,
      showProgress: false,
      progressPct: 0,
      showRetry: false,
    };
  }

  const hasTarget = target > SPENDING_AMOUNT_EPSILON;
  const pct = hasTarget ? Math.min(100, Math.max(0, (spent / target) * 100)) : null;

  return {
    kind: 'ready',
    left: computedMoneyMetric(remaining, { signed: true }),
    pctLabel: hasTarget ? `${pct.toFixed(0)}% of target used` : NO_TARGET_LABEL,
    showProgress: hasTarget,
    progressPct: pct ?? 0,
    showRetry: false,
  };
}

module.exports = {
  SPENDING_AMOUNT_EPSILON,
  UNTRACKED_METRIC_LABEL,
  UNAVAILABLE_METRIC_LABEL,
  NO_TARGET_LABEL,
  buildBudgetMetrics,
  buildNonSpendingMetrics,
  buildReimbursementMetric,
  computedMoneyMetric,
  coerceFiniteAmount,
  loadingSpendingMetric,
  unavailableSpendingMetric,
  untrackedSpendingMetric,
  isNegligibleAmount,
  fmtPosPlain,
};
