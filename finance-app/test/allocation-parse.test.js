const test = require('node:test');
const assert = require('node:assert/strict');
const { formatAllocationDollars, parseStrictAllocationDollars } = require('../src/lib/allocation-parse.js');

test('parseStrictAllocationDollars accepts up to two decimal places', () => {
  assert.equal(parseStrictAllocationDollars('20'), 2000);
  assert.equal(parseStrictAllocationDollars('20.5'), 2050);
  assert.equal(parseStrictAllocationDollars('20.50'), 2050);
  assert.equal(formatAllocationDollars(2050), '20.50');
});

test('parseStrictAllocationDollars rejects unsafe input', () => {
  assert.equal(parseStrictAllocationDollars(''), null);
  assert.equal(parseStrictAllocationDollars('10.999'), null);
  assert.equal(parseStrictAllocationDollars('10,50'), null);
  assert.equal(parseStrictAllocationDollars('abc'), null);
  assert.equal(parseStrictAllocationDollars('NaN'), null);
});
