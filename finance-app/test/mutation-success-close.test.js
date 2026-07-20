const test = require('node:test');
const assert = require('node:assert/strict');
const {
  shouldDeferSuccessClose,
  shouldInvokeDeferredSuccessClose,
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

test('useMutationForm defers onSuccessClose until after onSettled unlock', () => {
  const fs = require('node:fs');
  const path = require('node:path');
  const source = fs.readFileSync(path.join(__dirname, '../src/hooks/useMutationForm.ts'), 'utf8');
  const onSuccessBlock = source.match(/onSuccess: \(\) => \{[\s\S]*?\n        \},/)?.[0] ?? '';
  assert.match(source, /successClosePendingRef\.current = true/);
  assert.match(source, /shouldInvokeDeferredSuccessClose/);
  assert.doesNotMatch(onSuccessBlock, /onSuccessClose/);
  assert.match(source, /onSettled:[\s\S]*shouldInvokeDeferredSuccessClose[\s\S]*onSuccessClose\?\.\(\)/);
});
