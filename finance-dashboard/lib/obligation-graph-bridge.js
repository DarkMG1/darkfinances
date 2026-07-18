'use strict';

const { toCents } = require('./domain/money');
const {
  buildTransferIndex,
  classifyTransactionLeaves,
  leafCountsAsRealSpend,
  PROVENANCE,
} = require('./domain/classification');
const {
  inferRecurrenceSchedule,
  projectOccurrences,
} = require('./recurrence');
const { OBLIGATION_REASON } = require('./domain/obligation-graph');

const BILL_CAT = /(util|electric|power|energy|\bgas\b|water|sewer|trash|internet|cable|phone|mobile|wireless|insuranc|rent|mortgage|\bloan|subscription|membership|fitness|gym|\bhealth|software|hosting|cloud|stream|donat|charit)/i;

function recurringDurableIdentity(key) {
  return `recurring:${key}`;
}

function billDurableIdentity(key, dueDate) {
  return `bill:${key}|${dueDate}`;
}

function incomeDurableIdentity(key) {
  return `income:${key}`;
}

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

function buildBudgetReservations({ budgets, groups }) {
  const reservations = [];
  const incompleteReasons = [];
  if (budgets?.supported === false) {
    incompleteReasons.push('budget_data_unavailable');
    return { reservations, incompleteReasons };
  }
  for (const group of groups || budgets?.groups || []) {
    for (const category of group.categories || []) {
      if (BILL_CAT.test(`${group.name || ''} ${category.name || ''}`)) continue;
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

function buildCreditLiabilities({ accounts, recurringItems, operatingAccountIds }) {
  const liabilities = [];
  const fundingAccountsByLiability = {};
  const primaryOperating = [...operatingAccountIds][0] || null;
  for (const account of accounts || []) {
    if (account.closed || account.hidden || account.role !== 'credit_card') continue;
    const balanceCents = toCents(Number(account.balance) || 0);
    if (balanceCents >= 0) continue;
    const paymentRecurring = (recurringItems || []).find((item) =>
      item.status === 'active'
      && item.isBill
      && /card|credit|payment/i.test(`${item.payee || ''} ${item.category || ''}`));
    let paymentDueDate = null;
    if (paymentRecurring?.nextRenewal) paymentDueDate = paymentRecurring.nextRenewal;
    if (!paymentDueDate && paymentRecurring?.projectedOccurrences?.[0]?.date) {
      paymentDueDate = paymentRecurring.projectedOccurrences[0].date;
    }
    if (primaryOperating) fundingAccountsByLiability[account.id] = primaryOperating;
    liabilities.push({
      durableIdentity: `liability:credit:${account.id}`,
      accountId: account.id,
      name: account.name,
      statementBalanceCents: balanceCents,
      paymentDueDate,
      fundingAccountId: primaryOperating,
    });
  }
  return { liabilities, fundingAccountsByLiability };
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

function buildBillOccurrences({ bills }) {
  return (bills || []).map((bill) => ({
    durableIdentity: billDurableIdentity(bill.key, bill.dueDate),
    id: bill.id,
    key: bill.key,
    payee: bill.payee,
    dueDate: bill.dueDate,
    amountCents: toCents(Math.abs(Number(bill.amount) || 0)),
    paid: !!bill.paid,
    provenance: bill.matched ? 'known' : 'inferred',
    scheduleUncertain: false,
  }));
}

function buildGraphTransactionInputs(rows, catInfo, { windowStart, windowEnd, accountRolesById = {} }) {
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
        transfers.push({
          durableIdentity: `transfer:${linkId}`,
          linkId,
          date,
          amountCents: leaf.amount,
          fromAccountId: leaf.amount < 0 ? row.accountId : (leaf.transferIdentity?.counterpartAccountId || row.accountId),
          toAccountId: leaf.amount < 0 ? (leaf.transferIdentity?.counterpartAccountId || null) : row.accountId,
          label: `Transfer ${linkId}`,
          ambiguous: false,
          provenance: 'actual',
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

function assembleObligationGraphInputs({
  financeDate,
  windowStart,
  windowEnd,
  accounts = [],
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
      projectionUncertain: !!item.projectionUncertain,
      scheduleUncertain: item.isBill ? false : projection.scheduleUncertain,
      projectedOccurrences: item.isBill ? [] : projection.projectedOccurrences,
      provenance: item.forced ? 'manual' : 'inferred',
    });
  }

  const incomeStreams = (income.streams || []).map((stream) => {
    const projection = buildIncomeProjections(stream, { windowStart, windowEnd, today: financeDate });
    return {
      key: stream.key,
      durableIdentity: incomeDurableIdentity(stream.key),
      payee: stream.payee,
      active: !!stream.active,
      scheduleUncertain: projection.scheduleUncertain,
      projectedOccurrences: projection.projectedOccurrences,
      provenance: 'inferred',
    };
  });

  const { reservations: budgetReservations } = buildBudgetReservations({ budgets });
  const operatingIds = new Set(operatingAccountIds);
  const { liabilities: creditLiabilities, fundingAccountsByLiability } = buildCreditLiabilities({
    accounts,
    recurringItems: [...(recurring.items || []), ...(recurring.hiddenItems || [])],
    operatingAccountIds: operatingIds,
  });

  const linksAmbiguous = (reimbLinks || []).some((link) => link?.ambiguous === true);
  const allocationIncomplete = (reimbLinks || []).some((link) => link?.allocationIncomplete === true);

  return {
    generatedAt: new Date().toISOString(),
    financeDate,
    windowStart,
    windowEnd,
    recurringItems,
    billOccurrences: buildBillOccurrences({ bills: bills.bills }),
    incomeStreams,
    manualDebts: buildManualDebts(debts),
    creditLiabilities,
    fundingAccountsByLiability,
    operatingAccountIds: [...operatingIds],
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
      provenance: 'actual',
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
  BILL_CAT,
  assembleObligationGraphInputs,
  billDurableIdentity,
  buildBillOccurrences,
  buildBudgetReservations,
  buildCreditLiabilities,
  buildGraphTransactionInputs,
  buildIncomeProjections,
  buildManualDebts,
  buildRecurringProjections,
  buildReimbursementExpectations,
  incomeDurableIdentity,
  recurringDurableIdentity,
  OBLIGATION_REASON,
};
