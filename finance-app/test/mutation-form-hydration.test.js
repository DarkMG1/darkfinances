const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const path = require('path');
const {
  buildMutationFormIdentityKey,
  shouldMarkHydrationReady,
  shouldPersistMutationFormDraft,
} = require('../src/lib/mutation-form-hydration');

function fieldsEqual(a, b) {
  return JSON.stringify(a) === JSON.stringify(b);
}

test('persist blocked until hydration ready identity matches current identity', () => {
  const current = buildMutationFormIdentityKey('scope', 1, 'events-create');
  const fields = { name: 'pre-hydration' };
  const baseline = { name: '' };
  assert.equal(
    shouldPersistMutationFormDraft(null, current, fields, baseline, fieldsEqual, false),
    false,
  );
  assert.equal(
    shouldPersistMutationFormDraft('scope:1:other', current, fields, baseline, fieldsEqual, false),
    false,
  );
});

test('persist blocked while identity matches but rendered fields lag hydration target', () => {
  const key = buildMutationFormIdentityKey('demo', 0, 'goals-new');
  const target = { name: 'Draft goal', target: '500' };
  const laggingFields = { name: 'Live', target: '500' };
  assert.equal(
    shouldMarkHydrationReady(key, key, laggingFields, target, fieldsEqual),
    false,
  );
  assert.equal(
    shouldPersistMutationFormDraft(null, key, laggingFields, target, fieldsEqual, false),
    false,
  );
  const hydratedFields = { name: 'Draft goal', target: '500' };
  assert.equal(
    shouldMarkHydrationReady(key, key, hydratedFields, target, fieldsEqual),
    true,
  );
});

test('user edit immediately after target render can persist without frame or timer gate', () => {
  const key = buildMutationFormIdentityKey('demo', 0, 'goals-new');
  const target = { name: '', target: '' };
  const edited = { name: 'typed', target: '' };
  assert.equal(
    shouldPersistMutationFormDraft(key, key, edited, target, fieldsEqual, false),
    true,
  );
});

test('rapid identity A to B blocks persist until B hydration ready', () => {
  const keyA = buildMutationFormIdentityKey('demo', 0, 'form-a');
  const keyB = buildMutationFormIdentityKey('demo', 0, 'form-b');
  const targetB = { name: 'B draft' };
  assert.equal(
    shouldPersistMutationFormDraft(keyA, keyB, { name: 'stale A' }, targetB, fieldsEqual, false),
    false,
  );
  assert.equal(
    shouldPersistMutationFormDraft(keyB, keyB, { name: 'B draft edit' }, targetB, fieldsEqual, false),
    true,
  );
});

test('success rebaseline suppresses persist while reset fields differ from old baseline', () => {
  const key = buildMutationFormIdentityKey('demo', 0, 'rules-add');
  const oldBaseline = { match: 'spotify', categoryId: 'cat-1' };
  const resetFields = { match: '', categoryId: '' };
  assert.equal(
    shouldPersistMutationFormDraft(key, key, resetFields, oldBaseline, fieldsEqual, true),
    false,
  );
  assert.equal(
    shouldPersistMutationFormDraft(key, key, resetFields, resetFields, fieldsEqual, false),
    false,
  );
});

test('persist skipped when fields match baseline or rebaseline suppression active', () => {
  const key = buildMutationFormIdentityKey('demo', 0, 'rules-add');
  const baseline = { match: '', categoryId: '' };
  assert.equal(
    shouldPersistMutationFormDraft(key, key, baseline, baseline, fieldsEqual, false),
    false,
  );
  assert.equal(
    shouldPersistMutationFormDraft(key, key, { match: 'x' }, baseline, fieldsEqual, true),
    false,
  );
});

test('useMutationForm wires hydration target, layout ready gate, and suppressPersist for success rebaseline', () => {
  const source = fs.readFileSync(path.join(__dirname, '../src/hooks/useMutationForm.ts'), 'utf8');
  assert.match(source, /hydrationReadyIdentity/);
  assert.match(source, /hydrationTargetRef/);
  assert.match(source, /useLayoutEffect/);
  assert.match(source, /setHydrationReadyIdentity\(formIdentityKey\)/);
  assert.match(source, /buildMutationFormIdentityKey/);
  assert.match(source, /suppressPersistRef/);
  assert.match(source, /rebaselineAfterSuccessRef/);
  assert.match(source, /rebaselineAfterSuccessRef\.current/);
  assert.doesNotMatch(source, /requestAnimationFrame\(\(\) => \{\s*finishDraftHydration/);
  assert.doesNotMatch(source, /beginDraftHydration/);
  assert.doesNotMatch(source, /setHydratedIdentity/);
});

test('rules and events rebaseline after onSuccessClose with stable formId', () => {
  for (const rel of ['rules.tsx', 'events.tsx']) {
    const source = fs.readFileSync(path.join(__dirname, '../src/app', rel), 'utf8');
    assert.match(source, /onSuccessClose:/, `${rel} resets fields on success`);
    assert.match(source, /formId: '(rules-add|events-create)'/, `${rel} uses stable formId`);
  }
  const goals = fs.readFileSync(path.join(__dirname, '../src/app/goals.tsx'), 'utf8');
  assert.match(goals, /formId: editing\?\.isNew \? 'goals-new' : `goals-edit-\$\{editing\?\.id/, 'identity-changing sheet uses distinct formId');
  const networth = fs.readFileSync(path.join(__dirname, '../src/app/networth.tsx'), 'utf8');
  assert.match(networth, /manualSessionId/, 'networth manual sheet rotates formId per open');
  const formHook = fs.readFileSync(path.join(__dirname, '../src/hooks/useMutationForm.ts'), 'utf8');
  assert.match(formHook, /suppressPersistRef\.current = true/);
  assert.match(formHook, /clearMutationFormDraft/);
});

test('account edit rebaselines without clearing fields to blank on success', () => {
  const source = fs.readFileSync(path.join(__dirname, '../src/app/account/[id].tsx'), 'utf8');
  assert.match(source, /useMutationForm/);
  assert.match(source, /onSuccessClose:/);
  assert.doesNotMatch(source, /onSuccessClose: \(\) => \{\s*setNameText\(''\)/);
});

test('transaction date picker and receipt controls respect modalLocked coordinator lock', () => {
  const source = fs.readFileSync(path.join(__dirname, '../src/app/transaction/[id].tsx'), 'utf8');
  assert.match(source, /dateSaving = modalLocked && screen\.activeKey === 'date'/);
  assert.doesNotMatch(source, /dateAction\.isPending/);
  assert.match(source, /receiptViewerLocked = modalLocked \|\| receiptDeleting/);
  assert.match(source, /disabled={modalLocked}/);
  assert.match(source, /if \(modalLocked\) return;/);
});
