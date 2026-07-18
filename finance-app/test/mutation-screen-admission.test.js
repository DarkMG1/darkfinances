const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const path = require('path');
const {
  createMutationAdmissionRef,
  isMutationAdmissionBlocked,
  releaseAdmissionForLease,
  resetAdmissionLeaseCounter,
  tryAcquireMutationAdmission,
} = require('../src/lib/mutation-screen-admission');

function createHookAdmission(admissionRef) {
  let heldLease = null;
  return {
    acquire() {
      const lease = tryAcquireMutationAdmission(admissionRef);
      if (lease == null) return null;
      heldLease = lease;
      return lease;
    },
    identityCleanup() {
      if (heldLease == null) return;
      const lease = heldLease;
      heldLease = null;
      releaseAdmissionForLease(admissionRef, lease);
    },
    settle(lease) {
      if (heldLease === lease) heldLease = null;
      releaseAdmissionForLease(admissionRef, lease);
    },
    catchRelease(lease) {
      if (heldLease === lease) heldLease = null;
      releaseAdmissionForLease(admissionRef, lease);
    },
    held() {
      return heldLease;
    },
  };
}

test('admission lease blocks second acquire until matching release', () => {
  resetAdmissionLeaseCounter();
  const ref = { current: createMutationAdmissionRef() };
  const leaseA = tryAcquireMutationAdmission(ref);
  assert.equal(typeof leaseA, 'number');
  assert.ok(leaseA > 0);
  assert.equal(tryAcquireMutationAdmission(ref), null);
  assert.equal(isMutationAdmissionBlocked(ref), true);
  releaseAdmissionForLease(ref, leaseA);
  assert.equal(isMutationAdmissionBlocked(ref), false);
  const leaseB = tryAcquireMutationAdmission(ref);
  assert.notEqual(leaseB, leaseA);
});

test('stale lease release cannot free a newer owner', () => {
  resetAdmissionLeaseCounter();
  const ref = { current: createMutationAdmissionRef() };
  const leaseA = tryAcquireMutationAdmission(ref);
  releaseAdmissionForLease(ref, leaseA);
  const leaseB = tryAcquireMutationAdmission(ref);
  releaseAdmissionForLease(ref, leaseA);
  assert.equal(ref.current.ownerLease, leaseB);
  assert.equal(isMutationAdmissionBlocked(ref), true);
  releaseAdmissionForLease(ref, leaseB);
  assert.equal(isMutationAdmissionBlocked(ref), false);
});

test('dispatch-bound lifecycle: A lease1 identity cleanup -> B lease2 -> stale A settle leaves B owner', () => {
  resetAdmissionLeaseCounter();
  const ref = { current: createMutationAdmissionRef() };
  const hookA = createHookAdmission(ref);
  const hookB = createHookAdmission(ref);

  const lease1 = hookA.acquire();
  assert.ok(lease1 > 0);
  hookA.identityCleanup();
  assert.equal(isMutationAdmissionBlocked(ref), false);

  const lease2 = hookB.acquire();
  assert.ok(lease2 > 0);
  assert.equal(hookB.held(), lease2);

  hookA.settle(lease1);
  assert.equal(ref.current.ownerLease, lease2);
  assert.equal(hookB.held(), lease2);
  assert.equal(isMutationAdmissionBlocked(ref), true);

  hookB.settle(lease2);
  assert.equal(isMutationAdmissionBlocked(ref), false);
  assert.equal(hookB.held(), null);
});

test('dispatch-bound lifecycle: stale A catch after B acquire cannot release B', () => {
  resetAdmissionLeaseCounter();
  const ref = { current: createMutationAdmissionRef() };
  const hookA = createHookAdmission(ref);
  const hookB = createHookAdmission(ref);

  const lease1 = hookA.acquire();
  hookA.identityCleanup();
  const lease2 = hookB.acquire();
  hookA.catchRelease(lease1);

  assert.equal(ref.current.ownerLease, lease2);
  assert.equal(hookB.held(), lease2);
  hookB.settle(lease2);
  assert.equal(tryAcquireMutationAdmission(ref) != null, true);
});

test('normal settle, retry re-acquire, and idempotent double-settle', () => {
  resetAdmissionLeaseCounter();
  const ref = { current: createMutationAdmissionRef() };
  const hook = createHookAdmission(ref);

  const lease1 = hook.acquire();
  hook.settle(lease1);
  assert.equal(isMutationAdmissionBlocked(ref), false);

  const lease2 = hook.acquire();
  assert.notEqual(lease2, lease1);
  hook.settle(lease2);
  hook.settle(lease2);
  assert.equal(isMutationAdmissionBlocked(ref), false);
});

test('admission helpers no-op safely without ref', () => {
  resetAdmissionLeaseCounter();
  assert.equal(tryAcquireMutationAdmission(undefined), 0);
  assert.equal(isMutationAdmissionBlocked(undefined), false);
  releaseAdmissionForLease(undefined, 1);
});

test('mutation hooks bind dispatch lease and release before token guard', () => {
  for (const rel of ['useMutationForm.ts', 'useMutationAction.ts', 'useMutationScreen.ts']) {
    const source = fs.readFileSync(path.join(__dirname, '../src/hooks', rel), 'utf8');
    assert.match(source, /useMutationAdmissionLifecycle/, `${rel} uses admission lifecycle`);
    assert.match(source, /const lease = acquireAdmission\(\)/, `${rel} captures dispatch lease`);
    assert.match(source, /releaseAdmissionForLease\(lease\)/, `${rel} releases bound lease on settled/catch`);
    assert.match(source, /onSettled:\s*\(\)\s*=>\s*\{[\s\S]*releaseAdmissionForLease\(lease\)/, `${rel} settles with bound lease`);
  }
});

const multiActionScreens = [
  'goals.tsx',
  'events.tsx',
  'rules.tsx',
  'reconcile.tsx',
  'split/[id].tsx',
  'reimbursement.tsx',
  'networth.tsx',
];

test('multi-action screens share one admission ref and gate handlers with banner.isLocked', () => {
  const appRoot = path.join(__dirname, '../src/app');
  for (const rel of multiActionScreens) {
    const source = fs.readFileSync(path.join(appRoot, rel), 'utf8');
    assert.match(source, /useMutationScreenAdmission/, `${rel} creates shared admission ref`);
    assert.match(source, /admissionRef/, `${rel} passes admissionRef to hooks`);
    assert.match(source, /banner\.isLocked/, `${rel} gates UI/handlers with combined lock`);
    assert.doesNotMatch(source, /confirm\.isPending/, `${rel} must not use legacy mutation.isPending spinner`);
  }
});

test('reconcile close and toggle guard combined screen lock', () => {
  const source = fs.readFileSync(path.join(__dirname, '../src/app/reconcile.tsx'), 'utf8');
  assert.match(source, /if \(banner\.isLocked\) return;/);
  assert.match(source, /screen = useMutationScreen\([\s\S]*admissionRef/);
});

test('hooks release bound lease on synchronous mutate throw', () => {
  for (const rel of ['useMutationForm.ts', 'useMutationAction.ts', 'useMutationScreen.ts']) {
    const source = fs.readFileSync(path.join(__dirname, '../src/hooks', rel), 'utf8');
    assert.match(source, /catch \(error\)/, `${rel} handles synchronous mutate throw`);
    assert.match(source, /releaseAdmissionForLease\(lease\)/, `${rel} releases bound lease in catch`);
  }
});
