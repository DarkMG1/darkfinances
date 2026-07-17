'use strict';

const { KnownPreApplyError } = require('./errors');
const { toCents } = require('./domain/money');
const { locateExactTransactionId } = require('./repayment-transaction-locator');
const {
  parseRequestedAllocationCents,
  validateLinkCapacity,
} = require('./reimbursement-allocation');

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
    accountId: located.accountId,
    accountName: transaction.account || hint.account || '',
    payee: payeeName,
    imported: Boolean(transaction.imported),
    category: transaction.category ?? null,
    parentId: located.isLeg ? String(located.parent.id) : null,
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
  };
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
  buildCapacityAdmission,
  buildManualLinkAdmission,
  locateTransactionLive,
  resolveManualLinkEndpoints,
};
