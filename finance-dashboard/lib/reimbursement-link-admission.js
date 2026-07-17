'use strict';

const { KnownPreApplyError } = require('./errors');
const {
  assertLegacyAmbiguityAdmission,
  endpointAdmissionFingerprint,
  parseRequestedAllocationCents,
  validateLinkCapacity,
} = require('./reimbursement-allocation');
const { locateExactTransactionId } = require('./repayment-transaction-locator');

const ACCOUNT_RANGE_START = '1900-01-01';
const ACCOUNT_RANGE_END = '9999-12-31';

class ReimbursementLinkEndpointInvalidError extends KnownPreApplyError {
  constructor(message = 'reimbursement link endpoint is no longer valid — refresh and retry') {
    super(message, { code: 'REIMBURSEMENT_LINK_ENDPOINT_INVALID', status: 409 });
    this.name = 'ReimbursementLinkEndpointInvalidError';
  }
}

function endpointInvalid(message) {
  throw new ReimbursementLinkEndpointInvalidError(message);
}

function enrichLocated(located, payeeNames = {}, hint = {}) {
  const transaction = located.transaction;
  const payeeName = payeeNames[transaction.payee]
    || transaction.imported_payee
    || hint.payee
    || '';
  return {
    id: String(transaction.id),
    date: transaction.date || hint.date || null,
    amountCents: transaction.amount,
    accountId: located.accountId || hint.accountId || null,
    accountName: transaction.account || hint.account || hint.accountName || '',
    payee: payeeName,
    imported: Boolean(transaction.imported ?? hint.imported),
    category: transaction.category ?? hint.category ?? null,
    parentId: located.isLeg ? String(located.parent.id) : (hint.parentId ?? null),
    isLeg: located.isLeg,
  };
}

async function locateEndpoint(api, id, payeeNames, hint) {
  const accounts = await api.getAccounts();
  if (!Array.isArray(accounts) || !accounts.length) endpointInvalid();
  for (const account of accounts) {
    const txns = await api.getTransactions(account.id, ACCOUNT_RANGE_START, ACCOUNT_RANGE_END);
    const located = locateExactTransactionId(txns, id);
    if (located) {
      return enrichLocated({ ...located, accountId: String(account.id) }, payeeNames, hint);
    }
  }
  endpointInvalid();
}

async function locateTransactionLive(api, id, hint = {}, payeeNames = {}) {
  const accounts = await api.getAccounts();
  if (!Array.isArray(accounts) || !accounts.length) return null;
  for (const account of accounts) {
    const txns = await api.getTransactions(account.id, ACCOUNT_RANGE_START, ACCOUNT_RANGE_END);
    const located = locateExactTransactionId(txns, id);
    if (located) {
      return enrichLocated({ ...located, accountId: String(account.id) }, payeeNames, hint);
    }
  }
  return null;
}

async function resolveManualLinkEndpoints(api, { inflow, expense, payeeNames = {} }) {
  const inflowId = String(inflow.id);
  const expenseId = String(expense.id);
  if (inflowId === expenseId) endpointInvalid('cannot link a transaction to itself');

  const inflowLive = await locateEndpoint(api, inflowId, payeeNames, inflow);
  const expenseLive = await locateEndpoint(api, expenseId, payeeNames, expense);

  if (!(inflowLive.amountCents > 0)) endpointInvalid('inflow must be a positive transaction');
  if (!(expenseLive.amountCents < 0)) endpointInvalid('expense must be a negative transaction');

  return { inflowLive, expenseLive };
}

function assertReimbursementEligible({ expenseLive, reimbCategoryId }) {
  if (!reimbCategoryId) endpointInvalid('reimbursement category is unavailable');
  if (String(expenseLive.category) !== String(reimbCategoryId)) {
    endpointInvalid('expense must be categorized as Reimbursement');
  }
}

function assertLiveEndpointsMatchPrepared(preparedInflow, preparedExpense, liveInflow, liveExpense) {
  if (endpointAdmissionFingerprint(preparedInflow) !== endpointAdmissionFingerprint(liveInflow)
    || endpointAdmissionFingerprint(preparedExpense) !== endpointAdmissionFingerprint(liveExpense)) {
    endpointInvalid('reimbursement link endpoints changed during mutation — refresh and retry');
  }
}

