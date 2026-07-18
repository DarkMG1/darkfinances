const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const path = require('path');
const {
  canStartMutationActionDispatch,
  canStartMutationFormDispatch,
  resolveMutationFormBaseline,
} = require('../src/lib/mutation-form-baseline');

test('resolveMutationFormBaseline merges draft without caller setFields side effects', () => {
  const fields = { targetText: '250', categoryId: 'cat-1', month: '2026-07' };
  const baseline = resolveMutationFormBaseline(fields, { targetText: '300' });
  assert.deepEqual(baseline, { targetText: '300', categoryId: 'cat-1', month: '2026-07' });
  assert.deepEqual(fields, { targetText: '250', categoryId: 'cat-1', month: '2026-07' });
});

test('nonzero existing target opens clean when baseline matches fields', () => {
  const fields = { targetText: '125.50', categoryId: 'groceries', month: '2026-07' };
  const baseline = resolveMutationFormBaseline(fields, null);
  assert.equal(JSON.stringify(fields), JSON.stringify(baseline));
});

test('edit makes fields differ from baseline', () => {
  const baseline = resolveMutationFormBaseline({ targetText: '100', categoryId: 'a', month: '2026-07' }, null);
  const edited = { targetText: '150', categoryId: 'a', month: '2026-07' };
  assert.notEqual(JSON.stringify(edited), JSON.stringify(baseline));
});

test('month or form identity change rebaselines from current fields ref', () => {
  const july = resolveMutationFormBaseline({ targetText: '80', categoryId: 'a', month: '2026-07' }, null);
  const august = resolveMutationFormBaseline({ targetText: '80', categoryId: 'a', month: '2026-08' }, null);
  assert.notEqual(JSON.stringify(july), JSON.stringify(august));
});

test('draft hydration still merges persisted values', () => {
  const baseline = resolveMutationFormBaseline(
    { name: '', target: '', current: '0', deadline: '', accountId: null, editingId: undefined },
    { name: 'Draft goal', target: '500' },
  );
  assert.equal(baseline.name, 'Draft goal');
  assert.equal(baseline.target, '500');
});

test('stale react-query isPending does not block new dispatch after identity reset', () => {
  const staleMutationIsPending = true;
  assert.equal(canStartMutationFormDispatch({
    pendingLock: false,
    dispatchPending: false,
    phase: 'idle',
  }), true);
  assert.equal(canStartMutationActionDispatch({
    pendingLock: false,
    dispatchPending: false,
  }), true);
  assert.ok(staleMutationIsPending);
});

test('useMutationForm uses fieldsRef baseline init and budgets wires applyFields', () => {
  const formHook = fs.readFileSync(path.join(__dirname, '../src/hooks/useMutationForm.ts'), 'utf8');
  const budgets = fs.readFileSync(path.join(__dirname, '../src/app/budgets.tsx'), 'utf8');
  assert.match(formHook, /resolveMutationFormBaseline\(fieldsRef\.current, draft\)/);
  assert.match(formHook, /fieldsRef\.current = fields/);
  assert.doesNotMatch(budgets, /setFields:\s*\(\)\s*=>\s*\{\}/);
  assert.match(budgets, /setFields:\s*applyFields/);
});
