'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const {
  MAX_SPLIT_LEGS,
  allocateSplitCents,
  centsToDollars,
  dollarsToIntegerCents,
  formatSplitDollars,
  formatSplitPercent,
  parseStrictPercent,
  parseStrictSpecificCents,
} = require('../src/lib/split-allocation.js');

const blankLegs = (count) => Array.from({ length: count }, () => ({ amount: '', percent: '' }));
const sum = (values) => values.reduce((total, value) => total + value, 0);

test('specific-dollar and percentage parsers accept only complete strict decimals', () => {
  assert.equal(parseStrictSpecificCents('0'), 0);
  assert.equal(parseStrictSpecificCents('0.01'), 1);
  assert.equal(parseStrictSpecificCents('29'), 2900);
  assert.equal(parseStrictSpecificCents('29.5'), 2950);
  assert.equal(parseStrictSpecificCents('29.50'), 2950);

  for (const malformed of ['', '.29', '29.', '1.2.3', '1..2', '1.234', ' 1.00', '1,00', '-1']) {
    assert.equal(parseStrictSpecificCents(malformed), null, malformed);
  }

  for (const valid of ['0', '12.5', '33.333333333333', '100', '100.000']) {
    assert.notEqual(parseStrictPercent(valid), null, valid);
  }
  for (const malformed of ['', '.5', '50.', '1.2.3', '1..2', '100.001', '101', ' 50', '-1']) {
    assert.equal(parseStrictPercent(malformed), null, malformed);
  }
});

test('malformed multi-dot input fails closed and can never enable save', () => {
  const specific = allocateSplitCents(1000, 'specific', [
    { amount: '', percent: '' },
    { amount: '5.0.0', percent: '' },
  ]);
  assert.equal(specific.inputValid, false);
  assert.equal(specific.legCents, null);
  assert.equal(specific.canSave, false);

  const percent = allocateSplitCents(1000, 'percent', [
    { amount: '', percent: '' },
    { amount: '', percent: '50.0.0' },
  ]);
  assert.equal(percent.inputValid, false);
  assert.equal(percent.legCents, null);
  assert.equal(percent.canSave, false);
});

test('parent dollars convert once to signed integer cents', () => {
  assert.equal(dollarsToIntegerCents(0.01), 1);
  assert.equal(dollarsToIntegerCents(0.29), 29);
  assert.equal(dollarsToIntegerCents(-0.29), -29);
  assert.equal(dollarsToIntegerCents(0.291), null);
  assert.equal(dollarsToIntegerCents(Number.NaN), null);
  assert.equal(dollarsToIntegerCents(-0), null);

  assert.equal(allocateSplitCents(29.5, 'equal', blankLegs(2)).legCents, null);
});

test('equal allocation handles one cent and all 1 through 100 leg counts deterministically', () => {
  const oneLeg = allocateSplitCents(1, 'equal', blankLegs(1));
  assert.deepEqual(oneLeg.legCents, [1]);
  assert.equal(oneLeg.canSave, false);

  const twoLegs = allocateSplitCents(1, 'equal', blankLegs(2));
  assert.deepEqual(twoLegs.legCents, [1, 0]);
  assert.equal(twoLegs.canSave, false);

  for (let legCount = 1; legCount <= MAX_SPLIT_LEGS; legCount += 1) {
    const totalCents = 10_003;
    const expected = Array.from(
      { length: legCount },
      (_, index) => Math.floor(totalCents / legCount) + (index < totalCents % legCount ? 1 : 0),
    );
    const first = allocateSplitCents(totalCents, 'equal', blankLegs(legCount));
    const second = allocateSplitCents(totalCents, 'equal', blankLegs(legCount));

    assert.deepEqual(first.legCents, expected, `${legCount} legs`);
    assert.deepEqual(second.legCents, expected, `${legCount} legs repeat`);
    assert.equal(sum(first.legCents), totalCents);
    assert.ok(first.legCents.every(Number.isSafeInteger));
    assert.ok(Math.max(...first.legCents) - Math.min(...first.legCents) <= 1);
  }

  assert.equal(allocateSplitCents(1000, 'equal', blankLegs(101)).legCents, null);
});

test('$0.29 divided into 29 equal legs is exactly one cent per leg', () => {
  const allocation = allocateSplitCents(29, 'equal', blankLegs(29));
  assert.deepEqual(allocation.legCents, Array(29).fill(1));
  assert.equal(allocation.canSave, true);
});

