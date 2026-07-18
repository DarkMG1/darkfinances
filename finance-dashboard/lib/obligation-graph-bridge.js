'use strict';

const { toCents } = require('./domain/money');
const {
  buildTransferIndex,
  classifyTransactionLeaves,
  leafCountsAsRealSpend,
  PROVENANCE,
} = require('./domain/classification');
const {
  COVERAGE_MODE,
  liabilityCycleKey,
  resolveAccountCreditPolicy,
  resolvePaymentLink,
} = require('./domain/credit-liability-policy');
const {
  billDurableIdentity,
  buildBillCategoryIndex,
  isBillBackedCategory,
  recurringDurableIdentity,
} = require('./domain/obligation-identities');
const {
  inferRecurrenceSchedule,
  projectOccurrences,
} = require('./recurrence');
const { OBLIGATION_REASON } = require('./domain/obligation-graph');

function buildRecurringProjections(item, { windowStart, windowEnd, today }) {
  if (item.status !== 'active') return { projectedOccurrences: [], scheduleUncertain: false };
  const hist = item.history || [];
  const schedule = inferRecurrenceSchedule({
    dates: hist.map((h) => h.date),
    cadence: item.cadence,
    forced: !!item.forced,
  });
  if (schedule.uncertain || item.projectionUncertain) {
    return { projectedOccurrences: [], scheduleUncertain: true };
  }
  const dates = projectOccurrences({ schedule, windowStart: today, windowEnd });
  const amountCents = toCents(Math.abs(Number(item.amount) || 0));
  return {
    scheduleUncertain: false,
    projectedOccurrences: dates
      .filter((date) => date >= windowStart && date <= windowEnd)
      .map((date) => ({
        date,
        amountCents,
        provenance: item.forced ? 'manual' : 'inferred',
        paid: false,
      })),
  };
}

function buildIncomeProjections(stream, { windowStart, windowEnd, today }) {
  if (!stream.active) return { projectedOccurrences: [], scheduleUncertain: false };
  const schedule = inferRecurrenceSchedule({
    dates: [...new Set([...(stream.history || []).map((h) => h.date), stream.lastPaid].filter(Boolean))].sort(),
    cadence: stream.cadence,
  });
  if (schedule.uncertain) return { projectedOccurrences: [], scheduleUncertain: true };
  const dates = projectOccurrences({ schedule, windowStart: today, windowEnd });
  const amountCents = toCents(Math.abs(Number(stream.amount) || 0));
  return {
    scheduleUncertain: false,
    projectedOccurrences: dates
      .filter((date) => date >= windowStart && date <= windowEnd)
      .map((date) => ({ date, amountCents, provenance: 'inferred' })),
  };
}

function buildBudgetReservations({ budgets, billCategoryIds = new Set() }) {
  const reservations = [];
  const incompleteReasons = [];
  if (budgets?.supported === false) {
    incompleteReasons.push('budget_data_unavailable');
    return { reservations, incompleteReasons };
  }
  for (const group of budgets?.groups || []) {
    for (const category of group.categories || []) {
      if (billCategoryIds.has(category.id)) continue;
      const remaining = Number(category.remaining);
      if (!Number.isFinite(remaining) || remaining <= 0) continue;
      reservations.push({
        durableIdentity: `budget:${category.id}`,
        categoryId: category.id,
        categoryName: category.name,
        remainingCents: toCents(remaining),
        incompleteReasons: [],
      });
    }
  }
  return { reservations, incompleteReasons };
}

