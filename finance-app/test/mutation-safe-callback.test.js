const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const { safeMutationCallback } = require('../src/lib/mutation-safe-callback');

test('safeMutationCallback swallows throws', () => {
  let ran = false;
  safeMutationCallback(() => { ran = true; });
  assert.equal(ran, true);
  assert.doesNotThrow(() => {
    safeMutationCallback(() => { throw new Error('boom'); });
  });
});

test('action and screen hooks wrap optional callbacks with safeMutationCallback', () => {
  const root = path.resolve(__dirname, '..');
  for (const rel of ['useMutationAction.ts', 'useMutationScreen.ts']) {
    const source = fs.readFileSync(path.join(root, 'src/hooks', rel), 'utf8');
    assert.match(source, /safeMutationCallback/, `${rel} uses safe callback wrapper`);
  }
  const action = fs.readFileSync(path.join(root, 'src/hooks/useMutationAction.ts'), 'utf8');
  assert.match(action, /safeMutationCallback\(onActivate\)/);
  assert.match(action, /safeMutationCallback\(lastRollback\.current\)/);
  assert.match(action, /safeMutationCallback\(options\?\.onSuccess/);
  assert.match(action, /safeMutationCallback\(options\?\.onSettled\)/);

  const screen = fs.readFileSync(path.join(root, 'src/hooks/useMutationScreen.ts'), 'utf8');
  assert.match(screen, /safeMutationCallback\(entry\.lastError/);
  assert.match(screen, /safeMutationCallback\(entry\.rollback\)/);
  assert.match(screen, /safeMutationCallback\(runOptions\?\.onSuccess/);
  assert.match(screen, /safeMutationCallback\(runOptions\?\.onSettled\)/);
});

test('form dismiss uses identity + nonce guard before finalizeDismiss', () => {
  const source = fs.readFileSync(path.join(__dirname, '../src/hooks/useMutationForm.ts'), 'utf8');
  assert.match(source, /shouldApplyFormDismiss/);
  assert.match(source, /nextDismissRequest/);
  assert.match(source, /identityAtRequest/);
  assert.match(source, /finalizeDismiss\(onConfirmed, \{ identity: identityAtRequest, nonce \}\)/);
});

test('transaction wires screen field invalidation for link date payee notes', () => {
  const source = fs.readFileSync(path.join(__dirname, '../src/app/transaction/[id].tsx'), 'utf8');
  assert.match(source, /useMutationScreenFieldInvalidation/);
  assert.match(source, /useMutationScreenFieldInvalidation\(screen, 'link'/);
  assert.match(source, /useMutationScreenFieldInvalidation\(screen, 'date'/);
  assert.match(source, /useMutationScreenFieldInvalidation\(screen, 'payee'/);
  assert.match(source, /useMutationScreenFieldInvalidation\(screen, 'notes'/);
  assert.doesNotMatch(source, /\.isPending/);
  assert.match(source, /actionSaving\(/);
});
