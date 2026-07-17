'use strict';

const { KnownPreApplyError } = require('./errors');
const { fromCents, sumCents, toCents } = require('./domain/money');

class RepaymentAllocationPlanInvalidError extends KnownPreApplyError {
  constructor(message = 'repayment allocation plan is invalid') {
    super(message, {
      code: 'REPAYMENT_ALLOCATION_PLAN_INVALID',
      status: 409,
    });
    this.name = 'RepaymentAllocationPlanInvalidError';
  }
}

function planInvalid(message) {
  throw new RepaymentAllocationPlanInvalidError(message);
}

function isObject(value) {
  return Boolean(value) && typeof value === 'object' && !Array.isArray(value);
}

function assertLinksStore(store) {
  if (!isObject(store) || !Array.isArray(store.links)) {
    throw new Error('invalid reimbursement links reference store');
  }
}

function assertSuggestStore(store) {
  if (!isObject(store)
    || !isObject(store.confirmed)
    || !Array.isArray(store.dismissed)) {
    throw new Error('invalid reimbursement suggestions reference store');
  }
}

function requireSafeCents(value, label) {
  if (!Number.isSafeInteger(value)) {
    planInvalid(`${label} must be a safe integer cent amount`);
  }
  return value;
}

function allocationAmountCents(allocation) {
  return requireSafeCents(allocation.amountCents, 'allocation amount');
}

function expenseAbsCents(expenseSnapshot) {
  const cents = requireSafeCents(expenseSnapshot.amountCents, 'expense amount');
  if (cents >= 0) planInvalid('expense amount must be negative cents');
  return Math.abs(cents);
}

function sameTransactionId(left, right) {
  return String(left) === String(right);
}

function linkedAmountCents(link, expenseId) {
  if (!sameTransactionId(link?.expense?.id, expenseId)) return 0;
  if (link.amount != null) return Math.abs(toCents(link.amount));
  if (link.expense?.amount != null) return Math.abs(toCents(Math.abs(link.expense.amount)));
  return 0;
}

function validateAllocationPlan({
  inflowAmountCents,
  allocations,
  existingLinks = [],
  inflowId,
}) {
  requireSafeCents(inflowAmountCents, 'inflow amount');
  if (inflowAmountCents <= 0) planInvalid('inflow amount must be positive cents');
  if (!Array.isArray(allocations)) planInvalid('allocation plan required');

  const expenseIds = new Set();
  let total = 0;
  for (const allocation of allocations) {
    const expenseId = allocation?.expenseId;
    if (!expenseId) planInvalid('allocation expense id required');
    const id = String(expenseId);
    if (expenseIds.has(id)) planInvalid('duplicate allocation expense id');
    expenseIds.add(id);
    if (id === String(inflowId)) planInvalid('cannot allocate inflow to itself');

    const amountCents = allocationAmountCents(allocation);
    if (amountCents <= 0) planInvalid('allocation amount must be positive cents');
    const expenseCap = expenseAbsCents(allocation.expenseSnapshot);
    const priorLinked = existingLinks
      .filter((link) => sameTransactionId(link?.expense?.id, id)
        && !sameTransactionId(link?.inflow?.id, inflowId))
      .reduce((sum, link) => sum + linkedAmountCents(link, id), 0);
    const remaining = expenseCap - priorLinked;
    if (amountCents > remaining) {
      planInvalid(`allocation exceeds remaining expense capacity for ${id}`);
    }
    total = sumCents([total, amountCents]);
  }

  if (total > inflowAmountCents) {
    planInvalid('allocation plan exceeds inflow amount');
  }
  return { totalAllocatedCents: total, allocationCount: allocations.length };
}

function txnRefFromSnapshot(snapshot, payeeName = '') {
  return {
    id: String(snapshot.id),
    date: snapshot.date || null,
    payee: payeeName || snapshot.payeeName || '',
    amount: fromCents(snapshot.amountCents),
    accountId: snapshot.accountId || null,
    account: snapshot.accountName || '',
    imported: Boolean(snapshot.imported),
  };
}