function buildCreditLiabilities({
  accounts = [],
  accountOverrides = {},
  recurring = {},
  operatingAccountIds = [],
  financeDate,
}) {
  const liabilities = [];
  const fundingAccountsByLiability = {};
  const policies = {};
  const recurringItems = [...(recurring.items || []), ...(recurring.hiddenItems || [])];
  const primaryOperating = [...operatingAccountIds][0] || null;

  for (const account of accounts || []) {
    const override = accountOverrides[account.id] || {};
    const policy = resolveAccountCreditPolicy({
      ...account,
      financeDate,
      role: override.role || account.role || 'unknown',
    }, override);
    policies[account.id] = policy;
    if (policy.mode === COVERAGE_MODE.UNKNOWN) continue;
    if (policy.excluded || !policy.eligible) continue;

    const link = policy.paymentRecurringKey
      ? resolvePaymentLink(recurringItems, policy.paymentRecurringKey)
      : { linked: false, ambiguous: false, item: null };
    if (policy.paymentRecurringKey && (!link.linked || link.ambiguous)) {
      liabilities.push({
        durableIdentity: `liability:credit:${account.id}`,
        accountId: account.id,
        name: account.name,
        excluded: false,
        eligible: true,
        quarantineReasons: [OBLIGATION_REASON.liabilityUnresolved],
        paymentRecurringKey: policy.paymentRecurringKey,
      });
      continue;
    }

    const paymentDueDate = policy.paymentDueDate
      || link.item?.nextRenewal
      || link.item?.projectedOccurrences?.[0]?.date
      || null;
    const fundingAccountId = policy.fundingAccountId || primaryOperating;
    if (fundingAccountId) fundingAccountsByLiability[account.id] = fundingAccountId;

    liabilities.push({
      durableIdentity: `liability:credit:${account.id}`,
      accountId: account.id,
      name: account.name,
      excluded: false,
      eligible: policy.eligible,
      obligationCents: policy.obligationCents,
      currentBalanceCents: policy.currentBalanceCents,
      coverageKind: policy.coverageKind,
      paymentDueDate,
      paymentRecurringKey: policy.paymentRecurringKey || null,
      fundingAccountId,
      observedAt: policy.observedAt || null,
      cycleKey: paymentDueDate ? liabilityCycleKey(account.id, paymentDueDate) : null,
      quarantineReasons: policy.quarantineReasons || [],
    });
  }

  return { liabilities, fundingAccountsByLiability, policies };
}

function buildManualDebts(debts) {
  return (debts || []).map((debt) => {
    const balanceCents = toCents(Math.abs(Number(debt.balance) || 0));
    const paymentCents = debt.minPayment != null ? toCents(Math.abs(Number(debt.minPayment) || 0)) : null;
    const interestCents = debt.interestPortionCents != null
      ? Math.abs(debt.interestPortionCents)
      : null;
    const principalCents = debt.principalPortionCents != null
      ? Math.abs(debt.principalPortionCents)
      : (interestCents != null && paymentCents != null ? paymentCents - interestCents : balanceCents);
    return {
      durableIdentity: `debt:${debt.id}`,
      id: debt.id,
      name: debt.name,
      dueDate: debt.dueDate || null,
      balanceCents,
      paymentCents,
      principalCents,
      interestCents,
      apr: debt.apr,
      strategy: debt.strategy,
    };
  });
}

function buildBillOccurrences({ bills, liabilityByPaymentKey = new Map() }) {
  return (bills || []).map((bill) => {
    const liability = liabilityByPaymentKey.get(bill.key);
    return {
      durableIdentity: billDurableIdentity(bill.key, bill.dueDate),
      id: bill.id,
      key: bill.key,
      payee: bill.payee,
      dueDate: bill.dueDate,
      amountCents: toCents(Math.abs(Number(bill.amount) || 0)),
      paid: !!bill.paid,
      provenance: bill.matched ? 'known' : 'inferred',
      scheduleUncertain: false,
      liabilityAccountId: liability?.accountId || null,
      liabilityLinked: !!liability,
      liabilityCycleKey: liability?.cycleKey && liability?.paymentDueDate === bill.dueDate
        ? liability.cycleKey
        : null,
    };
  });
}

