'use strict';

function metricValue({
  metric,
  value,
  valueCents,
  complete,
  asOf = new Date().toISOString(),
  financeDate,
  sources = [],
  method,
  excludes = [],
  incompleteReasons = [],
}) {
  const isComplete = complete === true;
  return {
    value: isComplete ? value : null,
    valueCents: isComplete ? valueCents : null,
    complete: isComplete,
    incompleteReasons: isComplete ? [] : incompleteReasons,
    provenance: {
      metric,
      asOf,
      financeDate,
      sources,
      method,
      excludes,
    },
  };
}

module.exports = { metricValue };
