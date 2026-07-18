const test = require('node:test');
const assert = require('node:assert/strict');
const {
  mapContractIssuesToFieldErrors,
  mapContractPathToField,
  firstInvalidField,
  FORM_SCREEN_PATH_OVERRIDES,
} = require('../src/lib/mutation-form-field-paths');

test('contract paths map to form field keys', () => {
  assert.equal(mapContractPathToField('amount'), 'amount');
  assert.equal(mapContractPathToField('legs.0.categoryId'), 'leg-0');
  assert.equal(mapContractPathToField('legs[1].amount'), 'leg-1');
  assert.equal(mapContractPathToField('body'), 'request');
  assert.equal(mapContractPathToField('imageBase64'), 'request');
});

test('budgets maps server amount path to targetText', () => {
  assert.equal(mapContractPathToField('amount', FORM_SCREEN_PATH_OVERRIDES.budgets), 'targetText');
  const fieldErrors = mapContractIssuesToFieldErrors(
    [{ path: 'amount', message: 'money value must use whole cents' }],
    FORM_SCREEN_PATH_OVERRIDES.budgets,
  );
  assert.equal(fieldErrors.targetText, 'money value must use whole cents');
  assert.equal(firstInvalidField(fieldErrors, ['targetText']), 'targetText');
});

test('form path alias inventory covers audited screens', () => {
  assert.deepEqual(FORM_SCREEN_PATH_OVERRIDES.budgets, { amount: 'targetText' });
});

test('issues dedupe to first field message', () => {
  const fieldErrors = mapContractIssuesToFieldErrors([
    { path: 'date', message: 'invalid date' },
    { path: 'date', message: 'second' },
  ]);
  assert.equal(fieldErrors.date, 'invalid date');
});

test('firstInvalidField respects field order', () => {
  assert.equal(firstInvalidField({ notes: 'x', amount: 'y' }, ['amount', 'notes']), 'amount');
});
