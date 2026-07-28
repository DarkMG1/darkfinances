'use strict';

const { mergeProjectionCompleteness } = require('./projection-completeness');

function attachSpendingProjectionIncompleteness(completeness, spendingProjection) {
  if (!spendingProjection?.incompleteReasons?.length) return completeness;
  return {
    ...completeness,
    complete: false,
    incompleteReasons: [
      ...new Set([...(completeness?.incompleteReasons || []), ...spendingProjection.incompleteReasons]),
    ],
  };
}

function buildSpendingCompletenessViews({ current, previous, spendingProjection }) {
  const currentCompleteness = attachSpendingProjectionIncompleteness(current.completeness, spendingProjection);
  const comparisonCompleteness = attachSpendingProjectionIncompleteness(
    mergeProjectionCompleteness([current.completeness, previous.completeness]),
    spendingProjection,
  );
  return {
    completeness: currentCompleteness,
    comparisonCompleteness,
    current: { ...current, completeness: currentCompleteness },
  };
}

module.exports = {
  attachSpendingProjectionIncompleteness,
  buildSpendingCompletenessViews,
};
