const test = require('node:test');
const assert = require('node:assert/strict');
const {
  UNAVAILABLE_MONEY_LABEL,
  completeMoneySeries,
  isKnownMoney,
  formatOptionalPos,
  formatOptionalMoney,
  formatOptionalSignedMoney,
} = require('../src/lib/money-display.js');

const fmtPos = (n) => `$${n.toFixed(2)}`;
const fmtMoney = (n) => `$${n.toFixed(2)}`;
const fmtSigned = (n) => (n >= 0 ? `+$${n.toFixed(2)}` : `-$${Math.abs(n).toFixed(2)}`);

test('isKnownMoney accepts finite numbers including zero and rejects absent values', () => {
  assert.equal(isKnownMoney(0), true);
  assert.equal(isKnownMoney(12.5), true);
  assert.equal(isKnownMoney(null), false);
  assert.equal(isKnownMoney(undefined), false);
  assert.equal(isKnownMoney(Number.NaN), false);
});

test('formatOptional helpers preserve valid zero and fail closed on absent money', () => {
  assert.equal(formatOptionalPos(0, fmtPos), '$0.00');
  assert.equal(formatOptionalPos(null, fmtPos), UNAVAILABLE_MONEY_LABEL);
  assert.equal(formatOptionalMoney(undefined, fmtMoney), UNAVAILABLE_MONEY_LABEL);
  assert.equal(formatOptionalSignedMoney(0, fmtSigned), '+$0.00');
  assert.equal(formatOptionalSignedMoney(undefined, fmtSigned), UNAVAILABLE_MONEY_LABEL);
});

test('completeMoneySeries rejects partial or non-finite chart data without fabricating points', () => {
  assert.deepEqual(completeMoneySeries([0, 12.5, -3]), [0, 12.5, -3]);
  assert.deepEqual(completeMoneySeries([0, null, 3]), []);
  assert.deepEqual(completeMoneySeries([0, Number.NaN, 3]), []);
  assert.deepEqual(completeMoneySeries(undefined), []);
});