function buildManualLinkAdmission({
  request,
  resolved,
  existingLinks,
  reimbCategoryId,
}) {
  assertReimbursementEligible({ expenseLive: resolved.expenseLive, reimbCategoryId });
  const allocationCents = parseRequestedAllocationCents(request);
  const existing = (existingLinks || []).find(
    (link) => String(link?.inflow?.id) === String(resolved.inflowLive.id)
      && String(link?.expense?.id) === String(resolved.expenseLive.id),
  );
  const existingClassified = existing ? require('./reimbursement-allocation').classifyStoredLink(existing) : null;
  const allowSamePairResolution = Boolean(existingClassified?.ambiguous);
  assertLegacyAmbiguityAdmission({
    links: existingLinks,
    inflowId: resolved.inflowLive.id,
    expenseId: resolved.expenseLive.id,
    existingLink: existing,
    allowSamePairResolution,
  });
  const capacity = validateLinkCapacity({
    allocationCents,
    inflowAmountCents: resolved.inflowLive.amountCents,
    expenseAmountCents: resolved.expenseLive.amountCents,
    existingLinks,
    inflowId: resolved.inflowLive.id,
    expenseId: resolved.expenseLive.id,
  });
  return {
    inflowLive: resolved.inflowLive,
    expenseLive: resolved.expenseLive,
    allocationCents: capacity.allocationCents,
    person: request.person || null,
    expectedVersion: request.expectedVersion ?? null,
    existingLink: existing || null,
    capacity,
    allowSamePairResolution,
  };
}

async function admitManualLink(api, request, { existingLinks, reimbCategoryId, payeeNames = {} }) {
  const resolved = await resolveManualLinkEndpoints(api, {
    inflow: request.inflow,
    expense: request.expense,
    payeeNames,
  });
  return buildManualLinkAdmission({
    request,
    resolved,
    existingLinks,
    reimbCategoryId,
  });
}

async function revalidateLinkApply(api, saga, { existingLinks, reimbCategoryId, payeeNames = {} }) {
  const inflowLive = await locateEndpoint(api, saga.inflowId, payeeNames, saga.inflowLive);
  const expenseLive = await locateEndpoint(api, saga.expenseId, payeeNames, saga.expenseLive);
  assertReimbursementEligible({ expenseLive, reimbCategoryId });
  assertLiveEndpointsMatchPrepared(saga.inflowLive, saga.expenseLive, inflowLive, expenseLive);

  const existing = (existingLinks || []).find(
    (link) => String(link?.inflow?.id) === String(inflowLive.id)
      && String(link?.expense?.id) === String(expenseLive.id),
  );
  assertLegacyAmbiguityAdmission({
    links: existingLinks,
    inflowId: inflowLive.id,
    expenseId: expenseLive.id,
    existingLink: existing,
    allowSamePairResolution: saga.allowSamePairResolution === true,
  });
  const capacity = validateLinkCapacity({
    allocationCents: saga.allocationCents,
    inflowAmountCents: inflowLive.amountCents,
    expenseAmountCents: expenseLive.amountCents,
    existingLinks,
    inflowId: inflowLive.id,
    expenseId: expenseLive.id,
  });
  return {
    inflowLive,
    expenseLive,
    allocationCents: capacity.allocationCents,
    person: saga.person,
    expectedVersion: saga.expectedVersion ?? null,
    existingLink: existing || null,
    capacity,
  };
}

async function revalidateUnlinkApply(api, saga, { existingLinks, payeeNames = {} }) {
  await locateEndpoint(api, saga.inflowId, payeeNames, {});
  await locateEndpoint(api, saga.expenseId, payeeNames, {});
  const existing = (existingLinks || []).find(
    (link) => String(link?.inflow?.id) === String(saga.inflowId)
      && String(link?.expense?.id) === String(saga.expenseId),
  );
  if (!existing) return null;
  assertLegacyAmbiguityAdmission({
    links: existingLinks,
    inflowId: saga.inflowId,
    expenseId: saga.expenseId,
    existingLink: existing,
    allowSamePairResolution: true,
  });
  return existing;
}

function buildCapacityAdmission({
  inflowAmountCents,
  expenseAmountCents,
  allocationCents,
  existingLinks,
  inflowId,
  expenseId,
}) {
  return validateLinkCapacity({
    allocationCents,
    inflowAmountCents,
    expenseAmountCents,
    existingLinks,
    inflowId,
    expenseId,
  });
}

module.exports = {
  ACCOUNT_RANGE_END,
  ACCOUNT_RANGE_START,
  ReimbursementLinkEndpointInvalidError,
  admitManualLink,
  buildCapacityAdmission,
  buildManualLinkAdmission,
  locateTransactionLive,
  revalidateLinkApply,
  revalidateUnlinkApply,
  resolveManualLinkEndpoints,
};
