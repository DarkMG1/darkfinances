'use strict';

const SAFE_TO_SPEND_INPUTS = Symbol('safe-to-spend-inputs');

const SAFE_TO_SPEND_REASON = Object.freeze({
  transferIdentityUnresolved: 'transfer_identity_unresolved',
  accountRolesUnassigned: 'account_roles_unassigned',
  operatingCashAccountMissing: 'operating_cash_account_missing',
  budgetDataUnavailable: 'budget_data_unavailable',
  creditCardCoverageUnknown: 'credit_card_coverage_unknown',
  budgetTargetsMissing: 'budget_targets_missing',
  budgetTargetCoveragePartial: 'budget_target_coverage_partial',
  targetlessCategorySpending: 'targetless_category_spending',
  billRecurrenceUnresolved: 'bill_recurrence_unresolved',
  nonBillRecurrenceUnresolved: 'non_bill_recurrence_unresolved',
  goalCommitmentUnknown: 'goal_commitment_unknown',
  rolloverTreatmentUnknown: 'rollover_treatment_unknown',
});

const SAFE_TO_SPEND_REASON_ORDER = Object.freeze([
  SAFE_TO_SPEND_REASON.transferIdentityUnresolved,
  SAFE_TO_SPEND_REASON.accountRolesUnassigned,
  SAFE_TO_SPEND_REASON.operatingCashAccountMissing,
  SAFE_TO_SPEND_REASON.budgetDataUnavailable,
  SAFE_TO_SPEND_REASON.creditCardCoverageUnknown,
  SAFE_TO_SPEND_REASON.budgetTargetsMissing,
  SAFE_TO_SPEND_REASON.budgetTargetCoveragePartial,
  SAFE_TO_SPEND_REASON.targetlessCategorySpending,
  SAFE_TO_SPEND_REASON.billRecurrenceUnresolved,
  SAFE_TO_SPEND_REASON.nonBillRecurrenceUnresolved,
  SAFE_TO_SPEND_REASON.goalCommitmentUnknown,
  SAFE_TO_SPEND_REASON.rolloverTreatmentUnknown,
]);

function safeToSpendIncompleteReasons({
  accounts = [],
  visibleAccounts = accounts.filter((account) => !account.hidden),
  operatingAccounts = [],
  budgets = {},
  recurring = {},
  goals = [],
  spendingCompleteness = null,
} = {}) {
  const found = new Set();
  const add = (reason, condition) => {
    if (condition) found.add(reason);
  };

  add(
    SAFE_TO_SPEND_REASON.transferIdentityUnresolved,
    spendingCompleteness != null && spendingCompleteness.complete === false,
  );
  add(
    SAFE_TO_SPEND_REASON.accountRolesUnassigned,
    visibleAccounts.some((account) => account.roleSource !== 'explicit' || account.role === 'unknown'),
  );
  add(SAFE_TO_SPEND_REASON.operatingCashAccountMissing, operatingAccounts.length === 0);
  add(
    SAFE_TO_SPEND_REASON.creditCardCoverageUnknown,
    accounts.some((account) => account.role === 'credit_card' && Number(account.balance) < 0),
  );

  if (budgets.supported === false || !budgets[SAFE_TO_SPEND_INPUTS]) {
    found.add(SAFE_TO_SPEND_REASON.budgetDataUnavailable);
  } else {
    const inputs = budgets[SAFE_TO_SPEND_INPUTS];
    add(SAFE_TO_SPEND_REASON.budgetTargetsMissing, inputs.targetedCategoryCount === 0);
    add(
      SAFE_TO_SPEND_REASON.budgetTargetCoveragePartial,
      inputs.targetedCategoryCount > 0 && inputs.targetedCategoryCount < inputs.eligibleCategoryCount,
    );
    add(SAFE_TO_SPEND_REASON.targetlessCategorySpending, inputs.targetlessSpentCategoryCount > 0);
    add(SAFE_TO_SPEND_REASON.rolloverTreatmentUnknown, inputs.unresolvedRolloverCategoryCount > 0);
  }

  const recurrenceItems = [...(recurring.items || []), ...(recurring.hiddenItems || [])];
  add(
    SAFE_TO_SPEND_REASON.billRecurrenceUnresolved,
    recurrenceItems.some((item) => item.status === 'active' && item.isBill === true && item.projectionUncertain === true),
  );
  add(
    SAFE_TO_SPEND_REASON.nonBillRecurrenceUnresolved,
    recurrenceItems.some((item) => item.status === 'active' && item.isBill !== true),
  );
  add(
    SAFE_TO_SPEND_REASON.goalCommitmentUnknown,
    goals.some((goal) => Number(goal.target) > 0),
  );

  return SAFE_TO_SPEND_REASON_ORDER.filter((reason) => found.has(reason));
}

module.exports = {
  SAFE_TO_SPEND_INPUTS,
  SAFE_TO_SPEND_REASON,
  SAFE_TO_SPEND_REASON_ORDER,
  safeToSpendIncompleteReasons,
};
