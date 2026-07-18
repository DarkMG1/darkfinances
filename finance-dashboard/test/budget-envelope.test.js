'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');

const {
  categoryEnvelopeDebtCents,
  categoryEnvelopeFields,
  categoryReserveCents,
  resolveCategoryEnvelope,
} = require('../lib/domain/budget-envelope');
const { toCents } = require('../lib/domain/money');

test('none mode reserves target minus spent only', () => {
  const envelope = resolveCategoryEnvelope({ target: 200, spent: 50, balance: 250, rolloverMode: 'none' });
  assert.equal(categoryReserveCents(envelope), toCents(150));
});

test('carryover mode reserves positive envelope without adding rollover twice', () => {
  const envelope = resolveCategoryEnvelope({ target: 200, spent: 50, balance: 250, rolloverMode: 'carryover' });
  assert.equal(categoryReserveCents(envelope), toCents(250));
  assert.notEqual(categoryReserveCents(envelope), toCents(150));
  assert.notEqual(categoryReserveCents(envelope), toCents(150) + toCents(250));
});

test('negative envelope reserves zero and surfaces debt', () => {
  const fields = categoryEnvelopeFields({ target: 200, spent: 250, balance: -50, rolloverMode: 'true_expense' });
  assert.equal(fields.reserveCents, 0);
  assert.equal(fields.envelopeDebtCents, toCents(50));
});

test('property: carryover reserve never exceeds positive envelope', () => {
  for (let balance = -500; balance <= 500; balance += 17) {
    for (let target = 0; target <= 400; target += 53) {
      const spent = Math.max(0, target - balance);
      const fields = categoryEnvelopeFields({
        target: target / 100,
        spent: spent / 100,
        balance: balance / 100,
        rolloverMode: 'carryover',
      });
      if (balance > 0) assert.ok(fields.reserveCents <= balance);
    }
  }
});

test('legacy remaining-only categories preserve none-mode reserve', () => {
  const envelope = resolveCategoryEnvelope({ remaining: 75, target: 100, spent: 25, rolloverMode: 'none' });
  assert.equal(categoryReserveCents(envelope), toCents(75));
});

test('categoryEnvelopeDebtCents is zero for positive balances', () => {
  const envelope = resolveCategoryEnvelope({ balance: 12.34, spent: 1, target: 10, rolloverMode: 'true_expense' });
  assert.equal(categoryEnvelopeDebtCents(envelope), 0);
});
