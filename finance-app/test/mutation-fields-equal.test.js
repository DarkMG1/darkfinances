const test = require('node:test');
const assert = require('node:assert/strict');
const { mutationFieldsEqual } = require('../src/lib/mutation-fields-equal');

test('mutationFieldsEqual treats key-order equivalent objects as equal', () => {
  assert.equal(
    mutationFieldsEqual({ a: 1, b: { c: 2, d: 3 } }, { b: { d: 3, c: 2 }, a: 1 }),
    true,
  );
});

test('mutationFieldsEqual distinguishes nested value changes', () => {
  assert.equal(
    mutationFieldsEqual({ meta: { x: 1 } }, { meta: { x: 2 } }),
    false,
  );
});

test('mutationFieldsEqual handles arrays with order sensitivity via canonical json', () => {
  assert.equal(mutationFieldsEqual([1, 2], [2, 1]), false);
  assert.equal(mutationFieldsEqual([1, 2], [1, 2]), true);
});
