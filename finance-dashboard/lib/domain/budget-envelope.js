'use strict';

const { fromCents, toCents } = require('./money');

const ROLLOVER_MODES = Object.freeze(['none', 'carryover', 'true_expense']);

function isRolloverTreatmentResolved(rolloverMode, rolloverConfigured) {
  return rolloverConfigured === true && ROLLOVER_MODES.includes(rolloverMode || 'none');
}

function readCents(value, field) {
  if (value == null) return null;
  if (typeof value !== 'number' || !Number.isFinite(value)) {
    throw new TypeError(`${field} must be a finite dollar amount or safe integer cents`);
  }
  if (String(field).endsWith('Cents') && Number.isSafeInteger(value)) return value;
  return toCents(value);
}

function resolveCategoryEnvelope(category = {}) {
  const rolloverMode = category.rolloverMode || 'none';
  const spentCents = category.spentCents != null
    ? readCents(category.spentCents, 'spentCents')
    : (category.spent != null ? readCents(Math.max(0, category.spent), 'spent') : 0);
  const targetCents = category.targetCents != null
    ? readCents(category.targetCents, 'targetCents')
    : (category.target != null ? readCents(category.target, 'target') : 0);

  if (category.balanceCents != null || category.balance != null) {
    const balanceCents = category.balanceCents != null
      ? readCents(category.balanceCents, 'balanceCents')
      : readCents(category.balance, 'balance');
    return { balanceCents, spentCents, targetCents, rolloverMode };
  }

  if (category.remainingCents != null || category.remaining != null) {
    const remainingCents = category.remainingCents != null
      ? readCents(category.remainingCents, 'remainingCents')
      : readCents(category.remaining, 'remaining');
    return {
      balanceCents: remainingCents,
      spentCents,
      targetCents: targetCents > 0 ? targetCents : spentCents + remainingCents,
      rolloverMode: 'none',
    };
  }

  return {
    balanceCents: Math.max(0, targetCents - spentCents),
    spentCents,
    targetCents,
    rolloverMode,
  };
}

function categoryEnvelopeDebtCents(envelope) {
  const balanceCents = envelope.balanceCents;
  if (!Number.isSafeInteger(balanceCents)) {
    throw new TypeError('balanceCents must be a safe integer');
  }
  return balanceCents < 0 ? -balanceCents : 0;
}

function categoryReserveCents(envelope) {
  const { rolloverMode } = envelope;
  const balanceCents = envelope.balanceCents;
  const spentCents = envelope.spentCents ?? 0;
  const targetCents = envelope.targetCents ?? 0;

  switch (rolloverMode) {
    case 'none':
      return Math.max(0, targetCents - spentCents);
    case 'carryover':
    case 'true_expense':
      return balanceCents > 0 ? balanceCents : 0;
    default:
      throw new Error(`unresolved rollover mode: ${rolloverMode}`);
  }
}

function categoryEnvelopeFields(category = {}) {
  const rolloverConfigured = category.rolloverConfigured === true;
  const rolloverMode = category.rolloverMode || 'none';
  const resolved = isRolloverTreatmentResolved(rolloverMode, rolloverConfigured);

  if (!resolved) {
    return {
      resolved: false,
      rolloverConfigured,
      rolloverMode,
      envelopeCents: null,
      reserveCents: null,
      envelopeDebtCents: null,
    };
  }

  const envelope = resolveCategoryEnvelope(category);
  const envelopeCents = envelope.balanceCents;
  const reserveCents = categoryReserveCents(envelope);
  const envelopeDebtCents = categoryEnvelopeDebtCents(envelope);
  return {
    resolved: true,
    rolloverConfigured,
    rolloverMode: envelope.rolloverMode,
    envelopeCents,
    reserveCents,
    envelopeDebtCents,
  };
}

function categoryReserveCentsFromCategory(category = {}) {
  if (category.resolved === false || category.reserveCents === null) return null;
  if (Number.isSafeInteger(category.reserveCents)) return category.reserveCents;
  if (category.rolloverMode == null && category.rolloverConfigured !== true && category.remaining != null) {
    return Math.max(0, toCents(Math.max(0, Number(category.remaining))));
  }
  const fields = categoryEnvelopeFields(category);
  return fields.resolved ? fields.reserveCents : null;
}

module.exports = {
  ROLLOVER_MODES,
  isRolloverTreatmentResolved,
  resolveCategoryEnvelope,
  categoryEnvelopeDebtCents,
  categoryReserveCents,
  categoryEnvelopeFields,
  categoryReserveCentsFromCategory,
  fromCents,
};
