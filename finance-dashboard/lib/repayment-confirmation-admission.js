'use strict';

const { KnownPreApplyError } = require('./errors');
const { toCents } = require('./domain/money');
const { locateExactTransactionId } = require('./repayment-transaction-locator');
const {
  RepaymentAllocationPlanInvalidError,
  validateAllocationPlan,
} = require('./repayment-confirmation-sidecars');
const { ambiguousLegacyLinksOnEndpoint } = require('./reimbursement-allocation');

const ACCOUNT_RANGE_START = '1900-01-01';
const ACCOUNT_RANGE_END = '9999-12-31';

class RepaymentSuggestionInvalidError extends KnownPreApplyError {
  constructor(message = 'suggestion no longer valid (already linked or changed) — refresh and retry') {
    super(message, {
      code: 'REPAYMENT_SUGGESTION_INVALID',
      status: 409,
    });
    this.name = 'RepaymentSuggestionInvalidError';
  }
}

async function resolveRepaymentEndpoints(api, suggestion, payeeNames = {}) {
  const accounts = await api.getAccounts();
  if (!Array.isArray(accounts) || !accounts.length) {
    throw new RepaymentSuggestionInvalidError();
  }

  const inflowId = String(suggestion.inflow.id);
  const expenseIds = suggestion.allocations.map((allocation) => String(allocation.expense.id));
  let accountId = null;
  let inflowTransaction = null;
  const expenseAccounts = {};
  const expenseTransactions = {};

  for (const account of accounts) {
    const txns = await api.getTransactions(account.id, ACCOUNT_RANGE_START, ACCOUNT_RANGE_END);
    if (!inflowTransaction) {
      const located = locateExactTransactionId(txns, inflowId);
      if (located && !located.isLeg) {
        const candidate = located.transaction;
        accountId = String(account.id);
        inflowTransaction = {
          ...candidate,
          payeeName: payeeNames[candidate.payee]
            || candidate.imported_payee
            || suggestion.inflow.payee
            || '',
        };
      }
    }
    for (const allocation of suggestion.allocations) {
      const expenseId = String(allocation.expense.id);
      if (expenseTransactions[expenseId]) continue;
      const located = locateExactTransactionId(txns, expenseId);
      if (located) {
        const expense = located.transaction;
        expenseAccounts[expenseId] = String(account.id);
        expenseTransactions[expenseId] = {
          ...expense,
          payeeName: payeeNames[expense.payee]
            || expense.imported_payee
            || allocation.expense?.payee
            || '',
          parentId: located.isLeg ? String(located.parent.id) : null,
        };
      }
    }
  }

  if (!accountId || !inflowTransaction) {
    throw new RepaymentSuggestionInvalidError();
  }
  for (const expenseId of expenseIds) {
    if (!expenseTransactions[expenseId]) {
      throw new RepaymentSuggestionInvalidError();
    }
  }

  return {
    accountId,
    inflowTransaction,
    expenseAccounts,
    expenseTransactions,
  };
}

function buildAdmissionPayload({
  suggestionId,
  suggestion,
  reimbCategoryId,
  resolved,
  existingLinks,
}) {
  const allocations = suggestion.allocations.map((allocation) => ({
    expenseId: String(allocation.expense.id),
    expenseAccountId: resolved.expenseAccounts[String(allocation.expense.id)],
    parentId: resolved.expenseTransactions[String(allocation.expense.id)]?.parentId ?? null,
    amountCents: Math.abs(toCents(allocation.amount)),
    expensePayeeName: allocation.expense?.payee || '',
  }));

  validateAllocationPlan({
    inflowAmountCents: Math.abs(toCents(suggestion.inflow.amount)),
    allocations: allocations.map((allocation) => ({
      expenseId: allocation.expenseId,
      amountCents: allocation.amountCents,
      expenseSnapshot: {
        amountCents: resolved.expenseTransactions[allocation.expenseId].amount,
      },
    })),
    existingLinks,
    inflowId: suggestion.inflow.id,
  });

  for (const allocation of allocations) {
    const pair = {
      inflowId: String(suggestion.inflow.id),
      expenseId: allocation.expenseId,
    };
    const inflowAmbiguous = ambiguousLegacyLinksOnEndpoint(existingLinks, pair.inflowId, pair);
    const expenseAmbiguous = ambiguousLegacyLinksOnEndpoint(existingLinks, pair.expenseId, pair);
    if (inflowAmbiguous.length > 0 || expenseAmbiguous.length > 0) {
      throw new RepaymentAllocationPlanInvalidError(
        'legacy ambiguous reimbursement links must be resolved before repayment confirmation',
      );
    }
  }

  return {
    accountId: resolved.accountId,
    suggestionId,
    reimbCategoryId,
    person: suggestion.person,
    inflowTransaction: resolved.inflowTransaction,
    expenseTransactions: resolved.expenseTransactions,
    allocations,
    existingLinks,
  };
}

module.exports = {
  ACCOUNT_RANGE_END,
  ACCOUNT_RANGE_START,
  RepaymentAllocationPlanInvalidError,
  RepaymentSuggestionInvalidError,
  buildAdmissionPayload,
  resolveRepaymentEndpoints,
};
