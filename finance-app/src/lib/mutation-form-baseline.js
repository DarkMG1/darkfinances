/**
 * Baseline resolution for useMutationForm identity initialization.
 */

function resolveMutationFormBaseline(fields, draft) {
  const base = { ...fields };
  if (draft && typeof draft === 'object') {
    return { ...base, ...draft };
  }
  return base;
}

function canStartMutationFormDispatch({ pendingLock, dispatchPending, phase }) {
  if (pendingLock) return false;
  if (dispatchPending) return false;
  if (phase === 'submitting' || phase === 'reconciling') return false;
  return true;
}

function canStartMutationActionDispatch({ pendingLock, dispatchPending }) {
  if (pendingLock) return false;
  if (dispatchPending) return false;
  return true;
}

module.exports = {
  canStartMutationActionDispatch,
  canStartMutationFormDispatch,
  resolveMutationFormBaseline,
};
