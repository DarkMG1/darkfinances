/**
 * Adversarial behavioral simulation of admission lease + dispatch token coupling.
 * Mirrors useMutationAdmissionLifecycle + useMutationHookIdentity + hook dispatch paths.
 */
const test = require('node:test');
const assert = require('node:assert/strict');
const {
  createMutationAdmissionRef,
  isMutationAdmissionBlocked,
  releaseMutationAdmission,
  resetAdmissionLeaseCounter,
  tryAcquireMutationAdmission,
} = require('../src/lib/mutation-screen-admission');
const {
  bumpMutationHookEpoch,
  captureMutationDispatchToken,
  invalidateMutationDispatch,
  isMutationDispatchTokenCurrent,
  resetMutationHookPendingLock,
} = require('../src/lib/mutation-hook-identity');

function createAdmissionLifecycleSim(admissionRef, identityKeyRef) {
  let admissionLease = null;
  let identityKey = identityKeyRef.value;

  const syncIdentityTransition = (nextKey) => {
    if (identityKeyRef.value === nextKey) return;
    identityKeyRef.value = nextKey;
    identityKey = nextKey;
    releaseHeld();
  };

  const releaseHeld = () => {
    const lease = admissionLease;
    admissionLease = null;
    if (lease != null) releaseMutationAdmission(admissionRef, lease);
  };

  const acquire = () => {
    const lease = tryAcquireMutationAdmission(admissionRef);
    if (lease == null) return null;
    admissionLease = lease;
    return lease;
  };

  const releaseForLease = (lease) => {
    if (admissionLease === lease) admissionLease = null;
    if (lease != null) releaseMutationAdmission(admissionRef, lease);
  };

  const onIdentityEffect = (nextKey) => {
    syncIdentityTransition(nextKey);
  };

  const onUnmount = () => {
    releaseHeld();
  };

  return {
    acquire,
    releaseForLease,
    releaseFromSettle: releaseForLease,
    releaseHeld,
    onIdentityEffect,
    onUnmount,
    getHeldLease: () => admissionLease,
    syncIdentityTransition,
  };
}

function createIdentitySim(options = {}) {
  const epochRef = { value: 0 };
  const dispatchIdRef = { value: 0 };
  const pendingLockRef = { value: options.pendingLockKind === 'counter' ? 0 : false };
  const pendingLockKind = options.pendingLockKind ?? 'boolean';
  let identityKey = options.identityKey ?? 'scope:1:form';
  let dispatchPending = false;
  const scope = options.scope ?? 'scope';
  const generation = options.generation ?? 1;
  const formId = options.formId ?? 'form';

  const syncRenderIdentityCheck = (nextKey) => {
    if (identityKey === nextKey) return;
    bumpMutationHookEpoch(epochRef);
    invalidateMutationDispatch(dispatchIdRef, epochRef);
    identityKey = nextKey;
  };

  const identityEffect = (nextKey) => {
    syncRenderIdentityCheck(nextKey);
    resetMutationHookPendingLock(pendingLockRef, pendingLockKind);
    dispatchPending = false;
  };

  const unmount = () => {
    bumpMutationHookEpoch(epochRef);
    invalidateMutationDispatch(dispatchIdRef, epochRef);
  };

  const captureToken = () => captureMutationDispatchToken(
    epochRef,
    dispatchIdRef,
    scope,
    generation,
    formId,
  );

  const isTokenCurrent = (token) => isMutationDispatchTokenCurrent(
    token,
    epochRef,
    dispatchIdRef,
    scope,
    generation,
    formId,
  );

  const onSettled = (token, lease, admissionSim) => {
    admissionSim.releaseForLease(lease);
    if (!isTokenCurrent(token)) return { unlocked: false };
    if (pendingLockKind === 'counter') {
      pendingLockRef.value = Math.max(0, pendingLockRef.value - 1);
      dispatchPending = pendingLockRef.value > 0;
    } else {
      pendingLockRef.value = false;
      dispatchPending = false;
    }
    return { unlocked: true };
  };

  const startDispatch = (admission) => {
    if (pendingLockRef.value === true || pendingLockRef.value > 0) return null;
    const lease = admission.acquire();
    if (lease == null) return null;
    const token = captureToken();
    if (pendingLockKind === 'counter') pendingLockRef.value += 1;
    else pendingLockRef.value = true;
    dispatchPending = true;
    return { token, lease };
  };

  const syncMutateThrow = (token, lease, admission) => {
    admission.releaseForLease(lease);
    pendingLockRef.value = pendingLockKind === 'counter'
      ? Math.max(0, pendingLockRef.value - 1)
      : false;
    if (pendingLockKind === 'counter') {
      dispatchPending = pendingLockRef.value > 0;
    } else {
      dispatchPending = false;
    }
    return { token, threw: true };
  };

  return {
    epochRef,
    dispatchIdRef,
    pendingLockRef,
    captureToken,
    isTokenCurrent,
    syncRenderIdentityCheck,
    identityEffect,
    unmount,
    onSettled,
    startDispatch,
    syncMutateThrow,
    getDispatchPending: () => dispatchPending,
    getIdentityKey: () => identityKey,
  };
}

