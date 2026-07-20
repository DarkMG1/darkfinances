'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const path = require('path');
const { daysUntilDateOnly } = require('../src/lib/finance-date-core.js');

const colorsSource = fs.readFileSync(path.resolve(__dirname, '../src/theme/colors.ts'), 'utf8');

const fmtDay = (d) => {
  if (!d) return 'Date uncertain';
  const [y, m, day] = d.split('-').map(Number);
  if (!y) return d;
  return new Date(y, m - 1, day).toLocaleDateString('en-US', { month: 'short', day: 'numeric' });
};
const daysUntil = (d, anchor) => {
  if (!d) return null;
  return daysUntilDateOnly(d, anchor);
};
const dueLabel = (d, anchor) => {
  if (!d) return 'date uncertain';
  const n = daysUntil(d, anchor);
  if (n == null) return 'date uncertain';
  if (n < 0) return `${-n}d overdue`;
  if (n === 0) return 'today';
  if (n === 1) return 'tomorrow';
  if (n < 14) return `in ${n}d`;
  return fmtDay(d);
};

test('colors.ts keeps nullable nextRenewal guards for dueLabel and daysUntil', () => {
  assert.match(colorsSource, /if \(!d\) return 'date uncertain'/);
  assert.match(colorsSource, /if \(!d\) return null/);
  assert.match(colorsSource, /if \(!d\) return 'Date uncertain'/);
});

test('dueLabel(null) reports date uncertain, never today', () => {
  assert.equal(dueLabel(null), 'date uncertain');
  assert.equal(dueLabel(undefined), 'date uncertain');
  assert.equal(dueLabel(''), 'date uncertain');
  assert.notEqual(dueLabel(null), 'today');
});

test('daysUntil(null) is null so callers cannot treat unknown dates as due today', () => {
  assert.equal(daysUntil(null), null);
  assert.equal(daysUntil(undefined), null);
});

test('fmtDay(null) renders unavailable renewal copy for detail screens', () => {
  assert.equal(fmtDay(null), 'Date uncertain');
});

test('dueLabel keeps relative labels for known finance dates', () => {
  assert.equal(dueLabel('2026-07-09', '2026-07-09'), 'today');
  assert.equal(dueLabel('2026-07-10', '2026-07-09'), 'tomorrow');
  assert.equal(dueLabel('2026-07-11', '2026-07-09'), 'in 2d');
});