function buildGraphTransactionInputs(rows, catInfo, {
  windowStart,
  windowEnd,
  accountRolesById = {},
  creditAccountIds = new Set(),
}) {
  const transferIndex = buildTransferIndex(rows);
  const transfers = [];
  const economicTransactions = [];
  const seenTransferKeys = new Set();
  const seenEconomicIds = new Set();

  for (const row of rows || []) {
    const date = row.transaction?.date;
    if (!date || date < windowStart || date > windowEnd) continue;
    const classified = classifyTransactionLeaves(row.transaction, catInfo, {
      accountId: row.accountId,
      transferIndex,
    });
    for (const leaf of classified) {
      const txnId = String(leaf.parentId || leaf.id || row.transaction.id);
      if (leaf.kind === 'transfer') {
        const linkId = String(leaf.transferIdentity?.linkId || leaf.transferId || leaf.transferredId || txnId);
        const dedupeKey = `transfer:${linkId}:${leaf.transferIdentity?.accountId || row.accountId}`;
        if (seenTransferKeys.has(dedupeKey)) continue;
        seenTransferKeys.add(dedupeKey);
        const toAccountId = leaf.amount < 0
          ? (leaf.transferIdentity?.counterpartAccountId || null)
          : row.accountId;
        transfers.push({
          durableIdentity: `transfer:${linkId}`,
          linkId,
          date,
          amountCents: leaf.amount,
          fromAccountId: leaf.amount < 0 ? row.accountId : (leaf.transferIdentity?.counterpartAccountId || row.accountId),
          toAccountId,
          label: `Transfer ${linkId}`,
          ambiguous: false,
          provenance: 'actual',
          fundsLiabilityAccountId: toAccountId && creditAccountIds.has(toAccountId) ? toAccountId : null,
        });
        continue;
      }
      if (leaf.kind === 'incomplete' && leaf.provenance === PROVENANCE.TRANSFER_IDENTITY) {
        const linkId = String(leaf.transferIdentity?.linkId || txnId);
        const dedupeKey = `ambiguous:${linkId}:${txnId}`;
        if (seenTransferKeys.has(dedupeKey)) continue;
        seenTransferKeys.add(dedupeKey);
        transfers.push({
          durableIdentity: `transfer:${linkId}`,
          linkId,
          date,
          amountCents: leaf.amount,
          fromAccountId: row.accountId,
          toAccountId: leaf.transferIdentity?.counterpartAccountId || null,
          ambiguous: true,
          provenance: 'actual',
        });
        continue;
      }
      const accountRole = accountRolesById[row.accountId] || 'unknown';
      if (accountRole === 'credit_card' && leafCountsAsRealSpend(leaf) && !leaf.spendingExcluded) {
        const economicId = String(leaf.id || txnId);
        if (seenEconomicIds.has(economicId)) continue;
        seenEconomicIds.add(economicId);
        economicTransactions.push({
          durableIdentity: `txn:${economicId}`,
          transactionId: economicId,
          date,
          amountCents: leaf.amount,
          label: `Credit purchase ${economicId}`,
          explanation: ['Credit card purchase — economic spend only'],
        });
      }
    }
  }

  return { transfers, economicTransactions };
}

function buildReimbursementExpectations({ reimb, linksAmbiguous = false, allocationIncomplete = false }) {
  const items = [];
  if (allocationIncomplete || linksAmbiguous) {
    items.push({
      durableIdentity: 'reimbursement:allocation:global',
      id: 'allocation-global',
      label: 'Reimbursement allocation',
      allocationIncomplete: true,
      ambiguous: linksAmbiguous,
    });
    return items;
  }
  const totalOwed = Number(reimb?.totalOwed) || 0;
  if (totalOwed > 0.5) {
    items.push({
      durableIdentity: 'reimbursement:expected:aggregate',
      id: 'aggregate',
      label: 'Possible reimbursements',
      expectedCents: toCents(totalOwed),
      expectedDate: reimb?.possibleDate || null,
      allocationIncomplete: false,
      ambiguous: false,
      provenance: 'splitwise',
    });
  }
  return items;
}

function collectBillCategoryIds(recurring = {}, budgets = {}) {
  const billIndex = buildBillCategoryIndex(recurring);
  const ids = new Set([...billIndex.byCategoryId.keys()]);
  for (const group of budgets?.groups || []) {
    for (const category of group.categories || []) {
      if (billIndex.byCategoryId.has(category.id)) {
        ids.add(category.id);
      }
    }
  }
  return ids;
}

function liabilityByPaymentKeyMap(liabilities = []) {
  const map = new Map();
  for (const liability of liabilities) {
    if (liability.paymentRecurringKey) map.set(liability.paymentRecurringKey, liability);
  }
  return map;
}

