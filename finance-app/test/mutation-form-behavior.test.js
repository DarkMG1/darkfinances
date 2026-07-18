const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const path = require('path');

const root = path.resolve(__dirname, '..');

test('mutation form components expose accessibility live region and 44pt targets', () => {
  const source = fs.readFileSync(path.join(root, 'src/components/mutation-form.tsx'), 'utf8');
  assert.match(source, /accessibilityLiveRegion/);
  assert.match(source, /minHeight: 44/);
  assert.match(source, /accessibilityRole="alert"/);
});

test('profile purge clears mutation form drafts', () => {
  const source = fs.readFileSync(path.join(root, 'src/lib/profile-purge.ts'), 'utf8');
  assert.match(source, /purgeMutationFormDrafts/);
});

test('requests propagate validation issues on finance errors', () => {
  const source = fs.readFileSync(path.join(root, 'src/api/client/requests.ts'), 'utf8');
  assert.match(source, /issues\?: ValidationIssue\[\]/);
  assert.match(source, /requiresIdempotencyKeyReuse/);
});

test('add transaction screen uses mutation form banner not alert errors', () => {
  const source = fs.readFileSync(path.join(root, 'src/app/add-transaction.tsx'), 'utf8');
  assert.match(source, /useMutationForm/);
  assert.match(source, /MutationFormBanner/);
  assert.doesNotMatch(source, /Alert\.alert\('Could not add'/);
});

test('mutation hooks clear retry variables after success', () => {
  const form = fs.readFileSync(path.join(root, 'src/hooks/useMutationForm.ts'), 'utf8');
  const action = fs.readFileSync(path.join(root, 'src/hooks/useMutationAction.ts'), 'utf8');
  const screen = fs.readFileSync(path.join(root, 'src/hooks/useMutationScreen.ts'), 'utf8');
  assert.match(form, /variablesRef\.current = null/);
  assert.match(action, /lastVars\.current = null/);
  assert.match(screen, /entry\.lastVars = null/);
});

test('goals sheet blocks dismiss while locked', () => {
  const source = fs.readFileSync(path.join(root, 'src/app/goals.tsx'), 'utf8');
  assert.match(source, /canDismiss={form\.canDismiss/);
  assert.match(source, /requestDismiss/);
});

test('add transaction and split editor block hardware back while submitting', () => {
  for (const rel of ['add-transaction.tsx', 'split/[id].tsx']) {
    const source = fs.readFileSync(path.join(root, 'src/app', rel), 'utf8');
    assert.match(source, /beforeRemove/, `${rel} must guard navigation during submit`);
    assert.match(source, /preventDefault/, `${rel} must prevent back while locked`);
  }
});

test('transaction link allocation surfaces inline field errors', () => {
  const source = fs.readFileSync(path.join(root, 'src/app/transaction/[id].tsx'), 'utf8');
  assert.match(source, /allocationFieldError/);
  assert.match(source, /transaction-link-allocation-error/);
  assert.match(source, /fieldOrder: \['allocationCents'\]/);
});

test('mutation hooks expose synchronous pending guards for UI lock', () => {
  const form = fs.readFileSync(path.join(root, 'src/hooks/useMutationForm.ts'), 'utf8');
  const action = fs.readFileSync(path.join(root, 'src/hooks/useMutationAction.ts'), 'utf8');
  assert.match(form, /dispatchPending/);
  assert.match(action, /dispatchPending/);
  assert.match(form, /pendingLockRef/);
  assert.match(action, /pendingLockRef/);
});
