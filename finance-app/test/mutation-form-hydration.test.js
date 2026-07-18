const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const path = require('path');
const {
  buildMutationFormIdentityKey,
  shouldPersistMutationFormDraft,
} = require('../src/lib/mutation-form-hydration');

function fieldsEqual(a, b) {
  return JSON.stringify(a) === JSON.stringify(b);
}

test('persist blocked until hydrated identity matches current identity', () => {
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
  assert.equal(
    shouldPersistMutationFormDraft(current, current, { name: 'user edit' }, baseline, fieldsEqual, false),
    true,
  );
});

test('user edit immediately after hydration can persist without extra frame gate', () => {
  const key = buildMutationFormIdentityKey('demo', 0, 'goals-new');
  assert.equal(
    shouldPersistMutationFormDraft(key, key, { name: 'typed' }, { name: '' }, fieldsEqual, false),
    true,
  );
});

test('persist skipped when fields match baseline or success suppression active', () => {
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

test('useMutationForm wires hydratedIdentity gate and suppressPersist for success rebaseline', () => {
  const source = fs.readFileSync(path.join(__dirname, '../src/hooks/useMutationForm.ts'), 'utf8');
  assert.match(source, /hydratedIdentity/);
  assert.match(source, /setHydratedIdentity\(formIdentityKey\)/);
  assert.match(source, /buildMutationFormIdentityKey/);
  assert.match(source, /suppressPersistRef/);
  assert.match(source, /rebaselineAfterSuccessRef/);
  assert.doesNotMatch(source, /requestAnimationFrame\(\(\) => \{\s*finishDraftHydration/);
  assert.doesNotMatch(source, /beginDraftHydration/);
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
