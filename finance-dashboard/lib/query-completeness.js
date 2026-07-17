'use strict';

const { metricValue } = require('./metric-provenance');

const QUERY_INCOMPLETE_REASON = Object.freeze({
  ledgerScanIncomplete: 'ledger_scan_incomplete',
  netWorthHistoryIncomplete: 'net_worth_history_incomplete',
  repaymentSuggestionsUnavailable: 'repayment_suggestions_unavailable',
});

function boundedLifetimeMetric({
  metric,
  value,
  valueCents,
  complete,
  incompleteReasons = [],
  lowerBound = null,
  lowerBoundLabel = 'at least',
  asOf,
  financeDate,
  sources = [],
  method,
  excludes = [],
}) {
  const base = metricValue({
    metric,
    value: complete ? value : null,
    valueCents: complete ? valueCents : null,
    complete: complete === true,
    incompleteReasons,
    asOf,
    financeDate,
    sources,
    method,
    excludes,
  });
  if (base.complete || lowerBound == null) return base;
  return {
    ...base,
    lowerBound,
    lowerBoundLabel,
  };
}

module.exports = {
  QUERY_INCOMPLETE_REASON,
  boundedLifetimeMetric,
};
