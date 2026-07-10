const test = require('node:test');
const assert = require('node:assert/strict');
const { oneCurrency, resolveGroup, slugForName } = require('../splitwise-lib');

const groups = [
  { id: 1, name: 'Summer Trip' },
  { id: 2, name: 'Summer Trip Planning' },
  { id: 3, name: 'Apartment' },
];

test('group resolution prefers numeric and exact names and rejects ambiguity', () => {
  assert.equal(resolveGroup(groups, 2).id, 2);
  assert.equal(resolveGroup(groups, 'summer trip').id, 1);
  assert.equal(resolveGroup(groups, 'apartment').id, 3);
  assert.throws(() => resolveGroup(groups, 'summer'), /multiple/);
});

test('currency helper never silently adds unlike currencies', () => {
  assert.deepEqual(oneCurrency([{ amount: '10.25', currency_code: 'USD' }], 'test'), {
    amount: 10.25,
    currency: 'USD',
  });
  assert.throws(
    () => oneCurrency([
      { amount: '10', currency_code: 'USD' },
      { amount: '5', currency_code: 'EUR' },
    ], 'test'),
    /multiple currencies/
  );
});

test('empty names never create an undefined identity', () => {
  assert.equal(slugForName(''), null);
  assert.equal(slugForName('Alex Example'), 'alex');
});
