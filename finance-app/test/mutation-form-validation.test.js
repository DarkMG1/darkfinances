const test = require('node:test');
const assert = require('node:assert/strict');
const {
  parseStrictMoneyDollars,
  validateMoneyField,
  validateDateOnlyField,
  validateAllocationField,
} = require('../src/lib/mutation-form-validation');

test('strict money rejects commas and extra decimals', () => {
  assert.equal(parseStrictMoneyDollars('12.345'), null);
  assert.equal(parseStrictMoneyDollars('1,234.00'), null);
  assert.equal(parseStrictMoneyDollars('20.50'), 20.5);
});

test('validateMoneyField mirrors server cent rules', () => {
  assert.match(validateMoneyField(''), /required/i);
  assert.match(validateMoneyField('0'), /positive/i);
  assert.equal(validateMoneyField('10.00', { allowZero: true }), null);
});

test('validateDateOnlyField requires real calendar dates', () => {
  assert.match(validateDateOnlyField('2026-02-30'), /real date/i);
  assert.equal(validateDateOnlyField('2026-06-30'), null);
});

test('validateAllocationField matches allocation parser', () => {
  assert.equal(validateAllocationField('20.50'), null);
  assert.match(validateAllocationField('20.999'), /two decimal/i);
});
