'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');

const {
  ROLLOVER_MODES,
  categoryEnvelopeFields,
  categoryReserveCents,
  categoryReserveCentsFromCategory,
  isRolloverTreatmentResolved,
  resolveCategoryEnvelope,
} = require('../lib/domain/budget-envelope');
const { toCents } = require('../lib/domain/money');

test('none mode reserves target minus spent when explicitly configured', () => {
  const fields = categoryEnvelopeFields({
    target: 200,
    spent: 50,
    balance: 250,
    rolloverMode: 'none',
    rolloverConfigured: true,
  });
  assert.equal(fields.resolved, true);
  assert.equal(fields.reserveCents, toCents(150));
});

test('carryover mode reserves positive envelope without adding rollover twice', () => {
  const fields = categoryEnvelopeFields({
    target: 200,
    spent: 50,
    balance: 250,
    rolloverMode: 'carryover',
    rolloverConfigured: true,
  });
  assert.equal(fields.reserveCents, toCents(250));
  assert.notEqual(fields.reserveCents, toCents(150));
});

test('unresolved rollover returns null authoritative reserve', () => {
  const fields = categoryEnvelopeFields({
    target: 200,
    spent: 50,
    balance: 250,
    rolloverMode: 'carryover',
    rolloverConfigured: false,
  });
  assert.equal(fields.resolved, false);
  assert.equal(fields.rolloverConfigured, false);
  assert.equal(fields.reserveCents, null);
  assert.equal(fields.envelopeCents, null);
  assert.equal(categoryReserveCentsFromCategory(fields), null);
});

test('negative envelope reserves zero and surfaces debt when resolved', () => {
  const fields = categoryEnvelopeFields({
    target: 200,
    spent: 250,
    balance: -50,
    rolloverMode: 'true_expense',
    rolloverConfigured: true,
  });
  assert.equal(fields.reserveCents, 0);
  assert.equal(fields.envelopeDebtCents, toCents(50));
});

test('mode change from none to carryover switches reserve basis', () => {
  const none = categoryEnvelopeFields({
    target: 200,
    spent: 50,
    balance: 250,
    rolloverMode: 'none',
    rolloverConfigured: true,
  });
  const carry = categoryEnvelopeFields({
    target: 200,
    spent: 50,
    balance: 250,
    rolloverMode: 'carryover',
    rolloverConfigured: true,
  });
  assert.ok(carry.reserveCents > none.reserveCents);
});

test('property: resolved carryover reserve never exceeds positive envelope', () => {
  for (let balance = -500; balance <= 500; balance += 17) {
    for (let target = 0; target <= 400; target += 53) {
      const spent = Math.max(0, target - balance);
      const fields = categoryEnvelopeFields({
        target: target / 100,
        spent: spent / 100,
        balance: balance / 100,
        rolloverMode: 'carryover',
        rolloverConfigured: true,
      });
      if (fields.envelopeCents != null && fields.envelopeCents > 0) {
        assert.ok(fields.reserveCents <= fields.envelopeCents);
      }
    }
  }
});

test('legacy remaining-only categories preserve none-mode reserve when configured', () => {
  const envelope = resolveCategoryEnvelope({ remaining: 75, target: 100, spent: 25, rolloverMode: 'none' });
  assert.equal(categoryReserveCents(envelope), toCents(75));
});

test('isRolloverTreatmentResolved accepts all canonical modes', () => {
  for (const mode of ROLLOVER_MODES) {
    assert.equal(isRolloverTreatmentResolved(mode, true), true);
  }
  assert.equal(isRolloverTreatmentResolved('carryover', false), false);
});