test('normal settle: admission released before token-guarded unlock', () => {
  resetAdmissionLeaseCounter();
  const admissionRef = { current: createMutationAdmissionRef() };
  const identityKeyRef = { value: 'scope:1:form' };
  const admission = createAdmissionLifecycleSim(admissionRef, identityKeyRef);
  const identity = createIdentitySim();

  const disp = identity.startDispatch(admission);
  assert.ok(disp);
  assert.equal(isMutationAdmissionBlocked(admissionRef), true);

  const result = identity.onSettled(disp.token, disp.lease, admission);
  assert.equal(result.unlocked, true);
  assert.equal(isMutationAdmissionBlocked(admissionRef), false);
  assert.equal(identity.pendingLockRef.value, false);
});

test('retry after error settle can re-acquire admission', () => {
  resetAdmissionLeaseCounter();
  const admissionRef = { current: createMutationAdmissionRef() };
  const identityKeyRef = { value: 'scope:1:form' };
  const admission = createAdmissionLifecycleSim(admissionRef, identityKeyRef);
  const identity = createIdentitySim();

  const dispA = identity.startDispatch(admission);
  identity.onSettled(dispA.token, dispA.lease, admission);
  assert.equal(isMutationAdmissionBlocked(admissionRef), false);

  const dispB = identity.startDispatch(admission);
  assert.ok(dispB);
  assert.notEqual(dispB.token.dispatchId, dispA.token.dispatchId);
  assert.equal(isMutationAdmissionBlocked(admissionRef), true);
  identity.onSettled(dispB.token, dispB.lease, admission);
  assert.equal(isMutationAdmissionBlocked(admissionRef), false);
});

test('identity switch releases held admission and sync-invalidates in-flight token', () => {
  resetAdmissionLeaseCounter();
  const admissionRef = { current: createMutationAdmissionRef() };
  const identityKeyRef = { value: 'scope:1:form' };
  const admission = createAdmissionLifecycleSim(admissionRef, identityKeyRef);
  const identity = createIdentitySim({ identityKey: 'scope:1:form' });

  const disp = identity.startDispatch(admission);
  assert.equal(admission.getHeldLease() != null, true);

  identity.syncRenderIdentityCheck('scope:2:form');
  admission.onIdentityEffect('scope:2:form');
  identity.identityEffect('scope:2:form');

  assert.equal(admission.getHeldLease(), null);
  assert.equal(isMutationAdmissionBlocked(admissionRef), false);
  assert.equal(identity.isTokenCurrent(disp.token), false);

  const staleSettle = identity.onSettled(disp.token, disp.lease, admission);
  assert.equal(staleSettle.unlocked, false);
  assert.equal(identity.pendingLockRef.value, false);
});

test('unmount cleanup releases admission without freeing a newer owner lease', () => {
  resetAdmissionLeaseCounter();
  const admissionRef = { current: createMutationAdmissionRef() };
  const identityKeyRef = { value: 'scope:1:form' };
  const admissionA = createAdmissionLifecycleSim(admissionRef, identityKeyRef);

  const leaseA = admissionA.acquire();
  assert.ok(leaseA);
  admissionA.onUnmount();

  assert.equal(isMutationAdmissionBlocked(admissionRef), false);

  const admissionB = createAdmissionLifecycleSim(admissionRef, identityKeyRef);
  const leaseB = admissionB.acquire();
  assert.ok(leaseB);
  assert.notEqual(leaseB, leaseA);

  admissionA.releaseForLease(leaseA);
  assert.equal(admissionRef.current.ownerLease, leaseB);
  admissionB.releaseForLease(leaseB);
  assert.equal(isMutationAdmissionBlocked(admissionRef), false);
});

