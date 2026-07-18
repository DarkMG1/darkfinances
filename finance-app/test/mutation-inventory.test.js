const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');

const appRoot = path.resolve(__dirname, '../src/app');

const screensMustNotBareMutate = [
  'transaction/[id].tsx',
  'reconcile.tsx',
  'networth.tsx',
  'account/[id].tsx',
  'review.tsx',
  '(tabs)/index.tsx',
  '(tabs)/settings.tsx',
  '(tabs)/transactions.tsx',
  'recurring/[key].tsx',
  'subscriptions.tsx',
];

const screensMustNotAlertMutationErrors = [
  'networth.tsx',
  'account/[id].tsx',
  '(tabs)/index.tsx',
];

test('audited screens route mutations through shared action hooks', () => {
  for (const rel of screensMustNotBareMutate) {
    const source = fs.readFileSync(path.join(appRoot, rel), 'utf8');
    assert.doesNotMatch(source, /\.mutate\(/, `${rel} must not call mutation.mutate directly`);
  }
});

test('audited screens do not surface mutation failures with Alert.alert', () => {
  for (const rel of screensMustNotAlertMutationErrors) {
    const source = fs.readFileSync(path.join(appRoot, rel), 'utf8');
    assert.doesNotMatch(source, /onError:\s*\([^)]*\)\s*=>\s*Alert\.alert/, `${rel} must not use Alert for mutation errors`);
    assert.doesNotMatch(source, /Alert\.alert\('Could not save'/, `${rel} must not Alert could-not-save`);
    assert.doesNotMatch(source, /Alert\.alert\('Sync failed'/, `${rel} must not Alert sync failed`);
  }
});

test('transaction detail uses unified mutation screen coordinator', () => {
  const source = fs.readFileSync(path.join(appRoot, 'transaction/[id].tsx'), 'utf8');
  assert.match(source, /useMutationScreen/);
  assert.match(source, /screen\.retry/);
  assert.match(source, /modalLocked/);
  assert.match(source, /MutationFieldError/);
});

test('goals and events rehydrate drafts through setFields', () => {
  for (const rel of ['goals.tsx', 'events.tsx']) {
    const source = fs.readFileSync(path.join(appRoot, rel), 'utf8');
    assert.doesNotMatch(source, /setFields:\s*\(\)\s*=>\s*\{\}/, `${rel} must wire setFields for draft rehydration`);
    assert.match(source, /setFields:\s*applyFields/, `${rel} must apply draft fields`);
  }
});