function applyAllocationLink(store, {
  inflowSnapshot,
  expenseSnapshot,
  amountCents,
  person,
  inflowPayeeName,
  expensePayeeName,
}) {
  assertLinksStore(store);
  const inf = txnRefFromSnapshot(inflowSnapshot, inflowPayeeName);
  const exp = txnRefFromSnapshot(expenseSnapshot, expensePayeeName);
  const allocCents = requireSafeCents(amountCents, 'allocation amount');
  const alloc = fromCents(allocCents);

  const existing = store.links.find(
    (link) => sameTransactionId(link?.inflow?.id, inf.id) && sameTransactionId(link?.expense?.id, exp.id),
  );
  if (existing) {
    const existingCents = existing.amount != null
      ? Math.abs(toCents(existing.amount))
      : Math.abs(toCents(Math.abs(exp.amount)));
    if (existingCents !== allocCents) {
      throw new Error(`conflicting reimbursement link amount for ${inf.id}->${exp.id}`);
    }
    if (person && existing.person !== person) existing.person = person;
    return false;
  }

  store.links.push({
    inflow: inf,
    expense: exp,
    amount: alloc,
    person: person || null,
    createdAt: new Date().toISOString(),
  });
  return true;
}

function linksConverged(plan, store, {
  inflowSnapshot,
  person,
  inflowPayeeName,
  expensePayeeNames = {},
}) {
  assertLinksStore(store);
  for (const allocation of plan.allocations || []) {
    const expenseId = String(allocation.expenseId);
    const link = store.links.find(
      (entry) => sameTransactionId(entry?.inflow?.id, inflowSnapshot.id)
        && sameTransactionId(entry?.expense?.id, expenseId),
    );
    if (!link) return false;
    const expected = allocationAmountCents(allocation);
    const actual = link.amount != null
      ? Math.abs(toCents(link.amount))
      : Math.abs(toCents(Math.abs(link.expense?.amount || 0)));
    if (actual !== expected) return false;
    if (person && link.person && link.person !== person) return false;
  }
  for (const allocation of plan.allocations || []) {
    const expenseId = String(allocation.expenseId);
    const duplicates = store.links.filter(
      (entry) => sameTransactionId(entry?.inflow?.id, inflowSnapshot.id)
        && sameTransactionId(entry?.expense?.id, expenseId),
    );
    if (duplicates.length !== 1) return false;
  }
  return true;
}

function applyConfirmationRecord(store, {
  suggestionId,
  inflowId,
  allocationCount,
  confirmedAt,
}) {
  assertSuggestStore(store);
  const existing = store.confirmed[suggestionId];
  const next = {
    at: confirmedAt,
    inflowId: String(inflowId),
    allocations: allocationCount,
  };
  if (existing) {
    if (String(existing.inflowId) !== String(inflowId)) {
      throw new Error('conflicting reimbursement confirmation inflow id');
    }
    if (existing.allocations != null && existing.allocations !== allocationCount) {
      throw new Error('conflicting reimbursement confirmation allocation count');
    }
    store.confirmed[suggestionId] = {
      ...existing,
      ...next,
      allocations: existing.allocations == null ? allocationCount : existing.allocations,
    };
    return false;
  }
  store.confirmed[suggestionId] = next;
  return true;
}

function confirmationConverged({
  suggestionId,
  inflowId,
  allocationCount,
  store,
}) {
  assertSuggestStore(store);
  const existing = store.confirmed[suggestionId];
  if (!existing) return false;
  if (String(existing.inflowId) !== String(inflowId)) return false;
  if (existing.allocations != null && existing.allocations !== allocationCount) return false;
  return true;
}

module.exports = {
  RepaymentAllocationPlanInvalidError,
  applyAllocationLink,
  applyConfirmationRecord,
  confirmationConverged,
  linksConverged,
  sameTransactionId,
  validateAllocationPlan,
};