test('dispatch-bound lease: stale A onSettled after identity switch keeps B owner', () => {
  resetAdmissionLeaseCounter();
  const admissionRef = { current: createMutationAdmissionRef() };
  const identityKeyRef = { value: 'scope:1:form' };
  const admission = createAdmissionLifecycleSim(admissionRef, identityKeyRef);
  const identity = createIdentitySim({ identityKey: 'scope:1:form' });

  const dispA = identity.startDispatch(admission);
  assert.equal(admission.getHeldLease(), dispA.lease);

  identity.syncRenderIdentityCheck('scope:2:form');
  admission.onIdentityEffect('scope:2:form');
  identity.identityEffect('scope:2:form');

  const dispB = identity.startDispatch(admission);
  assert.ok(dispB);
  const leaseB = admission.getHeldLease();
  assert.equal(admissionRef.current.ownerLease, leaseB);

  identity.onSettled(dispA.token, dispA.lease, admission);

  assert.equal(admissionRef.current.ownerLease, leaseB);
  assert.equal(admission.getHeldLease(), leaseB);
});

test('synchronous mutate throw releases bound lease and pending lock', () => {
  resetAdmissionLeaseCounter();
  const admissionRef = { current: createMutationAdmissionRef() };
  const identityKeyRef = { value: 'scope:1:form' };
  const admission = createAdmissionLifecycleSim(admissionRef, identityKeyRef);
  const identity = createIdentitySim();

  const disp = identity.startDispatch(admission);
  assert.equal(isMutationAdmissionBlocked(admissionRef), true);
  identity.syncMutateThrow(disp.token, disp.lease, admission);
  assert.equal(admission.getHeldLease(), null);
  assert.equal(isMutationAdmissionBlocked(admissionRef), false);
  assert.equal(identity.pendingLockRef.value, false);

  assert.ok(admission.acquire(), 'admission re-acquireable after sync throw');
});

test('StrictMode-style unmount invalidates token before stale onSettled can unlock', () => {
  resetAdmissionLeaseCounter();
  const admissionRef = { current: createMutationAdmissionRef() };
  const identityKeyRef = { value: 'scope:1:form' };
  const admission = createAdmissionLifecycleSim(admissionRef, identityKeyRef);
  const identity = createIdentitySim();

  const disp = identity.startDispatch(admission);
  identity.unmount();
  admission.onUnmount();

  assert.equal(identity.isTokenCurrent(disp.token), false);
  const settle = identity.onSettled(disp.token, disp.lease, admission);
  assert.equal(settle.unlocked, false);
  assert.equal(isMutationAdmissionBlocked(admissionRef), false);
});

test('sync render token invalidation closes window before passive identity effect', () => {
  resetAdmissionLeaseCounter();
  const admissionRef = { current: createMutationAdmissionRef() };
  const identityKeyRef = { value: 'scope:1:form' };
  const admission = createAdmissionLifecycleSim(admissionRef, identityKeyRef);
  const identity = createIdentitySim({ identityKey: 'scope:1:form' });

  const disp = identity.startDispatch(admission);
  assert.equal(identity.pendingLockRef.value, true);

  identity.syncRenderIdentityCheck('scope:1:form-v2');

  const betweenRenderAndEffect = identity.onSettled(disp.token, disp.lease, admission);
  assert.equal(betweenRenderAndEffect.unlocked, false);
  assert.equal(identity.pendingLockRef.value, true, 'pending lock must stay until identity effect resets');

  identity.identityEffect('scope:1:form-v2');
  assert.equal(identity.pendingLockRef.value, false);
});

test('screen counter lock: stale settle after B dispatch cannot decrement counter', () => {
  resetAdmissionLeaseCounter();
  const admissionRef = { current: createMutationAdmissionRef() };
  const identityKeyRef = { value: 'scope:1:' };
  const admission = createAdmissionLifecycleSim(admissionRef, identityKeyRef);
  const identity = createIdentitySim({ pendingLockKind: 'counter', formId: undefined });

  const dispA = identity.startDispatch(admission);
  identity.onSettled(dispA.token, dispA.lease, admission);
  assert.equal(identity.pendingLockRef.value, 0);

  const dispB = identity.startDispatch(admission);
  assert.equal(identity.pendingLockRef.value, 1);

  const stale = identity.onSettled(dispA.token, dispA.lease, admission);
  assert.equal(stale.unlocked, false);
  assert.equal(identity.pendingLockRef.value, 1);

  identity.onSettled(dispB.token, dispB.lease, admission);
  assert.equal(identity.pendingLockRef.value, 0);
});

test('double onSettled same token: pending unlock is idempotent for boolean lock', () => {
  resetAdmissionLeaseCounter();
  const admissionRef = { current: createMutationAdmissionRef() };
  const identityKeyRef = { value: 'scope:1:form' };
  const admission = createAdmissionLifecycleSim(admissionRef, identityKeyRef);
  const identity = createIdentitySim();

  const disp = identity.startDispatch(admission);
  identity.onSettled(disp.token, disp.lease, admission);
  assert.equal(identity.pendingLockRef.value, false);

  const again = identity.onSettled(disp.token, disp.lease, admission);
  assert.equal(again.unlocked, true);
  assert.equal(identity.pendingLockRef.value, false);
});

