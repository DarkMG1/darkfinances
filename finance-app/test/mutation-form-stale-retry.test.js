const test = require('node:test');
const assert = require('node:assert/strict');
const { mutationFieldsEqual } = require('../src/lib/mutation-fields-equal');

function shouldRetryWithStoredVariables(fields, submitted, variables) {
  if (submitted && !mutationFieldsEqual(fields, submitted)) return 'submit';
  if (variables != null) return 'retry';
  return 'submit';
}

test('post-error field edit clears stale retry — next action rebuilds from visible fields', () => {
  const submitted = { match: 'spotify', categoryId: 'cat-1', categoryName: 'Music' };
  const edited = { match: 'spotify', categoryId: 'cat-1', categoryName: 'Music' };
  assert.equal(shouldRetryWithStoredVariables(edited, submitted, { old: true }), 'retry');

  const changed = { match: 'netflix', categoryId: 'cat-1', categoryName: 'Music' };
  assert.equal(shouldRetryWithStoredVariables(changed, submitted, { old: true }), 'submit');
});

test('submitted snapshot binds categoryName for rules retry payload', () => {
  const buildVariables = (f) => ({
    match: String(f.match).trim(),
    categoryId: String(f.categoryId),
    categoryName: String(f.categoryName),
  });
  const submitted = { match: 'uber', categoryId: 'cat-a', categoryName: 'Transport' };
  const vars = buildVariables(submitted);
  assert.equal(vars.categoryName, 'Transport');
  assert.equal(vars.categoryId, 'cat-a');

  const retried = buildVariables({ ...submitted, categoryName: 'Travel' });
  assert.notEqual(retried.categoryName, vars.categoryName);
  assert.equal(
    mutationFieldsEqual(submitted, { match: 'uber', categoryId: 'cat-a', categoryName: 'Transport' }),
    true,
  );
});