test('negative parents preserve their sign while display cents remain magnitudes', () => {
  const equal = allocateSplitCents(-29, 'equal', blankLegs(29));
  assert.deepEqual(equal.legCents, Array(29).fill(-1));
  assert.deepEqual(equal.displayCents, Array(29).fill(1));
  assert.equal(sum(equal.legCents), -29);
  assert.equal(equal.canSave, true);

  const specific = allocateSplitCents(-100, 'specific', [
    { amount: '', percent: '' },
    { amount: '0.29', percent: '' },
    { amount: '0.30', percent: '' },
  ]);
  assert.deepEqual(specific.legCents, [-41, -29, -30]);
  assert.deepEqual(specific.displayCents, [41, 29, 30]);
});

test('percentage allocation rounds half cents deterministically and leaves the exact remainder', () => {
  const halfOfOneCent = allocateSplitCents(1, 'percent', [
    { amount: '', percent: '' },
    { amount: '', percent: '50' },
  ]);
  assert.deepEqual(halfOfOneCent.legCents, [0, 1]);
  assert.equal(halfOfOneCent.canSave, false);

  const halfOfTwentyNine = allocateSplitCents(29, 'percent', [
    { amount: '', percent: '' },
    { amount: '', percent: '50' },
  ]);
  assert.deepEqual(halfOfTwentyNine.legCents, [14, 15]);

  const thirds = allocateSplitCents(5, 'percent', [
    { amount: '', percent: '' },
    { amount: '', percent: '33.33' },
    { amount: '', percent: '33.33' },
  ]);
  assert.deepEqual(thirds.legCents, [1, 2, 2]);

  const signed = allocateSplitCents(-29, 'percent', [
    { amount: '', percent: '' },
    { amount: '', percent: '50' },
  ]);
  assert.deepEqual(signed.legCents, [-14, -15]);
});

test('specific, percent, and equal allocations conserve integer cents across bounded properties', () => {
  for (const sign of [1, -1]) {
    for (let totalCents = 1; totalCents <= 503; totalCents += 17) {
      for (let legCount = 1; legCount <= MAX_SPLIT_LEGS; legCount += 1) {
        const allocation = allocateSplitCents(sign * totalCents, 'equal', blankLegs(legCount));
        assert.ok(allocation.legCents.every(Number.isSafeInteger));
        assert.equal(sum(allocation.legCents), sign * totalCents);
      }
    }

    for (let legCount = 1; legCount <= MAX_SPLIT_LEGS; legCount += 1) {
      const totalCents = (legCount * 100) + 17;
      const specificLegs = blankLegs(legCount).map((leg, index) => (
        index === 0 ? leg : { ...leg, amount: formatSplitDollars((index % 7) + 1) }
      ));
      const specific = allocateSplitCents(sign * totalCents, 'specific', specificLegs);
      assert.ok(specific.legCents.every(Number.isSafeInteger));
      assert.equal(sum(specific.legCents), sign * totalCents);

      const percentLegs = blankLegs(legCount).map((leg, index) => (
        index === 0 ? leg : { ...leg, percent: `${index % 3}.125` }
      ));
      const percent = allocateSplitCents(sign * totalCents, 'percent', percentLegs);
      assert.ok(percent.legCents.every(Number.isSafeInteger));
      assert.equal(sum(percent.legCents), sign * totalCents);
    }
  }
});

test('visible formatting and submitted dollars come from the same canonical cents', () => {
  const allocation = allocateSplitCents(-100, 'specific', [
    { amount: '', percent: '' },
    { amount: '0.29', percent: '' },
    { amount: '0.30', percent: '' },
  ]);
  const visible = allocation.displayCents.map(formatSplitDollars);
  const submitted = allocation.legCents.map(centsToDollars);

  assert.deepEqual(visible, ['0.41', '0.29', '0.30']);
  assert.deepEqual(submitted, [-0.41, -0.29, -0.3]);
  assert.deepEqual(
    submitted.map((dollars) => formatSplitDollars(dollarsToIntegerCents(Math.abs(dollars)))),
    visible,
  );
  assert.equal(formatSplitPercent(allocation.displayCents[0], 100), '41');
  assert.equal(sum(allocation.legCents), allocation.parentCents);
});

test('split editor wires display, save admission, and payload to the canonical allocation', () => {
  const source = fs.readFileSync(path.join(__dirname, '../src/app/split/[id].tsx'), 'utf8');

  assert.match(source, /const amountsCents = allocation\.displayCents;/);
  assert.match(source, /const canSave = allocation\.canSave;/);
  assert.match(source, /const legCents = allocation\.legCents;/);
  assert.match(source, /amount: centsToDollars\(legCents\[i\]\)/);
  assert.match(source, /disabled=\{!canSave \|\| mutationLocked\}/);
  assert.doesNotMatch(source, /parseFloat|function computeAmounts/);
});
