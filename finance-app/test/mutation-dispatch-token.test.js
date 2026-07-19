const test = require('node:test');
const assert = require('node:assert/strict');
const {
  bumpMutationHookEpoch,
  captureMutationDispatchToken,
  invalidateMutationDispatch,
  isMutationDispatchTokenCurrent,
} = require('../src/lib/mutation-hook-identity');
const { createMutationDispatchGuard } = require('../src/lib/mutation-dispatch-guard');

test('dispatch token rejects superseded dispatch id within same identity', () => {
  const epochRef = { value: 0 };
  const dispatchIdRef = { value: 0 };
  const tokenA = captureMutationDispatchToken(epochRef, dispatchIdRef, 'scope', 1, 'form');
  const tokenB = captureMutationDispatchToken(epochRef, dispatchIdRef, 'scope', 1, 'form');
  assert.equal(isMutationDispatchTokenCurrent(tokenA, epochRef, dispatchIdRef, 'scope', 1, 'form'), false);
  assert.equal(isMutationDispatchTokenCurrent(tokenB, epochRef, dispatchIdRef, 'scope', 1, 'form'), true);
});

test('identity epoch bump invalidates prior dispatch token even with matching dispatch id', () => {
  const epochRef = { value: 0 };
  const dispatchIdRef = { value: 0 };
  const token = captureMutationDispatchToken(epochRef, dispatchIdRef, 'scope', 1, 'form');
  bumpMutationHookEpoch(epochRef);
  invalidateMutationDispatch(dispatchIdRef);
  assert.equal(isMutationDispatchTokenCurrent(token, epochRef, dispatchIdRef, 'scope', 1, 'form'), false);
});

test('callbacks within one dispatch stay valid until a newer dispatch starts', () => {
  const guard = createMutationDispatchGuard();
  const tokenA = guard.capture();
  assert.equal(guard.isCurrent(tokenA), true);
  guard.startDispatch(tokenA);
  assert.equal(guard.isCurrent(tokenA), true);
  const settled = guard.settle(tokenA);
  assert.equal(settled.applied, true);
  assert.equal(guard.isCurrent(tokenA), true);
  const tokenB = guard.capture();
  assert.equal(guard.isCurrent(tokenA), false);
  assert.equal(guard.isCurrent(tokenB), true);
});

test('A error-await settle B A-resume cannot overwrite B outcome', async () => {
  const guard = createMutationDispatchGuard();
  const tokenA = guard.capture();
  guard.startDispatch(tokenA);

  let resolveRefetch;
  const refetch = () => new Promise((resolve) => { resolveRefetch = resolve; });

  const errorTask = guard.applyErrorOutcome(tokenA, refetch);
  const settledA = guard.settle(tokenA);
  assert.equal(settledA.applied, true);
  assert.equal(guard.isLocked(), false);

  const tokenB = guard.capture();
  guard.startDispatch(tokenB);
  guard.applyOutcome(tokenB, 'outcome-B');
  assert.equal(guard.getOutcome(), 'outcome-B');

  resolveRefetch(true);
  await errorTask;
  guard.applyOutcome(tokenA, 'outcome-A-stale');
  assert.equal(guard.getOutcome(), 'outcome-B');
});

test('A onSettled unlock cannot let A refetch continuation mutate after B dispatch', async () => {
  const guard = createMutationDispatchGuard();
  const tokenA = guard.capture();
  guard.startDispatch(tokenA);

  let resolveRefetch;
  const refetch = () => new Promise((resolve) => { resolveRefetch = () => resolve(true); });

  const pendingError = guard.applyErrorOutcome(tokenA, refetch);
  guard.settle(tokenA);

  const tokenB = guard.capture();
  guard.startDispatch(tokenB);
  assert.equal(guard.applyOutcome(tokenB, 'B'), true);

  resolveRefetch();
  await pendingError;
  assert.equal(guard.applyOutcome(tokenA, 'A-stale'), false);
  assert.equal(guard.getOutcome(), 'B');
});

test('identity reset invalidates in-flight dispatch callbacks', () => {
  const guard = createMutationDispatchGuard();
  const token = guard.capture();
  guard.startDispatch(token);
  guard.resetIdentity();
  assert.equal(guard.isCurrent(token), false);
  assert.equal(guard.applyOutcome(token, 'stale'), false);
});
