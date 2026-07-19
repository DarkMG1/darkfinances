const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const path = require('path');
const {
  bumpMutationHookEpoch,
  captureMutationDispatchToken,
  invalidateMutationDispatch,
  isMutationDispatchTokenCurrent,
  MAX_SAFE_DISPATCH_ID,
  nextMutationDispatchId,
  resetMutationHookPendingLock,
} = require('../src/lib/mutation-hook-identity');

test('dispatch token rejects stale epoch after profile identity bump', () => {
  const epochRef = { value: 0 };
  const dispatchIdRef = { value: 0 };
  const token = captureMutationDispatchToken(epochRef, dispatchIdRef, 'scope-a', 1, 'form-1');
  bumpMutationHookEpoch(epochRef);
  invalidateMutationDispatch(dispatchIdRef);
  assert.equal(isMutationDispatchTokenCurrent(token, epochRef, dispatchIdRef, 'scope-a', 1, 'form-1'), false);
});

test('dispatch token rejects scope or generation drift', () => {
  const epochRef = { value: 0 };
  const dispatchIdRef = { value: 0 };
  const token = captureMutationDispatchToken(epochRef, dispatchIdRef, 'scope-a', 1, 'form-1');
  assert.equal(isMutationDispatchTokenCurrent(token, epochRef, dispatchIdRef, 'scope-b', 1, 'form-1'), false);
  assert.equal(isMutationDispatchTokenCurrent(token, epochRef, dispatchIdRef, 'scope-a', 2, 'form-1'), false);
  assert.equal(isMutationDispatchTokenCurrent(token, epochRef, dispatchIdRef, 'scope-a', 1, 'form-2'), false);
});

test('old settled callback cannot unlock a newer pending lock after epoch bump', () => {
  const epochRef = { value: 0 };
  const dispatchIdRef = { value: 0 };
  const pendingLockRef = { value: true };
  const firstToken = captureMutationDispatchToken(epochRef, dispatchIdRef, 'demo', 0, 'add');
  bumpMutationHookEpoch(epochRef);
  invalidateMutationDispatch(dispatchIdRef);
  pendingLockRef.value = true;
  const secondToken = captureMutationDispatchToken(epochRef, dispatchIdRef, 'demo', 0, 'add');
  if (isMutationDispatchTokenCurrent(firstToken, epochRef, dispatchIdRef, 'demo', 0, 'add')) {
    pendingLockRef.value = false;
  }
  assert.equal(pendingLockRef.value, true);
  if (isMutationDispatchTokenCurrent(secondToken, epochRef, dispatchIdRef, 'demo', 0, 'add')) {
    pendingLockRef.value = false;
  }
  assert.equal(pendingLockRef.value, false);
});

test('identity reset clears pending lock refs', () => {
  const pendingLockRef = { value: true };
  resetMutationHookPendingLock(pendingLockRef, 'boolean');
  assert.equal(pendingLockRef.value, false);
  pendingLockRef.value = 3;
  resetMutationHookPendingLock(pendingLockRef, 'counter');
  assert.equal(pendingLockRef.value, 0);
});

