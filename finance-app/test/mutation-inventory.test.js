const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');

const appRoot = path.resolve(__dirname, '../src/app');

function listAppScreens(dir = appRoot, files = []) {
  for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
    const full = path.join(dir, entry.name);
    if (entry.isDirectory()) listAppScreens(full, files);
    else if (entry.name.endsWith('.tsx')) files.push(full);
  }
  return files;
}

const screensMustNotAlertMutationErrors = [
  'networth.tsx',
  'account/[id].tsx',
  '(tabs)/index.tsx',
];

test('every app screen routes mutations through shared action hooks', () => {
  const screens = listAppScreens().sort();
  assert.ok(screens.length > 0, 'expected at least one app screen');
  for (const file of screens) {
    const rel = path.relative(appRoot, file);
    const source = fs.readFileSync(file, 'utf8');
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

test('account edit and networth manual sheets use mutation form with dismiss guards and inline errors', () => {
  for (const rel of ['account/[id].tsx', 'networth.tsx']) {
    const source = fs.readFileSync(path.join(appRoot, rel), 'utf8');
    assert.match(source, /useMutationForm/, `${rel} must use mutation form`);
    assert.match(source, /MutationSheet/, `${rel} must use mutation sheet`);
    assert.match(source, /requestDismiss|form\.requestDismiss/, `${rel} must confirm dirty dismiss`);
    assert.match(source, /MutationFieldError/, `${rel} must show inline field errors`);
    assert.match(source, /MutationLiveRegion/, `${rel} must expose one live region`);
    assert.equal((source.match(/<MutationLiveRegion/g) || []).length, 1, `${rel} must have one live region`);
  }
  const networth = fs.readFileSync(path.join(appRoot, 'networth.tsx'), 'utf8');
  assert.match(networth, /validateMoneyField/);
  assert.doesNotMatch(networth, /parseFloat\(edit\.value\)/);
  const account = fs.readFileSync(path.join(appRoot, 'account/[id].tsx'), 'utf8');
  assert.match(account, /form\.canDismiss/);
  assert.match(account, /form\.submit\(\)/);
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

const multiActionScreens = [
  'goals.tsx',
  'events.tsx',
  'rules.tsx',
  'split/[id].tsx',
  'reimbursement.tsx',
  'reconcile.tsx',
  'networth.tsx',
];

test('multi-action screens coordinate banner retry through useMutationBannerCoordinator', () => {
  for (const rel of multiActionScreens) {
    const source = fs.readFileSync(path.join(appRoot, rel), 'utf8');
    assert.match(source, /useMutationBannerCoordinator/, `${rel} must use banner coordinator`);
    assert.match(source, /activitySeq:/, `${rel} must pass activitySeq for latest-source authority`);
    assert.match(source, /onRetry={banner\.retry}/, `${rel} must retry only the active action`);
    assert.match(source, /useMutationScreenAdmission/, `${rel} must use shared admission ref`);
    assert.match(source, /banner\.isLocked/, `${rel} must use combined coordinator lock in UI/handlers`);
    assert.doesNotMatch(source, /onRetry=\{\(\)\s*=>\s*\{[^}]*\.retry\(\);[^}]*\.retry\(\)/, `${rel} must not fan out retry to every action`);
    assert.doesNotMatch(source, /form\.retry\(\);\s*deleteAction\.retry\(\)/, `${rel} must not fan out form/delete retry`);
    assert.doesNotMatch(source, /closeAction\.retry\(\);\s*screen\.retry\(\)/, `${rel} must not fan out reconcile retry`);
  }
});

test('dead useScreenMutationFeedback hook is removed', () => {
  const hookPath = path.resolve(__dirname, '../src/hooks/useScreenMutationFeedback.ts');
  assert.equal(fs.existsSync(hookPath), false);
});
