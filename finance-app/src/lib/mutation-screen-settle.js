/**
 * Pure settle + identity-reset helpers for useMutationScreen lock state.
 */

/**
 * @param {{ pendingLockCount: number; pendingKeys: Set<string>; dispatchPending: boolean }} state
 * @param {{ key: string; isTokenCurrent: boolean; onSettled?: () => void }} input
 */
function applyMutationScreenSettled(state, { key, isTokenCurrent, onSettled }) {
  if (!isTokenCurrent) {
    return { ...state, settledApplied: false, onSettledCalled: false };
  }
  const pendingLockCount = Math.max(0, state.pendingLockCount - 1);
  const pendingKeys = new Set(state.pendingKeys);
  pendingKeys.delete(key);
  const dispatchPending = pendingLockCount > 0;
  onSettled?.();
  return {
    pendingLockCount,
    pendingKeys,
    dispatchPending,
    settledApplied: true,
    onSettledCalled: true,
  };
}

/**
 * @param {{ pendingLockCount: number; pendingKeys: Set<string>; dispatchPending: boolean; activeKey: string | null }} state
 */
function resetMutationScreenIdentityState(state) {
  return {
    ...state,
    pendingLockCount: 0,
    pendingKeys: new Set(),
    dispatchPending: false,
    activeKey: null,
  };
}

module.exports = {
  applyMutationScreenSettled,
  resetMutationScreenIdentityState,
};
