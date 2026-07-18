'use strict';

const { sumCents } = require('./money');

function absCents(value) {
  return Math.abs(Number(value) || 0);
}

function observedDateOnly(observedAt) {
  if (!observedAt) return null;
  const parsed = new Date(observedAt);
  if (Number.isNaN(parsed.getTime())) return null;
  return parsed.toISOString().slice(0, 10);
}

function computeAdjustedObligation({
  coverageKind,
  obligationCents,
  currentBalanceCents,
  postedPaymentCents = 0,
}) {
  if (coverageKind === 'current_balance') {
    return absCents(currentBalanceCents);
  }
  if (coverageKind === 'statement') {
    return Math.max(0, sumCents([obligationCents, -postedPaymentCents]));
  }
  return obligationCents;
}

function computePartition({
  adjustedObligationCents,
  billCents = 0,
  futureTransferCents = 0,
}) {
  const bill = absCents(billCents);
  const future = absCents(futureTransferCents);
  const obligation = absCents(adjustedObligationCents);
  const futureComponent = Math.min(future, obligation);
  const billRemainderComponent = Math.min(
    Math.max(bill - futureComponent, 0),
    obligation - futureComponent,
  );
  const residualComponent = Math.max(obligation - futureComponent - billRemainderComponent, 0);
  const total = sumCents([futureComponent, billRemainderComponent, residualComponent]);
  return {
    futureComponentCents: futureComponent,
    billRemainderComponentCents: billRemainderComponent,
    residualComponentCents: residualComponent,
    totalReservedCents: total,
  };
}

function validateCycleEvidence({
  adjustedObligationCents,
  billCents,
  futureTransferCents,
  billDueDate,
  liabilityDueDate,
  futureTransferDates = [],
  duplicateTransferLinks = false,
  duplicateBillLinks = false,
}) {
  const issues = [];
  const obligation = absCents(adjustedObligationCents);
  const bill = absCents(billCents);
  const future = absCents(futureTransferCents);

  if (duplicateTransferLinks || duplicateBillLinks) issues.push('duplicate_link');
  if (billDueDate && liabilityDueDate && billDueDate !== liabilityDueDate) issues.push('due_date_mismatch');
  if (bill > obligation) issues.push('bill_exceeds_obligation');
  if (future > obligation) issues.push('future_transfer_exceeds_obligation');
  for (const date of futureTransferDates) {
    if (liabilityDueDate && date > liabilityDueDate) issues.push('future_transfer_after_due');
  }

  const partition = computePartition({ adjustedObligationCents: obligation, billCents: bill, futureTransferCents: future });
  if (obligation > 0 && partition.totalReservedCents !== obligation) issues.push('partition_sum_mismatch');
  if (obligation > 0 && partition.totalReservedCents === 0) issues.push('unpaid_zero_reserve');

  return { ok: issues.length === 0, issues, partition };
}

function verifyCyclePartitionInvariants(cycles = []) {
  const issues = [];
  for (const cycle of cycles) {
    if (!cycle.quarantined && cycle.adjustedObligationCents > 0) {
      const reserved = sumCents([
        cycle.reserved?.futureComponentCents || 0,
        cycle.reserved?.billRemainderComponentCents || 0,
        cycle.reserved?.residualComponentCents || 0,
      ]);
      if (reserved !== cycle.adjustedObligationCents) {
        issues.push(`cycle ${cycle.cycleKey} reserved ${reserved} != obligation ${cycle.adjustedObligationCents}`);
      }
      if (reserved === 0) issues.push(`cycle ${cycle.cycleKey} unpaid with zero reserve`);
    }
  }
  return { ok: issues.length === 0, issues };
}

module.exports = {
  absCents,
  computeAdjustedObligation,
  computePartition,
  observedDateOnly,
  validateCycleEvidence,
  verifyCyclePartitionInvariants,
};
