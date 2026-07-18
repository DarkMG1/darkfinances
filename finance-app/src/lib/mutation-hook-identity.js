/**
 * Epoch + scope/generation/form identity + per-dispatch id guards for mutation hook async callbacks.
 */

function nextMutationDispatchId(dispatchIdRef) {
  dispatchIdRef.value += 1;
  return dispatchIdRef.value;
}

function invalidateMutationDispatch(dispatchIdRef) {
  return nextMutationDispatchId(dispatchIdRef);
}

function captureMutationDispatchToken(epochRef, dispatchIdRef, scope, generation, formId) {
  const dispatchId = nextMutationDispatchId(dispatchIdRef);
  return {
    epoch: epochRef.value,
    dispatchId,
    scope: String(scope || 'demo'),
    generation: Number(generation ?? 0),
    formId: formId == null ? undefined : String(formId),
  };
}

function isMutationDispatchTokenCurrent(token, epochRef, dispatchIdRef, scope, generation, formId) {
  if (!token || token.epoch !== epochRef.value) return false;
  if (token.dispatchId !== dispatchIdRef.value) return false;
  if (token.scope !== String(scope || 'demo')) return false;
  if (token.generation !== Number(generation ?? 0)) return false;
  if (token.formId !== undefined && token.formId !== String(formId ?? '')) return false;
  return true;
}

function bumpMutationHookEpoch(epochRef) {
  epochRef.value += 1;
  return epochRef.value;
}

function resetMutationHookPendingLock(pendingLockRef, kind = 'boolean') {
  if (kind === 'counter') pendingLockRef.value = 0;
  else pendingLockRef.value = false;
}

module.exports = {
  bumpMutationHookEpoch,
  captureMutationDispatchToken,
  invalidateMutationDispatch,
  isMutationDispatchTokenCurrent,
  nextMutationDispatchId,
  resetMutationHookPendingLock,
};
