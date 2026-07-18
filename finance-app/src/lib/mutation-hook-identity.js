/**
 * Epoch + scope/generation/form identity guards for mutation hook async callbacks.
 */

function captureMutationDispatchToken(epochRef, scope, generation, formId) {
  return {
    epoch: epochRef.value,
    scope: String(scope || 'demo'),
    generation: Number(generation ?? 0),
    formId: formId == null ? undefined : String(formId),
  };
}

function isMutationDispatchTokenCurrent(token, epochRef, scope, generation, formId) {
  if (!token || token.epoch !== epochRef.value) return false;
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
  isMutationDispatchTokenCurrent,
  resetMutationHookPendingLock,
};
