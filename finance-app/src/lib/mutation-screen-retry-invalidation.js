const { mutationFieldsEqual } = require('./mutation-fields-equal');

/**
 * When the user edits fields after a screen mutation error, discard stale retry payload.
 * @param {{ outcome: unknown; activeKey: string | null; clear: () => void }} screen
 * @param {string} actionKey
 * @param {Record<string, unknown> | null | undefined} submittedSnapshot
 * @param {Record<string, unknown>} currentFields
 */
function invalidateScreenRetryOnFieldEdit(screen, actionKey, submittedSnapshot, currentFields) {
  if (!screen.outcome || screen.activeKey !== actionKey || !submittedSnapshot) return false;
  if (mutationFieldsEqual(currentFields, submittedSnapshot)) return false;
  screen.clear();
  return true;
}

module.exports = {
  invalidateScreenRetryOnFieldEdit,
};
