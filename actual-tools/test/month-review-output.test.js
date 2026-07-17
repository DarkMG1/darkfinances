'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const path = require('path');
const { monthReviewRealSpendTotalLine } = require('../lib/real-spend-total-line');

const toolsRoot = path.resolve(__dirname, '..');
const monthReviewSource = fs.readFileSync(path.join(toolsRoot, 'month-review.js'), 'utf8');

test('complete genuine zero uses authoritative total label', () => {
  const line = monthReviewRealSpendTotalLine(0, { incomplete: false });
  assert.equal(line, '### REAL SPEND TOTAL: $0.00');
  assert.doesNotMatch(line, /UNAVAILABLE|known_lower_bound|INCOMPLETE/);
});

test('complete nonzero uses authoritative total label', () => {
  const line = monthReviewRealSpendTotalLine(12345, { incomplete: false });
  assert.equal(line, '### REAL SPEND TOTAL: $123.45');
  assert.doesNotMatch(line, /UNAVAILABLE|known_lower_bound|INCOMPLETE/);
});

test('incomplete nonzero uses known lower bound not authoritative total', () => {
  const line = monthReviewRealSpendTotalLine(50000, { incomplete: true });
  assert.match(line, /REAL SPEND TOTAL — INCOMPLETE/);
  assert.match(line, /known_lower_bound=\$500\.00/);
  assert.match(line, /authoritative_total=UNAVAILABLE/);
  assert.doesNotMatch(line, /^### REAL SPEND TOTAL: \$500\.00$/);
});

test('incomplete zero still marks authoritative total unavailable', () => {
  const line = monthReviewRealSpendTotalLine(0, { incomplete: true });
  assert.match(line, /known_lower_bound=\$0\.00/);
  assert.match(line, /authoritative_total=UNAVAILABLE/);
  assert.doesNotMatch(line, /^### REAL SPEND TOTAL: \$0\.00$/);
});

test('no ambiguous authoritative label when incomplete', () => {
  const line = monthReviewRealSpendTotalLine(100, { incomplete: true });
  assert.doesNotMatch(line, /REAL SPEND TOTAL: \$/);
  assert.match(line, /authoritative_total=UNAVAILABLE/);
});

test('month-review wires formatter and strict incomplete exit', () => {
  assert.match(monthReviewSource, /monthReviewRealSpendTotalLine\(grand, \{ incomplete: incomplete\.length > 0 \}\)/);
  assert.match(monthReviewSource, /DIGEST_STRICT === '1' && incomplete\.length\) process\.exit\(2\)/);
  assert.doesNotMatch(monthReviewSource, /REAL SPEND TOTAL: \$\{money\(grand\)\}/);
});
