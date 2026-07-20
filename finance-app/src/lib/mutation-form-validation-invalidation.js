const { mutationFieldsEqual } = require('./mutation-fields-equal.js');

/** Snapshot fields at client/API validation failure so edits invalidate stale outcomes. */
function captureValidationFieldSnapshot(fields) {
  return { ...fields };
}

function shouldInvalidateValidationOutcome(phase, outcome, fields, submittedSnapshot) {
  if (phase !== 'error' || !outcome || !submittedSnapshot) return false;
  return !mutationFieldsEqual(fields, submittedSnapshot);
}

module.exports = {
  captureValidationFieldSnapshot,
  shouldInvalidateValidationOutcome,
};
