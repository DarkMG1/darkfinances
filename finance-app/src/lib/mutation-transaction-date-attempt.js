/**
 * Resolve the date string shown in the picker and sent to the mutation.
 * Grid/shortcut picks always commit the attempted date to local state before dispatch.
 */
function resolveTransactionDateAttempt(dateText, picked) {
  const next = (picked || dateText || '').trim();
  return { next, dateText: next };
}

module.exports = {
  resolveTransactionDateAttempt,
};
