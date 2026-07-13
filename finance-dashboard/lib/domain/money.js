'use strict';

function toCents(value) {
  if (typeof value !== 'number' || !Number.isFinite(value)) {
    throw new TypeError('money value must be a finite number');
  }
  if (Object.is(value, -0)) throw new RangeError('money value must not be negative zero');
  const cents = Math.round(value * 100);
  if (!Number.isSafeInteger(cents)) throw new RangeError('money value is outside the safe integer range');
  if (!Object.is(cents / 100, value)) throw new RangeError('money value has more than two decimal places');
  return cents;
}

function fromCents(cents) {
  if (!Number.isSafeInteger(cents)) throw new TypeError('cents must be a safe integer');
  return cents / 100;
}

function sumCents(values) {
  return values.reduce((total, value) => {
    if (!Number.isSafeInteger(value)) throw new TypeError('cents must be safe integers');
    const next = total + value;
    if (!Number.isSafeInteger(next)) throw new RangeError('cent sum is outside the safe integer range');
    return next;
  }, 0);
}

function roundDollars(value) {
  return fromCents(Math.round(Number(value) * 100));
}

module.exports = { toCents, fromCents, sumCents, roundDollars };
