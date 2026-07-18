/**
 * Pure in-memory simulation of mutation dispatch token guards for behavioral tests.
 */

const {
  bumpMutationHookEpoch,
  captureMutationDispatchToken,
  invalidateMutationDispatch,
  isMutationDispatchTokenCurrent,
  resetMutationHookPendingLock,
} = require('./mutation-hook-identity');

function createMutationDispatchGuard(options = {}) {
  const epochRef = { value: 0 };
  const dispatchIdRef = { value: 0 };
  const pendingLockRef = { value: options.pendingLockKind === 'counter' ? 0 : false };
  const pendingLockKind = options.pendingLockKind ?? 'boolean';
  let outcome = null;
  let locked = false;

  const scope = options.scope ?? 'scope';
  const generation = options.generation ?? 1;
  const formId = options.formId ?? 'form';

  function capture() {
    return captureMutationDispatchToken(epochRef, dispatchIdRef, scope, generation, formId);
  }

  function isCurrent(token) {
    return isMutationDispatchTokenCurrent(token, epochRef, dispatchIdRef, scope, generation, formId);
  }

  function startDispatch(token) {
    if (pendingLockKind === 'counter') pendingLockRef.value += 1;
    else pendingLockRef.value = true;
    locked = true;
    return token;
  }

  function settle(token) {
    if (!isCurrent(token)) return { applied: false };
    if (pendingLockKind === 'counter') {
      pendingLockRef.value = Math.max(0, pendingLockRef.value - 1);
      locked = pendingLockRef.value > 0;
    } else {
      pendingLockRef.value = false;
      locked = false;
    }
    return { applied: true, locked };
  }

  async function applyErrorOutcome(token, refetch) {
    if (!isCurrent(token)) return { applied: false };
    outcome = 'error';
    const ok = await refetch();
    if (!isCurrent(token)) return { applied: false, refetchOk: ok };
    if (ok) outcome = 'error-refetched';
    return { applied: true, refetchOk: ok };
  }

  function applyOutcome(token, value) {
    if (!isCurrent(token)) return false;
    outcome = value;
    return true;
  }

  function resetIdentity() {
    bumpMutationHookEpoch(epochRef);
    invalidateMutationDispatch(dispatchIdRef);
    resetMutationHookPendingLock(pendingLockRef, pendingLockKind);
    locked = false;
    outcome = null;
  }

  return {
    capture,
    isCurrent,
    startDispatch,
    settle,
    applyErrorOutcome,
    applyOutcome,
    resetIdentity,
    getOutcome: () => outcome,
    isLocked: () => locked,
    getDispatchId: () => dispatchIdRef.value,
  };
}

module.exports = {
  createMutationDispatchGuard,
};
