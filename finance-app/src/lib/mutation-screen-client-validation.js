const { mapClientValidationOutcome } = require('./mutation-form-errors');

function clearScreenActionRetryVars(entry) {
  if (!entry) return;
  entry.lastVars = null;
  entry.lastSuccess = undefined;
  entry.lastSettled = undefined;
  entry.lastError = undefined;
  entry.rollback = undefined;
}

/**
 * @param {Map<string, { lastVars: unknown }>} registry
 */
function buildScreenClientValidationOutcome(summary, fieldErrors, fieldOrder, actionKey, registry) {
  const mapped = mapClientValidationOutcome(fieldErrors, fieldOrder);
  if (actionKey) {
    clearScreenActionRetryVars(registry.get(actionKey));
  }
  return {
    activeKey: actionKey ?? null,
    outcome: { ...mapped, summary },
    announce: summary,
  };
}

module.exports = {
  buildScreenClientValidationOutcome,
  clearScreenActionRetryVars,
};
