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
  const normalizedIncompleteReasons = [...new Set(
    incompleteReasons.filter((reason) => typeof reason === 'string' && reason.length > 0)
  )];
  return {
    value: isComplete ? value : null,
    valueCents: isComplete ? valueCents : null,
    complete: isComplete,
    incompleteReasons: isComplete ? [] : normalizedIncompleteReasons,
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