test('formId in identity key: profile switch frees admission for sibling form hook', () => {
  resetAdmissionLeaseCounter();
  const sharedRef = { current: createMutationAdmissionRef() };
  const keyRef = { value: 'demo:0:budgets' };
  const formA = createAdmissionLifecycleSim(sharedRef, keyRef);
  const formB = createAdmissionLifecycleSim(sharedRef, keyRef);

  const leaseA = formA.acquire();
  assert.ok(leaseA);
  formA.onIdentityEffect('demo:0:goals');
  assert.equal(isMutationAdmissionBlocked(sharedRef), false);
  const leaseB = formB.acquire();
  assert.ok(leaseB);
  formB.releaseForLease(leaseB);
});

test('stale A settle after identity switch without B re-dispatch is admission-safe', () => {
  resetAdmissionLeaseCounter();
  const admissionRef = { current: createMutationAdmissionRef() };
  const identityKeyRef = { value: 'scope:1:form' };
  const admission = createAdmissionLifecycleSim(admissionRef, identityKeyRef);
  const identity = createIdentitySim({ identityKey: 'scope:1:form' });

  const dispA = identity.startDispatch(admission);
  identity.syncRenderIdentityCheck('scope:2:form');
  admission.onIdentityEffect('scope:2:form');
  identity.identityEffect('scope:2:form');

  assert.equal(admission.getHeldLease(), null);
  assert.equal(isMutationAdmissionBlocked(admissionRef), false);

  const stale = identity.onSettled(dispA.token, dispA.lease, admission);
  assert.equal(stale.unlocked, false);
  assert.equal(admissionRef.current.ownerLease, null);
  assert.equal(isMutationAdmissionBlocked(admissionRef), false);
});

test('screen counter: stale A onSettled after identity switch keeps B admission lease', () => {
  resetAdmissionLeaseCounter();
  const admissionRef = { current: createMutationAdmissionRef() };
  const identityKeyRef = { value: 'scope:1:' };
  const admission = createAdmissionLifecycleSim(admissionRef, identityKeyRef);
  const identity = createIdentitySim({ pendingLockKind: 'counter', formId: undefined, identityKey: 'scope:1:' });

  const dispA = identity.startDispatch(admission);
  identity.syncRenderIdentityCheck('scope:2:');
  admission.onIdentityEffect('scope:2:');
  identity.identityEffect('scope:2:');

  const dispB = identity.startDispatch(admission);
  const leaseB = admission.getHeldLease();
  assert.equal(admissionRef.current.ownerLease, leaseB);
  assert.equal(identity.pendingLockRef.value, 1);

  identity.onSettled(dispA.token, dispA.lease, admission);

  assert.equal(admissionRef.current.ownerLease, leaseB);
  assert.equal(identity.pendingLockRef.value, 1, 'token guard still protects pending counter');
});

test('sync throw path: stale A catch after identity switch keeps B lease', () => {
  resetAdmissionLeaseCounter();
  const admissionRef = { current: createMutationAdmissionRef() };
  const identityKeyRef = { value: 'scope:1:form' };
  const admission = createAdmissionLifecycleSim(admissionRef, identityKeyRef);
  const identity = createIdentitySim({ identityKey: 'scope:1:form' });

  const dispA = identity.startDispatch(admission);
  identity.syncRenderIdentityCheck('scope:2:form');
  admission.onIdentityEffect('scope:2:form');
  identity.identityEffect('scope:2:form');

  identity.startDispatch(admission);
  const leaseB = admission.getHeldLease();

  identity.syncMutateThrow(dispA.token, dispA.lease, admission);

  assert.equal(admissionRef.current.ownerLease, leaseB);
  assert.equal(admission.getHeldLease(), leaseB);
});

test('separate hook instances: stale A settle on hookA cannot touch hookB held lease', () => {
  resetAdmissionLeaseCounter();
  const sharedRef = { current: createMutationAdmissionRef() };
  const keyRef = { value: 'scope:1:form' };
  const hookA = createAdmissionLifecycleSim(sharedRef, keyRef);
  const hookB = createAdmissionLifecycleSim(sharedRef, keyRef);

  const leaseA = hookA.acquire();
  assert.ok(leaseA);
  hookA.onIdentityEffect('scope:2:form');
  const leaseB = hookB.acquire();
  assert.ok(leaseB);

  hookA.releaseForLease(leaseA);
  assert.equal(sharedRef.current.ownerLease, leaseB);
  assert.notEqual(leaseA, leaseB);
  hookB.releaseForLease(leaseB);
  assert.equal(isMutationAdmissionBlocked(sharedRef), false);
});
