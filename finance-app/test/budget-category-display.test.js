'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const path = require('path');
const {
  categoryReserveDisplay,
  categoryEnvelopeDebtDisplay,
} = require('../src/lib/budget-category-display.js');

const budgetsSource = fs.readFileSync(
  path.join(__dirname, '../src/app/budgets.tsx'),
  'utf8',
);

test('unresolved or null reserve renders unavailable, not remaining fallback', () => {
  assert.deepEqual(categoryReserveDisplay({ resolved: false, reserve: null }), { kind: 'unavailable' });
  assert.deepEqual(categoryReserveDisplay({ resolved: true, reserve: null }), { kind: 'unavailable' });
  assert.deepEqual(categoryReserveDisplay({ resolved: false, reserve: 40 }), { kind: 'unavailable' });
});

test('resolved reserve exposes exact dollar amount including zero', () => {
  assert.deepEqual(categoryReserveDisplay({ resolved: true, reserve: 125.5 }), { kind: 'amount', dollars: 125.5 });
  assert.deepEqual(categoryReserveDisplay({ resolved: true, reserve: 0 }), { kind: 'amount', dollars: 0 });
});

test('envelope debt renders only for positive amounts; null and zero show nothing', () => {
  assert.deepEqual(categoryEnvelopeDebtDisplay(null), { show: false, dollars: null });
  assert.deepEqual(categoryEnvelopeDebtDisplay(0), { show: false, dollars: null });
  assert.deepEqual(categoryEnvelopeDebtDisplay(-3), { show: false, dollars: null });
  assert.deepEqual(categoryEnvelopeDebtDisplay(12.34), { show: true, dollars: 12.34 });
});

test('budgets screen sources reserve display helper and avoids remaining fabrication', () => {
  assert.match(budgetsSource, /categoryReserveDisplay/);
  assert.match(budgetsSource, /categoryEnvelopeDebtDisplay/);
  assert.match(budgetsSource, /reserve unavailable/);
  assert.match(budgetsSource, /Rollover policy unresolved/);
  assert.doesNotMatch(budgetsSource, /c\.reserve \?\? c\.remaining/);
  assert.doesNotMatch(budgetsSource, /c\.envelopeDebt > 0/);
});
