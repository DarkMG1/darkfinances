'use strict';

function buildForecastStsContainment({ incompleteReasons = [], complete } = {}) {
  const reasons = [...incompleteReasons];
  return {
    complete: complete != null ? !!complete : reasons.length === 0,
    incompleteReasons: reasons,
  };
}

function buildForecastProjectionContainment({
  stsContainment,
  withholdGraphEvents,
  knownEventCount = 0,
} = {}) {
  const knownEventsIncludedDespiteStsIncomplete = !withholdGraphEvents
    && !stsContainment.complete
    && knownEventCount > 0;
  const projectionIncompleteReasons = [
    ...(withholdGraphEvents ? ['obligation_graph_incomplete'] : []),
    ...(!stsContainment.complete ? stsContainment.incompleteReasons : []),
  ];
  return {
    complete: stsContainment.complete && !withholdGraphEvents,
    stsContainmentIncomplete: !stsContainment.complete,
    graphEventsWithheld: withholdGraphEvents,
    ...(knownEventsIncludedDespiteStsIncomplete ? { knownEventsIncludedDespiteStsIncomplete: true } : {}),
    incompleteReasons: projectionIncompleteReasons,
  };
}

function forecastContainmentWarnings({
  stsContainment,
  projectionContainment,
  obligationGraphIncompleteReasons = [],
  obligationSnapshotIncompleteReasons = [],
} = {}) {
  const warnings = [];
  if (projectionContainment.graphEventsWithheld) {
    warnings.push('Obligation graph incomplete; scheduled cash events withheld.');
    for (const reason of [
      ...obligationGraphIncompleteReasons,
      ...obligationSnapshotIncompleteReasons.filter((reason) => String(reason).startsWith('obligation_')),
    ]) {
      warnings.push(`Obligation graph: ${reason}`);
    }
  }
  if (!stsContainment.complete) {
    warnings.push('Safe-to-Spend containment incomplete; budget and goal commitments may be omitted from this projection.');
    for (const reason of stsContainment.incompleteReasons) {
      warnings.push(`Safe-to-Spend: ${reason}`);
    }
  }
  if (projectionContainment.knownEventsIncludedDespiteStsIncomplete) {
    warnings.push('Known obligation graph cash events are included while Safe-to-Spend containment remains incomplete.');
  }
  return warnings;
}

module.exports = {
  buildForecastProjectionContainment,
  buildForecastStsContainment,
  forecastContainmentWarnings,
};
