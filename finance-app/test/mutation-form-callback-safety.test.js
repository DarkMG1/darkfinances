const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');

const root = path.resolve(__dirname, '..');

test('MutationSheet exposes backdrop and sheet as siblings for accessibility', () => {
  const source = fs.readFileSync(path.join(root, 'src/components/mutation-form.tsx'), 'utf8');
  assert.match(source, /testID=\{backdropTestID\}/);
  assert.match(source, /`\$\{testID\}-backdrop`/);
  assert.match(source, /styles\.modalRoot/);
  assert.doesNotMatch(source, /<Pressable[\s\S]*testID=\{testID\}[\s\S]*onPress=\{\(\) => \{\}\}/);
});

test('onSuccessClose errors are caught and rebaseline flags set before deferred close', () => {
  const source = fs.readFileSync(path.join(root, 'src/hooks/useMutationForm.ts'), 'utf8');
  assert.match(source, /rebaselineAfterSuccessRef\.current = true/);
  assert.match(source, /try\s*\{\s*onSuccessClose\?\.\(\)/);
  assert.match(source, /suppressPersistRef\.current = true/);
});

test('finalizeDismiss uses fieldsRef.current not render closure', () => {
  const source = fs.readFileSync(path.join(root, 'src/hooks/useMutationForm.ts'), 'utf8');
  assert.match(source, /setBaseline\(\{ \.\.\.fieldsRef\.current \}\)/);
  assert.doesNotMatch(source, /finalizeDismiss[\s\S]*setBaseline\(fields\)/);
});

test('screen wraps entry onError before mapping', () => {
  const source = fs.readFileSync(path.join(root, 'src/hooks/useMutationScreen.ts'), 'utf8');
  const handleErrorBlock = source.match(/const handleError = useCallback\(async \([\s\S]*?\}, \[isDispatchTokenCurrent/)?.[0] ?? '';
  const onErrorIdx = handleErrorBlock.indexOf('entry.lastError');
  const mapIdx = handleErrorBlock.indexOf('mapMutationApiError');
  assert.ok(onErrorIdx >= 0 && mapIdx >= 0);
  assert.ok(onErrorIdx < mapIdx, 'onError callback must run before mapMutationApiError');
  assert.match(handleErrorBlock, /safeMutationCallback\(entry\.lastError/);
});

test('hooks await error reconciliation before onSettled unlock', () => {
  for (const rel of ['useMutationForm.ts', 'useMutationAction.ts', 'useMutationScreen.ts']) {
    const source = fs.readFileSync(path.join(root, 'src/hooks', rel), 'utf8');
    assert.match(source, /awaitMutationErrorReconciliation/, `${rel} awaits reconciliation`);
    assert.match(source, /startMutationErrorReconciliation/, `${rel} captures error task`);
  }
});
