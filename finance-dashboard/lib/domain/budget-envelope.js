'use strict';

const { fromCents, sumCents, toCents } = require('./money');

const ROLLOVER_MODES = Object.freeze(['none', 'carryover', 'true_expense']);

function assertRolloverMode(mode) {
  if (!ROLLOVER_MODES.includes(mode)) {
    throw new Error(`unresolved rollover mode: ${String(mode)}`);
  }
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
  assertRolloverMode(rolloverMode);

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

function categoryEnvelopeCents(envelope) {
  const { balanceCents } = envelope;
  if (!Number.isSafeInteger(balanceCents)) {
    throw new TypeError('balanceCents must be a safe integer');
  }
  return balanceCents;
}

function categoryEnvelopeDebtCents(envelope) {
  const balanceCents = categoryEnvelopeCents(envelope);
  return balanceCents < 0 ? -balanceCents : 0;
}

function categoryReserveCents(envelope) {
  const { rolloverMode } = envelope;
  assertRolloverMode(rolloverMode);
  const balanceCents = categoryEnvelopeCents(envelope);
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

function categoryEnvelopeFields(category) {
  const envelope = resolveCategoryEnvelope(category);
  const envelopeCents = categoryEnvelopeCents(envelope);
  const reserveCents = categoryReserveCents(envelope);
  const envelopeDebtCents = categoryEnvelopeDebtCents(envelope);
  return {
    envelopeCents,
    reserveCents,
    envelopeDebtCents,
    envelope: {
      envelopeCents,
      reserveCents,
      envelopeDebtCents,
      rolloverMode: envelope.rolloverMode,
    },
  };
}

function sumCategoryReserveCents(categories) {
  return sumCents((categories || []).map((category) => {
    if (category.reserveCents != null) return readCents(category.reserveCents, 'reserveCents');
    return categoryReserveCents(resolveCategoryEnvelope(category));
  }));
}

function futureMonthTargetCents(category, { month, financeMonth, trueExpenseCadence = null, annualTarget = null } = {}) {
  const targetCents = category.targetCents != null
    ? readCents(category.targetCents, 'targetCents')
    : (category.target != null ? readCents(category.target, 'target') : 0);
  if (month === financeMonth) {
    if (category.reserveCents != null) return readCents(category.reserveCents, 'reserveCents');
    return categoryReserveCents(resolveCategoryEnvelope(category));
  }
  if (category.rolloverMode === 'true_expense' && annualTarget != null && trueExpenseCadence) {
    const annualCents = readCents(annualTarget, 'annualTarget');
    const cadence = String(trueExpenseCadence).toLowerCase();
    if (cadence === 'monthly') return Math.ceil(annualCents / 12);
    if (cadence === 'quarterly') return Math.ceil(annualCents / 4);
    if (cadence === 'annual') return annualCents;
  }
  return targetCents;
}

module.exports = {
  ROLLOVER_MODES,
  assertRolloverMode,
  resolveCategoryEnvelope,
  categoryEnvelopeCents,
  categoryEnvelopeDebtCents,
  categoryReserveCents,
  categoryEnvelopeFields,
  sumCategoryReserveCents,
  futureMonthTargetCents,
  fromCents,
};