test('hook sources reset pending locks and guard callbacks on identity change', () => {
  const form = require('fs').readFileSync(require('path').join(__dirname, '../src/hooks/useMutationForm.ts'), 'utf8');
  const action = require('fs').readFileSync(require('path').join(__dirname, '../src/hooks/useMutationAction.ts'), 'utf8');
  const screen = require('fs').readFileSync(require('path').join(__dirname, '../src/hooks/useMutationScreen.ts'), 'utf8');
  for (const [label, source] of [['form', form], ['action', action], ['screen', screen]]) {
    assert.match(source, /useMutationHookIdentity/, `${label} uses shared identity hook`);
    assert.match(source, /isDispatchTokenCurrent\(token\)/, `${label} guards async callbacks with dispatch token`);
    assert.match(source, /onSettled:/, `${label} unlocks in onSettled`);
  }
  const identityHook = require('fs').readFileSync(require('path').join(__dirname, '../src/hooks/useMutationHookIdentity.ts'), 'utf8');
  assert.match(identityHook, /prevIdentityKeyRef/);
  assert.match(identityHook, /if \(prevIdentityKeyRef\.current !== identityKey\)/);
  assert.match(identityHook, /bumpMutationHookEpoch\(epochRef\)/);
  assert.match(identityHook, /invalidateMutationDispatch\(dispatchIdRef, epochRef\)/);
  assert.match(identityHook, /resetMutationHookPendingLock/);
  assert.doesNotMatch(identityHook, /useEffect\(\(\) => \{\s*bumpMutationHookEpoch/);
  assert.match(identityHook, /useEffect\(\(\) => \(\) => \{/);
});

test('identity transition invalidates dispatch tokens synchronously before passive effect', () => {
  const {
    bumpMutationHookEpoch,
    captureMutationDispatchToken,
    invalidateMutationDispatch,
    isMutationDispatchTokenCurrent,
  } = require('../src/lib/mutation-hook-identity');

  const epochRef = { value: 0 };
  const dispatchIdRef = { value: 0 };
  const token = captureMutationDispatchToken(epochRef, dispatchIdRef, 'scope-a', 1, 'form-1');

  bumpMutationHookEpoch(epochRef);
  invalidateMutationDispatch(dispatchIdRef, epochRef);

  assert.equal(isMutationDispatchTokenCurrent(token, epochRef, dispatchIdRef, 'scope-a', 1, 'form-1'), false);

  const nextToken = captureMutationDispatchToken(epochRef, dispatchIdRef, 'scope-a', 1, 'form-1');
  assert.equal(isMutationDispatchTokenCurrent(nextToken, epochRef, dispatchIdRef, 'scope-a', 1, 'form-1'), true);
});

test('form and action hooks ignore stale react-query isPending for lock and dispatch', () => {
  const form = fs.readFileSync(path.join(__dirname, '../src/hooks/useMutationForm.ts'), 'utf8');
  const action = fs.readFileSync(path.join(__dirname, '../src/hooks/useMutationAction.ts'), 'utf8');
  assert.doesNotMatch(form, /isLocked = mutation\.isPending/);
  assert.doesNotMatch(action, /isLocked = mutation\.isPending/);
  assert.doesNotMatch(form, /mutation\.isPending \|\| phase/);
  assert.doesNotMatch(action, /pendingLockRef\.current \|\| mutation\.isPending/);
});

test('mutation hooks use shared activation sequence module', () => {
  for (const rel of ['useMutationForm.ts', 'useMutationAction.ts', 'useMutationScreen.ts']) {
    const source = fs.readFileSync(path.join(__dirname, '../src/hooks', rel), 'utf8');
    assert.match(source, /nextMutationActivationSeq/, `${rel} must use shared activation sequence`);
    assert.doesNotMatch(source, /activitySeqRef/, `${rel} must not keep per-hook activation counters`);
  }
});

test('dispatch id rolls epoch and resets before Number precision loss', () => {
  const epochRef = { value: 0 };
  const dispatchIdRef = { value: MAX_SAFE_DISPATCH_ID - 2 };
  const penultimate = nextMutationDispatchId(dispatchIdRef, epochRef);
  assert.equal(penultimate, MAX_SAFE_DISPATCH_ID - 1);
  assert.equal(epochRef.value, 0);

  const staleToken = {
    epoch: epochRef.value,
    dispatchId: penultimate,
    scope: 'demo',
    generation: 0,
    formId: 'form',
  };

  const rolled = nextMutationDispatchId(dispatchIdRef, epochRef);
  assert.equal(rolled, 1);
  assert.equal(dispatchIdRef.value, 1);
  assert.equal(epochRef.value, 1);

  assert.equal(
    isMutationDispatchTokenCurrent(staleToken, epochRef, dispatchIdRef, 'demo', 0, 'form'),
    false,
  );
  const freshToken = captureMutationDispatchToken(epochRef, dispatchIdRef, 'demo', 0, 'form');
  assert.equal(
    isMutationDispatchTokenCurrent(freshToken, epochRef, dispatchIdRef, 'demo', 0, 'form'),
    true,
  );
});
