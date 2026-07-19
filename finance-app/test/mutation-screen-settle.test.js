const test = require('node:test');
const assert = require('node:assert/strict');
const {
  applyMutationScreenSettled,
  resetMutationScreenIdentityState,
} = require('../src/lib/mutation-screen-settle');
const {
  bumpMutationHookEpoch,
  captureMutationDispatchToken,
  invalidateMutationDispatch,
  isMutationDispatchTokenCurrent,
} = require('../src/lib/mutation-hook-identity');

test('stale onSettled does not decrement lock, clear pending key, or invoke callback', () => {
  let settledCalled = false;
  const before = {
    pendingLockCount: 1,
    pendingKeys: new Set(['action-a']),
    dispatchPending: true,
  };
  const after = applyMutationScreenSettled(before, {
    key: 'action-a',
    isTokenCurrent: false,
    onSettled: () => { settledCalled = true; },
  });
  assert.equal(after.settledApplied, false);
  assert.equal(after.onSettledCalled, false);
  assert.equal(settledCalled, false);
  assert.equal(after.pendingLockCount, 1);
  assert.deepEqual([...after.pendingKeys], ['action-a']);
  assert.equal(after.dispatchPending, true);
});

test('current onSettled unlocks and invokes callback once', () => {
  let settledCalled = false;
  const after = applyMutationScreenSettled({
    pendingLockCount: 1,
    pendingKeys: new Set(['action-b']),
    dispatchPending: true,
  }, {
    key: 'action-b',
    isTokenCurrent: true,
    onSettled: () => { settledCalled = true; },
  });
  assert.equal(after.settledApplied, true);
  assert.equal(settledCalled, true);
  assert.equal(after.pendingLockCount, 0);
  assert.deepEqual([...after.pendingKeys], []);
  assert.equal(after.dispatchPending, false);
});

test('old A settle after identity reset does not unlock new B dispatch', () => {
  const epochRef = { value: 0 };
  const dispatchIdRef = { value: 0 };
  const tokenA = captureMutationDispatchToken(epochRef, dispatchIdRef, 'scope', 1, 'screen');

  bumpMutationHookEpoch(epochRef);
  invalidateMutationDispatch(dispatchIdRef);

  const tokenB = captureMutationDispatchToken(epochRef, dispatchIdRef, 'scope', 1, 'screen');
  let pendingLockCount = 1;
  let pendingKeys = new Set(['action-b']);

  const staleSettle = applyMutationScreenSettled({
    pendingLockCount,
    pendingKeys,
    dispatchPending: true,
  }, {
    key: 'action-a',
    isTokenCurrent: isMutationDispatchTokenCurrent(tokenA, epochRef, dispatchIdRef, 'scope', 1, 'screen'),
  });

  assert.equal(staleSettle.settledApplied, false);
  assert.equal(staleSettle.pendingLockCount, 1);
  assert.deepEqual([...staleSettle.pendingKeys], ['action-b']);

  let dispatchC = false;
  if (staleSettle.pendingLockCount === 0) dispatchC = true;
  assert.equal(dispatchC, false);

  const freshSettle = applyMutationScreenSettled({
    pendingLockCount: staleSettle.pendingLockCount,
    pendingKeys: staleSettle.pendingKeys,
    dispatchPending: true,
  }, {
    key: 'action-b',
    isTokenCurrent: isMutationDispatchTokenCurrent(tokenB, epochRef, dispatchIdRef, 'scope', 1, 'screen'),
  });
  assert.equal(freshSettle.settledApplied, true);
  assert.equal(freshSettle.pendingLockCount, 0);
  assert.deepEqual([...freshSettle.pendingKeys], []);
});

test('identity reset clears pending keys so isLocked agrees with counter', () => {
  const state = resetMutationScreenIdentityState({
    pendingLockCount: 2,
    pendingKeys: new Set(['x', 'y']),
    dispatchPending: true,
    activeKey: 'x',
  });
  assert.equal(state.pendingLockCount, 0);
  assert.deepEqual([...state.pendingKeys], []);
  assert.equal(state.dispatchPending, false);
  assert.equal(state.activeKey, null);
  assert.equal(state.pendingKeys.size > 0, state.pendingLockCount > 0);
});
