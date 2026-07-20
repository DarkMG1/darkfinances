const test = require('node:test');
const assert = require('node:assert/strict');
const {
  shouldDeferSuccessClose,
  shouldInvokeDeferredSuccessClose,
  shouldScheduleDeferredSuccessClose,
  shouldRunDeferredSuccessClose,
} = require('../src/lib/mutation-success-close.js');

test('shouldDeferSuccessClose requires pending success and current token', () => {
  assert.equal(shouldDeferSuccessClose({ successPending: true, tokenCurrent: true }), true);
  assert.equal(shouldDeferSuccessClose({ successPending: false, tokenCurrent: true }), false);
  assert.equal(shouldDeferSuccessClose({ successPending: true, tokenCurrent: false }), false);
});

test('shouldInvokeDeferredSuccessClose only after unlock and before duplicate close', () => {
  assert.equal(shouldInvokeDeferredSuccessClose({ tokenCurrent: true, pendingLocked: false, alreadyClosed: false }), true);
  assert.equal(shouldInvokeDeferredSuccessClose({ tokenCurrent: false, pendingLocked: false, alreadyClosed: false }), false);
  assert.equal(shouldInvokeDeferredSuccessClose({ tokenCurrent: true, pendingLocked: true, alreadyClosed: false }), false);
  assert.equal(shouldInvokeDeferredSuccessClose({ tokenCurrent: true, pendingLocked: false, alreadyClosed: true }), false);
});

test('shouldScheduleDeferredSuccessClose waits for success phase and unlocked dispatch', () => {
  assert.equal(shouldScheduleDeferredSuccessClose({
    phase: 'success',
    dispatchPending: false,
    pendingLocked: false,
    successPending: true,
  }), true);
  assert.equal(shouldScheduleDeferredSuccessClose({
    phase: 'success',
    dispatchPending: true,
    pendingLocked: false,
    successPending: true,
  }), false);
});

test('shouldRunDeferredSuccessClose requires post-unlock render-ready state', () => {
  assert.equal(shouldRunDeferredSuccessClose({
    phase: 'success',
    tokenCurrent: true,
    pendingLocked: false,
    dispatchPending: false,
    alreadyClosed: false,
  }), true);
  assert.equal(shouldRunDeferredSuccessClose({
    phase: 'idle',
    tokenCurrent: true,
    pendingLocked: false,
    dispatchPending: false,
    alreadyClosed: false,
  }), false);
});

test('useMutationForm closes from post-settled effect via requestAnimationFrame', () => {
  const fs = require('node:fs');
  const path = require('node:path');
  const source = fs.readFileSync(path.join(__dirname, '../src/hooks/useMutationForm.ts'), 'utf8');
  const onSuccessBlock = source.match(/onSuccess: \(\) => \{[\s\S]*?\n        \},/)?.[0] ?? '';
  const onSettledBlock = source.match(/onSettled: async \(\) => \{[\s\S]*?\n        \},/)?.[0] ?? '';
  assert.match(source, /successCloseTokenRef\.current = token/);
  assert.match(source, /setBaseline\(\{ \.\.\.fieldsRef\.current \}\)/);
  assert.match(source, /shouldScheduleDeferredSuccessClose/);
  assert.match(source, /requestAnimationFrame/);
  assert.match(source, /cancelAnimationFrame/);
  assert.match(source, /const isLocked = dispatchPending[\s\S]*phase === 'success'/);
  assert.match(source, /finally \{\s*setPhase\('idle'\)/);
  assert.doesNotMatch(onSuccessBlock, /onSuccessClose\?\.\(\)/);
  assert.doesNotMatch(onSettledBlock, /onSuccessClose\?\.\(\)/);
  assert.match(source, /successCloseCallbackRef\.current = onSuccessCloseRef\.current/);
  assert.match(source, /shouldCloseSucceededForm = successClosePendingRef\.current && !closedRef\.current/);
  assert.match(source, /shouldRunDeferredSuccessClose[\s\S]*closeSucceededForm\?\.\(\)/);
  assert.match(source, /phase === 'reconciling' \|\| phase === 'success'/);
});
