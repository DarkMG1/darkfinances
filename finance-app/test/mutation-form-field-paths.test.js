const test = require('node:test');
const assert = require('node:assert/strict');
const {
  mapContractIssuesToFieldErrors,
  mapContractPathToField,
  firstInvalidField,
} = require('../src/lib/mutation-form-field-paths');

test('contract paths map to form field keys', () => {
  assert.equal(mapContractPathToField('amount'), 'amount');
  assert.equal(mapContractPathToField('legs.0.categoryId'), 'legs');
  assert.equal(mapContractPathToField('body'), 'request');
  assert.equal(mapContractPathToField('imageBase64'), 'request');
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
