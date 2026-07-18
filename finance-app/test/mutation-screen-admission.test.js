const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const path = require('path');
const {
  createMutationAdmissionRef,
  isMutationAdmissionBlocked,
  releaseMutationAdmission,
  resetAdmissionLeaseCounter,
  tryAcquireMutationAdmission,
} = require('../src/lib/mutation-screen-admission');

test('admission lease blocks second acquire until matching release', () => {
  resetAdmissionLeaseCounter();
  const ref = { current: createMutationAdmissionRef() };
  const leaseA = tryAcquireMutationAdmission(ref);
  assert.equal(typeof leaseA, 'number');
  assert.ok(leaseA > 0);
  assert.equal(tryAcquireMutationAdmission(ref), null);
  assert.equal(isMutationAdmissionBlocked(ref), true);
  releaseMutationAdmission(ref, leaseA);
  assert.equal(isMutationAdmissionBlocked(ref), false);
  const leaseB = tryAcquireMutationAdmission(ref);
  assert.notEqual(leaseB, leaseA);
});

test('stale lease release cannot free a newer owner', () => {
  resetAdmissionLeaseCounter();
  const ref = { current: createMutationAdmissionRef() };
  const leaseA = tryAcquireMutationAdmission(ref);
  releaseMutationAdmission(ref, leaseA);
  const leaseB = tryAcquireMutationAdmission(ref);
  releaseMutationAdmission(ref, leaseA);
  assert.equal(ref.current.ownerLease, leaseB);
  assert.equal(isMutationAdmissionBlocked(ref), true);
  releaseMutationAdmission(ref, leaseB);
  assert.equal(isMutationAdmissionBlocked(ref), false);
});

test('identity change path: stale A settle after B acquires leaves B locked', () => {
  resetAdmissionLeaseCounter();
  const ref = { current: createMutationAdmissionRef() };
  const leaseA = tryAcquireMutationAdmission(ref);
  releaseMutationAdmission(ref, leaseA);
  const leaseB = tryAcquireMutationAdmission(ref);
  releaseMutationAdmission(ref, leaseA);
  assert.equal(ref.current.ownerLease, leaseB);
  releaseMutationAdmission(ref, leaseB);
  assert.equal(tryAcquireMutationAdmission(ref) != null, true);
});

test('admission helpers no-op safely without ref', () => {
  resetAdmissionLeaseCounter();
  assert.equal(tryAcquireMutationAdmission(undefined), 0);
  assert.equal(isMutationAdmissionBlocked(undefined), false);
  releaseMutationAdmission(undefined, 1);
});

test('mutation hooks use admission lifecycle with lease release before token guard', () => {
  for (const rel of ['useMutationForm.ts', 'useMutationAction.ts', 'useMutationScreen.ts']) {
    const source = fs.readFileSync(path.join(__dirname, '../src/hooks', rel), 'utf8');
    assert.match(source, /useMutationAdmissionLifecycle/, `${rel} uses admission lifecycle`);
    assert.match(source, /releaseAdmissionFromSettle\(\)/, `${rel} releases admission on settled`);
    const settled = source.match(/onSettled:\s*\(\)\s*=>\s*\{([\s\S]*?)\n\s*\}/)?.[1] ?? '';
    const releaseIdx = settled.indexOf('releaseAdmissionFromSettle');
    const tokenIdx = settled.indexOf('isDispatchTokenCurrent');
    assert.ok(releaseIdx >= 0, `${rel} must release admission in onSettled`);
    if (tokenIdx >= 0) {
      assert.ok(releaseIdx < tokenIdx, `${rel} must release admission before token guard`);
    }
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

test('hooks release admission on synchronous mutate throw', () => {
  for (const rel of ['useMutationForm.ts', 'useMutationAction.ts', 'useMutationScreen.ts']) {
    const source = fs.readFileSync(path.join(__dirname, '../src/hooks', rel), 'utf8');
    assert.match(source, /catch \(error\)/, `${rel} handles synchronous mutate throw`);
    assert.match(source, /releaseAdmissionFromSettle\(\)/, `${rel} releases admission in catch`);
  }
});
