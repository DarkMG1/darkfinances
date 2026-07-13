'use strict';

function toCents(value) {
  const number = Number(value);
  if (!Number.isFinite(number)) throw new TypeError('money value must be finite');
  const cents = Math.round(number * 100);
  if (Math.abs(number * 100 - cents) > 1e-7) throw new RangeError('money value has more than two decimal places');
  if (!Number.isSafeInteger(cents)) throw new RangeError('money value is outside the safe integer range');
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
