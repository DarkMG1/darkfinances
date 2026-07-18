const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const path = require('path');
const {
  isMutationAdmissionBlocked,
  releaseMutationAdmission,
  tryAcquireMutationAdmission,
} = require('../src/lib/mutation-screen-admission');

test('admission ref blocks second synchronous acquire until release', () => {
  const ref = { current: false };
  assert.equal(tryAcquireMutationAdmission(ref), true);
  assert.equal(tryAcquireMutationAdmission(ref), false);
  assert.equal(isMutationAdmissionBlocked(ref), true);
  releaseMutationAdmission(ref);
  assert.equal(isMutationAdmissionBlocked(ref), false);
  assert.equal(tryAcquireMutationAdmission(ref), true);
});

test('admission helpers no-op safely without ref', () => {
  assert.equal(tryAcquireMutationAdmission(undefined), true);
  assert.equal(isMutationAdmissionBlocked(undefined), false);
  releaseMutationAdmission(undefined);
});

test('mutation hooks acquire and release admission around dispatch', () => {
  for (const rel of ['useMutationForm.ts', 'useMutationAction.ts', 'useMutationScreen.ts']) {
    const source = fs.readFileSync(path.join(__dirname, '../src/hooks', rel), 'utf8');
    assert.match(source, /tryAcquireMutationAdmission\(admissionRef\)/, `${rel} acquires admission`);
    assert.match(source, /releaseMutationAdmission\(admissionRef\)/, `${rel} releases admission on settled`);
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
