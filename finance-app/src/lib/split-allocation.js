'use strict';

const MAX_SPLIT_LEGS = 100;
const MAX_SAFE_CENTS = BigInt(Number.MAX_SAFE_INTEGER);
const MIN_SAFE_CENTS = -MAX_SAFE_CENTS;
const MODES = new Set(['equal', 'specific', 'percent']);

function isSafeCents(value) {
  return Number.isSafeInteger(value) && !Object.is(value, -0);
}

function dollarsToIntegerCents(value) {
  if (typeof value !== 'number' || !Number.isFinite(value) || Object.is(value, -0)) return null;
  const cents = Math.round(value * 100);
  if (!Number.isSafeInteger(cents) || !Object.is(cents / 100, value)) return null;
  return cents;
}

function centsToDollars(cents) {
  if (!isSafeCents(cents)) throw new TypeError('cents must be a safe integer');
  return cents / 100;
}

function parseStrictSpecificCents(text) {
  if (typeof text !== 'string' || text.length === 0 || text.length > 64) return null;
  if (!/^\d+(?:\.\d{1,2})?$/.test(text)) return null;

  const [whole, fraction = ''] = text.split('.');
  const cents = (BigInt(whole) * 100n) + BigInt(fraction.padEnd(2, '0'));
  return cents <= MAX_SAFE_CENTS ? Number(cents) : null;
}

function parseStrictPercent(text) {
  if (typeof text !== 'string' || text.length === 0 || text.length > 64) return null;
  if (!/^\d+(?:\.\d+)?$/.test(text)) return null;

  const [whole, fraction = ''] = text.split('.');
  const scale = 10n ** BigInt(fraction.length);
  const numerator = (BigInt(whole) * scale) + BigInt(fraction || '0');
  if (numerator > 100n * scale) return null;
  return { numerator, scale };
}

function roundPositiveRatio(numerator, denominator) {
  const quotient = numerator / denominator;
  const remainder = numerator % denominator;
  return quotient + (remainder * 2n >= denominator ? 1n : 0n);
}

function formatSplitDollars(cents) {
  if (!isSafeCents(cents)) throw new TypeError('cents must be a safe integer');
  const sign = cents < 0 ? '-' : '';
  const magnitude = Math.abs(cents);
  return `${sign}${Math.floor(magnitude / 100)}.${String(magnitude % 100).padStart(2, '0')}`;
}

function formatSplitPercent(cents, totalCents, decimalPlaces = 2) {
  if (!isSafeCents(cents) || !isSafeCents(totalCents) || totalCents === 0) return '';
  if (!Number.isInteger(decimalPlaces) || decimalPlaces < 0 || decimalPlaces > 6) {
    throw new RangeError('decimal places must be an integer from 0 through 6');
  }

  const scale = 10n ** BigInt(decimalPlaces);
  const scaled = roundPositiveRatio(
    BigInt(Math.abs(cents)) * 100n * scale,
    BigInt(Math.abs(totalCents)),
  );
  const whole = scaled / scale;
  const fraction = decimalPlaces
    ? String(scaled % scale).padStart(decimalPlaces, '0').replace(/0+$/, '')
    : '';
  const sign = cents < 0 ? '-' : '';
  return `${sign}${whole}${fraction ? `.${fraction}` : ''}`;
}

function invalidAllocation(parentCents = null) {
  return {
    parentCents,
    legCents: null,
    displayCents: null,
    inputValid: false,
    conservesCents: false,
    allLegsPositive: false,
    canSave: false,
  };
}

function safeBigIntToNumber(value) {
  if (value < MIN_SAFE_CENTS || value > MAX_SAFE_CENTS) return null;
  return Number(value);
}

function signedCents(value, sign) {
  return value === 0 ? 0 : value * sign;
}

/**
 * Produces the one canonical split allocation used for display and submission.
 * The parent and returned legs are signed integer cents. Specific and percentage
 * inputs are unsigned magnitudes; index zero is always the computed remainder.
 */
function allocateSplitCents(parentCents, mode, legs) {
  if (!isSafeCents(parentCents)) return invalidAllocation();
  if (!MODES.has(mode) || !Array.isArray(legs) || legs.length < 1 || legs.length > MAX_SPLIT_LEGS) {
    return invalidAllocation(parentCents);
  }

  const totalMagnitude = Math.abs(parentCents);
  const sign = parentCents < 0 ? -1 : 1;
  let magnitudes;

  if (mode === 'equal') {
    const quotient = Math.floor(totalMagnitude / legs.length);
    const remainder = totalMagnitude % legs.length;
    magnitudes = legs.map((_, index) => quotient + (index < remainder ? 1 : 0));
  } else {
    magnitudes = Array(legs.length).fill(0);
    let assigned = 0n;

    for (let index = 1; index < legs.length; index += 1) {
      let cents;
      if (mode === 'specific') {
        cents = parseStrictSpecificCents(legs[index]?.amount);
      } else {
        const percent = parseStrictPercent(legs[index]?.percent);
        if (percent) {
          const rounded = roundPositiveRatio(
            BigInt(totalMagnitude) * percent.numerator,
            100n * percent.scale,
          );
          cents = safeBigIntToNumber(rounded);
        } else {
          cents = null;
        }
      }

      if (cents == null) return invalidAllocation(parentCents);
      magnitudes[index] = cents;
      assigned += BigInt(cents);
    }

    const remainder = safeBigIntToNumber(BigInt(totalMagnitude) - assigned);
    if (remainder == null) return invalidAllocation(parentCents);
    magnitudes[0] = remainder;
  }

  const legCents = magnitudes.map((cents) => signedCents(cents, sign));
  const displayCents = legCents.map((cents) => signedCents(cents, sign));
  const sum = legCents.reduce((total, cents) => total + BigInt(cents), 0n);
  const conservesCents = sum === BigInt(parentCents);
  const allLegsPositive = displayCents.every((cents) => cents > 0);

  return {
    parentCents,
    legCents,
    displayCents,
    inputValid: true,
    conservesCents,
    allLegsPositive,
    canSave: legs.length >= 2 && conservesCents && allLegsPositive,
  };
}

module.exports = {
  MAX_SPLIT_LEGS,
  allocateSplitCents,
  centsToDollars,
  dollarsToIntegerCents,
  formatSplitDollars,
  formatSplitPercent,
  parseStrictPercent,
  parseStrictSpecificCents,
};
