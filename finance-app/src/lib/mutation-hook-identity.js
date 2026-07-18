/**
 * Epoch + scope/generation/form identity + per-dispatch id guards for mutation hook async callbacks.
 */

const MAX_SAFE_DISPATCH_ID = Number.MAX_SAFE_INTEGER - 1024;

function nextMutationDispatchId(dispatchIdRef, epochRef) {
  dispatchIdRef.value += 1;
  if (dispatchIdRef.value >= MAX_SAFE_DISPATCH_ID) {
    bumpMutationHookEpoch(epochRef);
    dispatchIdRef.value = 1;
  }
  return dispatchIdRef.value;
}

function invalidateMutationDispatch(dispatchIdRef, epochRef) {
  return nextMutationDispatchId(dispatchIdRef, epochRef);
}

function captureMutationDispatchToken(epochRef, dispatchIdRef, scope, generation, formId) {
  const dispatchId = nextMutationDispatchId(dispatchIdRef, epochRef);
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
  MAX_SAFE_DISPATCH_ID,
  bumpMutationHookEpoch,
  captureMutationDispatchToken,
  invalidateMutationDispatch,
  isMutationDispatchTokenCurrent,
  nextMutationDispatchId,
  resetMutationHookPendingLock,
};