function assembleObligationGraphInputs({
  financeDate,
  windowStart,
  windowEnd,
  accounts = [],
  accountOverrides = {},
  recurring = {},
  income = {},
  bills = {},
  budgets = {},
  debts = [],
  reimb = {},
  reimbLinks = [],
  transfers = [],
  economicTransactions = [],
  operatingAccountIds = [],
}) {
  const recurringItems = [];
  for (const item of [...(recurring.items || []), ...(recurring.hiddenItems || [])]) {
    const projection = buildRecurringProjections(item, { windowStart, windowEnd, today: financeDate });
    recurringItems.push({
      key: item.key,
      durableIdentity: recurringDurableIdentity(item.key),
      payee: item.payee,
      cadence: item.cadence,
      isBill: !!item.isBill,
      forced: !!item.forced,
      status: item.status,
      categoryId: item.categoryId || null,
      projectionUncertain: !!item.projectionUncertain,
      scheduleUncertain: item.isBill ? !!item.projectionUncertain : projection.scheduleUncertain,
      projectedOccurrences: item.isBill ? [] : projection.projectedOccurrences,
      provenance: item.forced ? 'manual' : 'inferred',
    });
  }

  const incomeStreams = (income.streams || []).map((stream) => {
    const projection = buildIncomeProjections(stream, { windowStart, windowEnd, today: financeDate });
    return {
      key: stream.key,
      durableIdentity: `income:${stream.key}`,
      payee: stream.payee,
      active: !!stream.active,
      scheduleUncertain: projection.scheduleUncertain,
      projectedOccurrences: projection.projectedOccurrences,
      provenance: 'inferred',
    };
  });

  const billCategoryIds = collectBillCategoryIds(recurring, budgets);
  const { reservations: budgetReservations } = buildBudgetReservations({ budgets, billCategoryIds });
  const operatingIds = new Set(operatingAccountIds);
  const {
    liabilities: creditLiabilities,
    fundingAccountsByLiability,
    policies: liabilityPolicies,
  } = buildCreditLiabilities({
    accounts,
    accountOverrides,
    recurring,
    operatingAccountIds: operatingIds,
    financeDate,
  });
  const liabilityByPaymentKey = liabilityByPaymentKeyMap(creditLiabilities);

  const linksAmbiguous = (reimbLinks || []).some((link) => link?.ambiguous === true);
  const allocationIncomplete = (reimbLinks || []).some((link) => link?.allocationIncomplete === true);

  return {
    generatedAt: new Date().toISOString(),
    financeDate,
    windowStart,
    windowEnd,
    recurringItems,
    billOccurrences: buildBillOccurrences({ bills: bills.bills, liabilityByPaymentKey }),
    incomeStreams,
    manualDebts: buildManualDebts(debts),
    creditLiabilities,
    liabilityPolicies,
    fundingAccountsByLiability,
    operatingAccountIds: [...operatingIds],
    billCategoryIds: [...billCategoryIds],
    budgetReservations,
    reimbursementExpectations: buildReimbursementExpectations({
      reimb,
      linksAmbiguous,
      allocationIncomplete,
    }),
    transfers: (transfers || []).map((transfer) => ({
      durableIdentity: `transfer:${transfer.linkId}`,
      linkId: transfer.linkId,
      date: transfer.date,
      amountCents: transfer.amountCents,
      fromAccountId: transfer.fromAccountId,
      toAccountId: transfer.toAccountId,
      label: transfer.label,
      ambiguous: !!transfer.ambiguous,
      provenance: transfer.provenance || 'actual',
      fundsLiabilityAccountId: transfer.fundsLiabilityAccountId || null,
    })),
    economicTransactions: (economicTransactions || []).map((txn) => ({
      durableIdentity: `txn:${txn.transactionId}`,
      transactionId: txn.transactionId,
      date: txn.date,
      amountCents: txn.amountCents,
      label: txn.label,
      explanation: txn.explanation,
    })),
  };
}

module.exports = {
  assembleObligationGraphInputs,
  billDurableIdentity,
  buildBillCategoryIndex,
  buildBillOccurrences,
  buildBudgetReservations,
  buildCreditLiabilities,
  buildGraphTransactionInputs,
  buildIncomeProjections,
  buildManualDebts,
  buildRecurringProjections,
  buildReimbursementExpectations,
  collectBillCategoryIds,
  isBillBackedCategory,
  recurringDurableIdentity,
  OBLIGATION_REASON,
  COVERAGE_MODE,
};
