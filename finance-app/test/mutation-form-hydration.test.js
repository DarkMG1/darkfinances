const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const path = require('path');
const {
  beginDraftHydration,
  createDraftHydrationState,
  finishDraftHydration,
  shouldPersistMutationFormDraft,
} = require('../src/lib/mutation-form-hydration');

function fieldsEqual(a, b) {
  return JSON.stringify(a) === JSON.stringify(b);
}

test('hydration lifecycle skips persist until finish on same generation', () => {
  const state = createDraftHydrationState();
  assert.equal(state.skipPersist, true);

  const gen = beginDraftHydration(state);
  assert.equal(state.skipPersist, true);
  assert.equal(
    shouldPersistMutationFormDraft(state, { name: 'pre-hydration' }, { name: '' }, fieldsEqual),
    false,
  );

  finishDraftHydration(state, gen);
  assert.equal(state.skipPersist, false);
  assert.equal(
    shouldPersistMutationFormDraft(state, { name: 'user edit' }, { name: '' }, fieldsEqual),
    true,
  );
});

test('stale finish does not reopen persist after a newer hydration began', () => {
  const state = createDraftHydrationState();
  const first = beginDraftHydration(state);
  const second = beginDraftHydration(state);
  finishDraftHydration(state, first);
  assert.equal(state.skipPersist, true);
  finishDraftHydration(state, second);
  assert.equal(state.skipPersist, false);
});

test('persist skipped when fields match baseline (no blank draft recreation)', () => {
  const state = createDraftHydrationState();
  finishDraftHydration(state, state.generation);
  const baseline = { name: '', target: '' };
  assert.equal(
    shouldPersistMutationFormDraft(state, baseline, baseline, fieldsEqual),
    false,
  );
});

test('useMutationForm wires hydration skip before draft persist effect', () => {
  const source = fs.readFileSync(path.join(__dirname, '../src/hooks/useMutationForm.ts'), 'utf8');
  assert.match(source, /beginDraftHydration\(hydrationRef\.current\)/);
  assert.match(source, /finishDraftHydration\(hydrationRef\.current, hydrationGen\)/);
  assert.match(source, /shouldPersistMutationFormDraft/);
  assert.match(source, /rebaselineAfterSuccessRef/);
  const identityIdx = source.indexOf('beginDraftHydration');
  const persistIdx = source.indexOf('shouldPersistMutationFormDraft');
  assert.ok(identityIdx > 0 && persistIdx > identityIdx, 'identity hydration effect precedes persist effect');
});

test('rules and events rebaseline after onSuccessClose field reset', () => {
  for (const rel of ['rules.tsx', 'events.tsx']) {
    const source = fs.readFileSync(path.join(__dirname, '../src/app', rel), 'utf8');
    assert.match(source, /onSuccessClose:/, `${rel} resets fields on success`);
    assert.match(source, /useMutationForm/, `${rel} uses mutation form hook`);
  }
  const formHook = fs.readFileSync(path.join(__dirname, '../src/hooks/useMutationForm.ts'), 'utf8');
  assert.match(formHook, /rebaselineAfterSuccessRef\.current = true/);
  assert.match(formHook, /clearMutationFormDraft/);
});
