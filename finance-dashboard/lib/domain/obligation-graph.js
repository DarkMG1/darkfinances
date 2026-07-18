'use strict';

const crypto = require('crypto');
const { sumCents } = require('./money');
const {
  absCents,
  computeAdjustedObligation,
  computePartition,
  observedDateOnly,
  validateCycleEvidence,
  verifyCyclePartitionInvariants,
} = require('./liability-cycle-partition');

const OBLIGATION_GRAPH_VERSION = 1;
const MAX_OCCURRENCES = 100_000;

const OBLIGATION_REASON = Object.freeze({
  recurrenceUnresolved: 'obligation_recurrence_unresolved',
  fundingAccountMissing: 'obligation_funding_account_missing',
  liabilityUnresolved: 'obligation_liability_unresolved',
  liabilityFundingMismatch: 'obligation_liability_funding_mismatch',
  identityOverlapAmbiguous: 'obligation_identity_overlap_ambiguous',
  transferAmbiguous: 'obligation_transfer_ambiguous',
  reimbursementAllocationIncomplete: 'obligation_reimbursement_allocation_incomplete',
  sourceStale: 'obligation_source_stale',
  debtTermsUnsupported: 'obligation_debt_terms_unsupported',
  duplicateIdentity: 'obligation_duplicate_identity',
  occurrenceCapExceeded: 'obligation_occurrence_cap_exceeded',
});

const OBLIGATION_REASON_ORDER = Object.freeze([
  OBLIGATION_REASON.duplicateIdentity,
  OBLIGATION_REASON.occurrenceCapExceeded,
  OBLIGATION_REASON.identityOverlapAmbiguous,
  OBLIGATION_REASON.recurrenceUnresolved,
  OBLIGATION_REASON.liabilityUnresolved,
  OBLIGATION_REASON.liabilityFundingMismatch,
  OBLIGATION_REASON.fundingAccountMissing,
  OBLIGATION_REASON.transferAmbiguous,
  OBLIGATION_REASON.reimbursementAllocationIncomplete,
  OBLIGATION_REASON.debtTermsUnsupported,
  OBLIGATION_REASON.sourceStale,
]);

const SOURCE_KIND = Object.freeze({
  RECURRING: 'recurring',
  BILL: 'bill',
  INCOME: 'income',
  DEBT_MANUAL: 'debt_manual',
  CREDIT_LIABILITY: 'credit_liability',
  BUDGET: 'budget',
  TRANSFER: 'transfer',
  REIMBURSEMENT: 'reimbursement',
  TRANSACTION: 'transaction',
});

const NODE_KIND = Object.freeze({
  RECURRING_BILL: 'recurring_bill',
  RECURRING_SUBSCRIPTION: 'recurring_subscription',
  INCOME: 'income',
  MANUAL_DEBT: 'manual_debt',
  CREDIT_LIABILITY: 'credit_liability',
  BUDGET_RESERVATION: 'budget_reservation',
  TRANSFER: 'transfer',
  REIMBURSEMENT_EXPECTED: 'reimbursement_expected',
});

const EDGE_KIND = Object.freeze({
  FUNDING_PARTITION: 'funding_partition',
  TRANSFER_INTERNAL: 'transfer_internal',
});

const PARTITION_KIND = Object.freeze({
  FUTURE_TRANSFER: 'future_transfer',
  BILL_REMAINDER: 'bill_remainder',
  RESIDUAL_LIABILITY: 'residual_liability',
});

const OCCURRENCE_ROLE = Object.freeze({
  ECONOMIC_EXPENSE: 'economic_expense',
  ECONOMIC_INCOME: 'economic_income',
  CASH_OUTFLOW: 'cash_outflow',
  CASH_INFLOW: 'cash_inflow',
  INTERNAL_TRANSFER: 'internal_transfer',
  LIABILITY_ACCRUAL: 'liability_accrual',
});

function stableHash(parts) {
  return crypto.createHash('sha256').update(parts.join('\0')).digest('hex').slice(0, 16);
}

function stableNodeId(durableIdentity) {
  return `node:${stableHash(['node', String(durableIdentity)])}`;
}

function stableOccurrenceId(durableIdentity, date, role) {
  return `occ:${stableHash(['occ', String(durableIdentity), String(date), String(role)])}`;
}

function stableEdgeId(fromNodeId, toNodeId, kind) {
  return `edge:${stableHash(['edge', fromNodeId, toNodeId, kind])}`;
}

function sortByKeys(items, keys) {
  return [...items].sort((a, b) => {
    for (const key of keys) {
      const av = a[key] ?? '';
      const bv = b[key] ?? '';
      if (av < bv) return -1;
      if (av > bv) return 1;
    }
    return 0;
  });
}

function requireSafeCents(value, label) {
  if (!Number.isSafeInteger(value)) {
    throw new TypeError(`${label} must be a safe integer cent amount`);
  }
  return value;
}

function mergeReasons(parts) {
  const found = new Set();
  for (const part of parts || []) {
    for (const reason of part || []) {
      if (reason) found.add(reason);
    }
  }
  return OBLIGATION_REASON_ORDER.filter((reason) => found.has(reason));
}

function graphCompleteness(graph) {
  const nodeReasons = (graph.nodes || []).flatMap((node) => node.incompleteReasons || []);
  const graphReasons = graph.incompleteReasons || [];
  const reasons = mergeReasons([graphReasons, nodeReasons]);
  return {
    complete: reasons.length === 0,
    incompleteReasons: reasons,
    occurrenceCount: (graph.occurrences || []).length,
    reservedOccurrenceCount: (graph.occurrences || []).filter((occ) => occ.reserved).length,
  };
}

function registerNode(registry, node) {
  const existing = registry.byIdentity.get(node.durableIdentity);
  if (existing) {
    const conflicting = existing.id !== node.id
      || existing.kind !== node.kind
      || (existing.source?.kind || '') !== (node.source?.kind || '');
    if (conflicting) {
      registry.duplicates.push({ durableIdentity: node.durableIdentity, first: existing.id, second: node.id });
      node.incompleteReasons = [...new Set([...(node.incompleteReasons || []), OBLIGATION_REASON.duplicateIdentity])];
      existing.incompleteReasons = [...new Set([...(existing.incompleteReasons || []), OBLIGATION_REASON.duplicateIdentity])];
    }
    return existing;
  }
  registry.byIdentity.set(node.durableIdentity, node);
  registry.nodes.push(node);
  return node;
}

function registerOccurrence(state, occurrence) {
  if (state.occurrences.length >= MAX_OCCURRENCES) {
    state.capExceeded = true;
    return null;
  }
  state.occurrences.push(occurrence);
  return occurrence;
}

function buildObligationGraph(rawInput = {}) {
  const input = normalizeBuildInput(rawInput);
  const registry = { nodes: [], byIdentity: new Map(), duplicates: [] };
  const state = {
    occurrences: [],
    edges: [],
    capExceeded: false,
    incompleteReasons: [],
    pendingCycles: [],
    cyclePartitions: [],
    blockBudgetReservations: (input.billCategoryIdentityIssues || []).length > 0,
  };

  if (state.blockBudgetReservations) {
    state.incompleteReasons = mergeReasons([state.incompleteReasons, [OBLIGATION_REASON.identityOverlapAmbiguous]]);
  }

  for (const recurring of input.recurringItems) ingestRecurring(registry, state, recurring, input);
  for (const bill of input.billOccurrences) ingestBillOccurrence(registry, state, bill, input);
  for (const income of input.incomeStreams) ingestIncome(registry, state, income, input);
  for (const debt of input.manualDebts) ingestManualDebt(registry, state, debt, input);
  for (const liability of input.creditLiabilities) ingestCreditLiability(registry, state, liability, input);
  for (const transfer of input.transfers) ingestTransfer(registry, state, transfer, input);
  for (const budget of input.budgetReservations) ingestBudgetReservation(registry, state, budget, input);
  for (const reimb of input.reimbursementExpectations) ingestReimbursement(registry, state, reimb, input);
  for (const txn of input.economicTransactions) ingestEconomicTransaction(registry, state, txn, input);

  dedupeOverlappingSources(registry, state);
  reconcileBillBudgetOverlap(registry, state, input);
  reconcileLiabilityFundingLedger(registry, state, input);

  if (registry.duplicates.length) {
    state.incompleteReasons = mergeReasons([state.incompleteReasons, [OBLIGATION_REASON.duplicateIdentity]]);
  }
  if (state.capExceeded) {
    state.incompleteReasons = mergeReasons([state.incompleteReasons, [OBLIGATION_REASON.occurrenceCapExceeded]]);
  }

  const nodes = sortByKeys(registry.nodes, ['durableIdentity', 'id']);
  const occurrences = sortByKeys(state.occurrences, ['date', 'id']);
  const edges = sortByKeys(
    (state.occurrences || [])
      .flatMap((occ) => {
        if (!occ.partition || !occ.reserved) return [];
        return [{
          id: stableEdgeId(occ.nodeId, occ.id, EDGE_KIND.FUNDING_PARTITION),
          kind: EDGE_KIND.FUNDING_PARTITION,
          fromNodeId: occ.nodeId,
          occurrenceId: occ.id,
          partition: occ.partition,
          cycleKey: occ.cycleKey || null,
          amountCents: Math.abs(occ.amountCents),
          explanationRef: occ.id,
        }];
      })
      .concat((state.occurrences || [])
        .filter((occ) => occ.role === OCCURRENCE_ROLE.INTERNAL_TRANSFER)
        .map((occ) => ({
          id: stableEdgeId(occ.nodeId, occ.id, EDGE_KIND.TRANSFER_INTERNAL),
          kind: EDGE_KIND.TRANSFER_INTERNAL,
          fromNodeId: occ.nodeId,
          occurrenceId: occ.id,
          amountCents: Math.abs(occ.amountCents),
          explanationRef: occ.id,
        }))),
    ['id'],
  );

  const graph = {
    version: OBLIGATION_GRAPH_VERSION,
    generatedAt: input.generatedAt,
    financeDate: input.financeDate,
    window: { start: input.windowStart, end: input.windowEnd },
    nodes,
    edges,
    occurrences,
    cyclePartitions: state.cyclePartitions,
    incompleteReasons: mergeReasons([state.incompleteReasons, ...nodes.map((n) => n.incompleteReasons)]),
  };
  graph.completeness = graphCompleteness(graph);
  return graph;
}

function normalizeBuildInput(raw) {
  return {
    generatedAt: raw.generatedAt || new Date(0).toISOString(),
    financeDate: raw.financeDate,
    windowStart: raw.windowStart,
    windowEnd: raw.windowEnd,
    recurringItems: sortByKeys(raw.recurringItems || [], ['durableIdentity', 'key']),
    billOccurrences: sortByKeys(raw.billOccurrences || [], ['durableIdentity', 'dueDate']),
    incomeStreams: sortByKeys(raw.incomeStreams || [], ['durableIdentity', 'key']),
    manualDebts: sortByKeys(raw.manualDebts || [], ['durableIdentity', 'id']),
    creditLiabilities: sortByKeys(raw.creditLiabilities || [], ['durableIdentity', 'accountId']),
    liabilityPolicies: raw.liabilityPolicies || {},
    billCategoryIds: new Set(raw.billCategoryIds || []),
    transfers: sortByKeys(raw.transfers || [], ['durableIdentity', 'linkId']),
    budgetReservations: sortByKeys(raw.budgetReservations || [], ['durableIdentity', 'categoryId']),
    reimbursementExpectations: sortByKeys(raw.reimbursementExpectations || [], ['durableIdentity', 'id']),
    economicTransactions: sortByKeys(raw.economicTransactions || [], ['durableIdentity', 'transactionId']),
    operatingAccountIds: new Set(raw.operatingAccountIds || []),
    fundingAccountsByLiability: raw.fundingAccountsByLiability || {},
    billCategoryIdentityIssues: sortByKeys(raw.billCategoryIdentityIssues || [], ['key', 'status']),
  };
}

function ingestRecurring(registry, state, item, input) {
  const durableIdentity = item.durableIdentity || `recurring:${item.key}`;
  const node = registerNode(registry, {
    id: stableNodeId(durableIdentity),
    durableIdentity,
    kind: item.isBill ? NODE_KIND.RECURRING_BILL : NODE_KIND.RECURRING_SUBSCRIPTION,
    label: item.payee || item.key,
    source: { kind: SOURCE_KIND.RECURRING, key: item.key, provenance: item.provenance || 'inferred' },
    incompleteReasons: [],
    metadata: { cadence: item.cadence, isBill: !!item.isBill },
  });

  if (item.projectionUncertain || item.scheduleUncertain) {
    node.incompleteReasons = mergeReasons([node.incompleteReasons, [OBLIGATION_REASON.recurrenceUnresolved]]);
    return;
  }

  for (const projected of item.projectedOccurrences || []) {
    if (projected.date < input.windowStart || projected.date > input.windowEnd) continue;
    const role = item.isBill ? OCCURRENCE_ROLE.ECONOMIC_EXPENSE : OCCURRENCE_ROLE.CASH_OUTFLOW;
    registerOccurrence(state, {
      id: stableOccurrenceId(durableIdentity, projected.date, role),
      nodeId: node.id,
      durableIdentity,
      date: projected.date,
      amountCents: requireSafeCents(-Math.abs(projected.amountCents), 'projected.amountCents'),
      role,
      reserved: !item.isBill,
      paid: !!projected.paid,
      auditOnly: !!item.isBill,
      source: { kind: SOURCE_KIND.RECURRING, key: item.key, provenance: projected.provenance || 'inferred' },
      explanation: item.isBill
        ? [`Recurring bill series ${item.key} (economic audit only; cash from bill occurrence)`]
        : [`Subscription cash outflow ${item.key}`],
      dedupeGroup: item.isBill ? `bill-series:${item.key}` : `sub-series:${item.key}`,
    });
  }
}

function ingestBillOccurrence(registry, state, bill, input) {
  const durableIdentity = bill.durableIdentity || `bill:${bill.key}|${bill.dueDate}`;
  const node = registerNode(registry, {
    id: stableNodeId(durableIdentity),
    durableIdentity,
    kind: NODE_KIND.RECURRING_BILL,
    label: bill.payee || bill.key,
    source: { kind: SOURCE_KIND.BILL, id: bill.id, key: bill.key, provenance: bill.provenance || 'inferred' },
    incompleteReasons: [],
    metadata: { dueDate: bill.dueDate, liabilityAccountId: bill.liabilityAccountId || null },
  });
  if (bill.scheduleUncertain) {
    node.incompleteReasons = mergeReasons([node.incompleteReasons, [OBLIGATION_REASON.recurrenceUnresolved]]);
    return;
  }
  if (bill.dueDate < input.windowStart || bill.dueDate > input.windowEnd) return;
  const liabilityLinked = !!bill.liabilityLinked;
  const dedupeGroup = bill.liabilityCycleKey || `bill-series:${bill.key}`;
  registerOccurrence(state, {
    id: stableOccurrenceId(durableIdentity, bill.dueDate, OCCURRENCE_ROLE.CASH_OUTFLOW),
    nodeId: node.id,
    durableIdentity,
    date: bill.dueDate,
    amountCents: requireSafeCents(-Math.abs(bill.amountCents), 'bill.amountCents'),
    role: OCCURRENCE_ROLE.CASH_OUTFLOW,
    reserved: !bill.paid && !liabilityLinked,
    paid: !!bill.paid,
    auditOnly: liabilityLinked,
    source: { kind: SOURCE_KIND.BILL, id: bill.id, key: bill.key, provenance: bill.provenance || 'inferred' },
    explanation: bill.liabilityCycleKey
      ? [`Bill schedule evidence for liability cycle ${bill.liabilityCycleKey}`]
      : liabilityLinked
        ? [`Bill linked to liability payment key ${bill.key} (schedule evidence only)`]
        : [`Bill due ${bill.dueDate} for ${bill.key}`],
    dedupeGroup,
    components: liabilityLinked
      ? { billCents: Math.abs(bill.amountCents), liabilityCycleKey: bill.liabilityCycleKey || null }
      : undefined,
  });
}

function ingestIncome(registry, state, stream, input) {
  const durableIdentity = stream.durableIdentity || `income:${stream.key}`;
  const node = registerNode(registry, {
    id: stableNodeId(durableIdentity),
    durableIdentity,
    kind: NODE_KIND.INCOME,
    label: stream.payee || stream.key,
    source: { kind: SOURCE_KIND.INCOME, key: stream.key, provenance: stream.provenance || 'inferred' },
    incompleteReasons: [],
  });
  if (stream.scheduleUncertain) {
    node.incompleteReasons = mergeReasons([node.incompleteReasons, [OBLIGATION_REASON.recurrenceUnresolved]]);
    return;
  }
  for (const projected of stream.projectedOccurrences || []) {
    if (projected.date < input.windowStart || projected.date > input.windowEnd) continue;
    registerOccurrence(state, {
      id: stableOccurrenceId(durableIdentity, projected.date, OCCURRENCE_ROLE.CASH_INFLOW),
      nodeId: node.id,
      durableIdentity,
      date: projected.date,
      amountCents: requireSafeCents(Math.abs(projected.amountCents), 'income.amountCents'),
      role: OCCURRENCE_ROLE.CASH_INFLOW,
      reserved: false,
      paid: false,
      source: { kind: SOURCE_KIND.INCOME, key: stream.key, provenance: projected.provenance || 'inferred' },
      explanation: [`Income stream ${stream.key}`],
      dedupeGroup: `income-series:${stream.key}`,
    });
  }
}

function ingestManualDebt(registry, state, debt, input) {
  const durableIdentity = debt.durableIdentity || `debt:${debt.id}`;
  const node = registerNode(registry, {
    id: stableNodeId(durableIdentity),
    durableIdentity,
    kind: NODE_KIND.MANUAL_DEBT,
    label: debt.name || debt.id,
    source: { kind: SOURCE_KIND.DEBT_MANUAL, id: debt.id, provenance: 'manual' },
    incompleteReasons: [],
    metadata: { apr: debt.apr, strategy: debt.strategy },
  });
  if (!debt.dueDate || !Number.isSafeInteger(debt.paymentCents) || debt.paymentCents <= 0) {
    node.incompleteReasons = mergeReasons([node.incompleteReasons, [OBLIGATION_REASON.debtTermsUnsupported]]);
    return;
  }
  if (debt.dueDate < input.windowStart || debt.dueDate > input.windowEnd) return;
  const principalCents = requireSafeCents(Math.abs(debt.principalCents || debt.balanceCents || 0), 'debt.principalCents');
  const interestCents = requireSafeCents(Math.abs(debt.interestCents || 0), 'debt.interestCents');
  const paymentCents = requireSafeCents(Math.abs(debt.paymentCents), 'debt.paymentCents');
  if (paymentCents !== sumCents([principalCents, interestCents]) && (debt.interestCents != null || debt.principalCents != null)) {
    node.incompleteReasons = mergeReasons([node.incompleteReasons, [OBLIGATION_REASON.debtTermsUnsupported]]);
    return;
  }
  registerOccurrence(state, {
    id: stableOccurrenceId(durableIdentity, debt.dueDate, OCCURRENCE_ROLE.CASH_OUTFLOW),
    nodeId: node.id,
    durableIdentity,
    date: debt.dueDate,
    amountCents: -paymentCents,
    role: OCCURRENCE_ROLE.CASH_OUTFLOW,
    reserved: true,
    paid: false,
    source: { kind: SOURCE_KIND.DEBT_MANUAL, id: debt.id, provenance: 'manual' },
    explanation: [
      `Manual debt payment ${debt.id}`,
      ...(interestCents ? [`Interest portion ${interestCents} cents`] : []),
      ...(principalCents ? [`Principal portion ${principalCents} cents`] : []),
    ],
    dedupeGroup: `debt:${debt.id}`,
    components: { principalCents, interestCents },
  });
}

function ingestCreditLiability(registry, state, liability, input) {
  if (liability.excluded) return;
  const durableIdentity = liability.durableIdentity || `liability:credit:${liability.accountId}`;
  const node = registerNode(registry, {
    id: stableNodeId(durableIdentity),
    durableIdentity,
    kind: NODE_KIND.CREDIT_LIABILITY,
    label: liability.name || liability.accountId,
    source: {
      kind: SOURCE_KIND.CREDIT_LIABILITY,
      accountId: liability.accountId,
      provenance: liability.coverageKind || 'policy',
      paymentRecurringKey: liability.paymentRecurringKey || null,
    },
    incompleteReasons: [...(liability.quarantineReasons || [])],
    metadata: {
      coverageKind: liability.coverageKind || null,
      currentBalanceCents: liability.currentBalanceCents,
      obligationCents: liability.obligationCents,
      paymentDueDate: liability.paymentDueDate || null,
      cycleKey: liability.cycleKey || null,
    },
  });

  if ((liability.quarantineReasons || []).length) return;
  if (!liability.eligible || !Number.isSafeInteger(liability.obligationCents) || liability.obligationCents <= 0) return;

  const fundingAccountId = liability.fundingAccountId || input.fundingAccountsByLiability[liability.accountId];
  if (!fundingAccountId || !input.operatingAccountIds.has(fundingAccountId)) {
    node.incompleteReasons = mergeReasons([node.incompleteReasons, [
      OBLIGATION_REASON.liabilityUnresolved,
      OBLIGATION_REASON.fundingAccountMissing,
    ]]);
    return;
  }
  const dueDate = liability.paymentDueDate;
  if (!dueDate) {
    node.incompleteReasons = mergeReasons([node.incompleteReasons, [OBLIGATION_REASON.liabilityUnresolved]]);
    return;
  }
  if (dueDate < input.windowStart || dueDate > input.windowEnd) return;

  const cycleKey = liability.cycleKey || `liability-cycle:${liability.accountId}:${dueDate}`;
  state.pendingCycles.push({
    cycleKey,
    nodeId: node.id,
    durableIdentity,
    accountId: liability.accountId,
    coverageKind: liability.coverageKind,
    obligationCents: liability.obligationCents,
    currentBalanceCents: liability.currentBalanceCents,
    paymentDueDate: dueDate,
    paymentRecurringKey: liability.paymentRecurringKey || null,
    observedAt: liability.observedAt || null,
    fundingAccountId,
  });
}

function ingestTransfer(registry, state, transfer, input) {
  const durableIdentity = transfer.durableIdentity || `transfer:${transfer.linkId}`;
  const node = registerNode(registry, {
    id: stableNodeId(durableIdentity),
    durableIdentity,
    kind: NODE_KIND.TRANSFER,
    label: transfer.label || transfer.linkId,
    source: { kind: SOURCE_KIND.TRANSFER, linkId: transfer.linkId, provenance: transfer.provenance || 'actual' },
    incompleteReasons: [],
    metadata: { fromAccountId: transfer.fromAccountId, toAccountId: transfer.toAccountId },
  });
  if (transfer.ambiguous) {
    node.incompleteReasons = mergeReasons([node.incompleteReasons, [OBLIGATION_REASON.transferAmbiguous]]);
    return;
  }
  if (!transfer.date || transfer.date < input.windowStart || transfer.date > input.windowEnd) return;
  const amountCents = requireSafeCents(transfer.amountCents, 'transfer.amountCents');
  registerOccurrence(state, {
    id: stableOccurrenceId(durableIdentity, transfer.date, OCCURRENCE_ROLE.INTERNAL_TRANSFER),
    nodeId: node.id,
    durableIdentity,
    date: transfer.date,
    amountCents,
    role: OCCURRENCE_ROLE.INTERNAL_TRANSFER,
    reserved: false,
    paid: false,
    fromAccountId: transfer.fromAccountId || null,
    sourceFingerprint: transfer.sourceFingerprint || null,
    transactionId: transfer.transactionId || null,
    transferredId: transfer.transferredId || null,
    source: { kind: SOURCE_KIND.TRANSFER, linkId: transfer.linkId, provenance: transfer.provenance || 'actual' },
    explanation: [
      'Internal cash movement; excluded from economic spend double-count',
      ...(transfer.fundsLiabilityAccountId ? [`Funds liability account ${transfer.fundsLiabilityAccountId}`] : []),
    ],
    dedupeGroup: `transfer:${transfer.linkId}`,
    fundingLinks: transfer.fundsLiabilityAccountId
      ? [{ kind: 'liability_funding', accountId: transfer.fundsLiabilityAccountId, amountCents: Math.abs(amountCents) }]
      : [],
  });
}

function ingestBudgetReservation(registry, state, budget, input) {
  if (state.blockBudgetReservations) return;
  const durableIdentity = budget.durableIdentity || `budget:${budget.categoryId}`;
  const node = registerNode(registry, {
    id: stableNodeId(durableIdentity),
    durableIdentity,
    kind: NODE_KIND.BUDGET_RESERVATION,
    label: budget.categoryName || budget.categoryId,
    source: { kind: SOURCE_KIND.BUDGET, categoryId: budget.categoryId, provenance: 'actual' },
    incompleteReasons: budget.incompleteReasons || [],
  });
  if (!Number.isSafeInteger(budget.remainingCents) || budget.remainingCents <= 0) return;
  if (input.billCategoryIds.has(budget.categoryId)) {
    node.incompleteReasons = mergeReasons([node.incompleteReasons, [OBLIGATION_REASON.identityOverlapAmbiguous]]);
    return;
  }
  registerOccurrence(state, {
    id: stableOccurrenceId(durableIdentity, input.financeDate, OCCURRENCE_ROLE.CASH_OUTFLOW),
    nodeId: node.id,
    durableIdentity,
    date: input.financeDate,
    amountCents: -budget.remainingCents,
    role: OCCURRENCE_ROLE.CASH_OUTFLOW,
    reserved: true,
    paid: false,
    source: { kind: SOURCE_KIND.BUDGET, categoryId: budget.categoryId, provenance: 'actual' },
    explanation: [`Remaining budget for ${budget.categoryName || budget.categoryId}`],
    dedupeGroup: `budget:${budget.categoryId}`,
  });
}

function ingestReimbursement(registry, state, reimb, input) {
  const durableIdentity = reimb.durableIdentity || `reimbursement:expected:${reimb.id}`;
  const node = registerNode(registry, {
    id: stableNodeId(durableIdentity),
    durableIdentity,
    kind: NODE_KIND.REIMBURSEMENT_EXPECTED,
    label: reimb.label || reimb.id,
    source: { kind: SOURCE_KIND.REIMBURSEMENT, id: reimb.id, provenance: reimb.provenance || 'splitwise' },
    incompleteReasons: [],
  });
  if (reimb.allocationIncomplete) {
    node.incompleteReasons = mergeReasons([node.incompleteReasons, [OBLIGATION_REASON.reimbursementAllocationIncomplete]]);
    return;
  }
  if (reimb.ambiguous) {
    node.incompleteReasons = mergeReasons([node.incompleteReasons, [OBLIGATION_REASON.reimbursementAllocationIncomplete]]);
    return;
  }
  if (!reimb.expectedDate || reimb.expectedDate < input.windowStart || reimb.expectedDate > input.windowEnd) return;
  registerOccurrence(state, {
    id: stableOccurrenceId(durableIdentity, reimb.expectedDate, OCCURRENCE_ROLE.CASH_INFLOW),
    nodeId: node.id,
    durableIdentity,
    date: reimb.expectedDate,
    amountCents: requireSafeCents(Math.abs(reimb.expectedCents || 0), 'reimb.expectedCents'),
    role: OCCURRENCE_ROLE.CASH_INFLOW,
    reserved: false,
    paid: false,
    source: { kind: SOURCE_KIND.REIMBURSEMENT, id: reimb.id, provenance: reimb.provenance || 'splitwise' },
    explanation: ['Possible reimbursement; not reserved against Safe-to-Spend'],
    dedupeGroup: `reimbursement:${reimb.id}`,
  });
}

function ingestEconomicTransaction(registry, state, txn, input) {
  const durableIdentity = txn.durableIdentity || `txn:${txn.transactionId}`;
  const node = registerNode(registry, {
    id: stableNodeId(durableIdentity),
    durableIdentity,
    kind: txn.kind || NODE_KIND.RECURRING_SUBSCRIPTION,
    label: txn.label || txn.transactionId,
    source: { kind: SOURCE_KIND.TRANSACTION, transactionId: txn.transactionId, provenance: 'actual' },
    incompleteReasons: [],
  });
  if (!txn.date || txn.date < input.windowStart || txn.date > input.windowEnd) return;
  const amountCents = requireSafeCents(txn.amountCents, 'txn.amountCents');
  const role = amountCents < 0 ? OCCURRENCE_ROLE.ECONOMIC_EXPENSE : OCCURRENCE_ROLE.ECONOMIC_INCOME;
  registerOccurrence(state, {
    id: stableOccurrenceId(durableIdentity, txn.date, role),
    nodeId: node.id,
    durableIdentity,
    date: txn.date,
    amountCents,
    role,
    reserved: false,
    paid: true,
    auditOnly: true,
    source: { kind: SOURCE_KIND.TRANSACTION, transactionId: txn.transactionId, provenance: 'actual' },
    explanation: txn.explanation || ['Historical economic activity; not a cash reservation'],
    dedupeGroup: `txn:${txn.transactionId}`,
  });
}

function reconcileBillBudgetOverlap(registry, state, input) {
  const overlap = state.occurrences.some((occ) =>
    occ.reserved
    && occ.source?.kind === SOURCE_KIND.BUDGET
    && input.billCategoryIds.has(occ.source.categoryId));
  if (overlap) {
    state.incompleteReasons = mergeReasons([state.incompleteReasons, [OBLIGATION_REASON.identityOverlapAmbiguous]]);
  }
}

function liabilityTransferEvidenceFingerprint(transfer, liabilityAccountId) {
  const fromAccountId = transfer.fromAccountId || '';
  const amount = absCents(transfer.amountCents);
  const sourceKey = transfer.sourceFingerprint
    || transfer.durableIdentity
    || `${transfer.transferredId || ''}|${transfer.transactionId || ''}|${fromAccountId}|${amount}`;
  return `${liabilityAccountId}|${fromAccountId}|${transfer.date}|${amount}|${sourceKey}`;
}

function detectTransferEvidenceCollisions(transfers, liabilityAccountId) {
  const byFingerprint = new Map();
  for (const transfer of transfers || []) {
    const linkId = transfer.source?.linkId || transfer.linkId;
    if (!linkId) continue;
    const fingerprint = liabilityTransferEvidenceFingerprint(transfer, liabilityAccountId);
    const bucket = byFingerprint.get(fingerprint) || new Set();
    bucket.add(linkId);
    byFingerprint.set(fingerprint, bucket);
  }
  for (const linkIds of byFingerprint.values()) {
    if (linkIds.size > 1) return true;
  }
  return false;
}

function collectLiabilityFundingTransfers(state, input, accountId) {
  const byLinkId = new Map();
  for (const transfer of state.occurrences) {
    if (transfer.role !== OCCURRENCE_ROLE.INTERNAL_TRANSFER || transfer.reserved) continue;
    const link = (transfer.fundingLinks || []).find((item) => item.accountId === accountId);
    if (!link) continue;
    const linkId = transfer.source?.linkId;
    if (!linkId) continue;
    byLinkId.set(linkId, {
      linkId,
      date: transfer.date,
      amountCents: absCents(link.amountCents || transfer.amountCents),
      fromAccountId: transfer.fromAccountId || null,
      source: transfer.source,
      fundingLinks: transfer.fundingLinks,
      durableIdentity: transfer.durableIdentity,
      sourceFingerprint: transfer.sourceFingerprint || null,
      transactionId: transfer.transactionId || null,
      transferredId: transfer.transferredId || null,
    });
  }
  for (const transfer of input.transfers || []) {
    if (transfer.ambiguous || transfer.fundsLiabilityAccountId !== accountId) continue;
    if (!transfer.date || !transfer.linkId || byLinkId.has(transfer.linkId)) continue;
    const amountCents = absCents(transfer.amountCents);
    byLinkId.set(transfer.linkId, {
      linkId: transfer.linkId,
      date: transfer.date,
      amountCents,
      fromAccountId: transfer.fromAccountId || null,
      source: { linkId: transfer.linkId },
      fundingLinks: [{ kind: 'liability_funding', accountId, amountCents }],
      durableIdentity: transfer.durableIdentity || null,
      sourceFingerprint: transfer.sourceFingerprint || null,
      transactionId: transfer.transactionId || null,
      transferredId: transfer.transferredId || null,
    });
  }
  return [...byLinkId.values()];
}

function reconcileLiabilityFundingLedger(registry, state, input) {
  const financeDate = input.financeDate;
  const billOccs = state.occurrences.filter((occ) => occ.source?.kind === SOURCE_KIND.BILL);

  for (const cycle of state.pendingCycles || []) {
    const node = registry.nodes.find((item) => item.id === cycle.nodeId);
    const matchingBills = billOccs.filter((occ) =>
      occ.components?.liabilityCycleKey === cycle.cycleKey
      || (cycle.paymentRecurringKey
        && occ.source?.key === cycle.paymentRecurringKey
        && !occ.paid));
    const billDueMismatch = matchingBills.some((occ) => occ.date !== cycle.paymentDueDate);
    const duplicateBillLinks = matchingBills.filter((occ) =>
      occ.components?.liabilityCycleKey === cycle.cycleKey).length > 1;

    const linkedTransfers = collectLiabilityFundingTransfers(state, input, cycle.accountId);
    const futureTransfers = linkedTransfers.filter((transfer) =>
      transfer.date > financeDate && transfer.date <= cycle.paymentDueDate);
    const allLinkIds = linkedTransfers.map((transfer) => transfer.linkId || transfer.source?.linkId).filter(Boolean);
    const duplicateTransferLinks = allLinkIds.length > 0
      && allLinkIds.length !== new Set(allLinkIds).size;
    const duplicateEvidenceCollision = detectTransferEvidenceCollisions(linkedTransfers, cycle.accountId);

    let postedPaymentCents = 0;
    let futureTransferCents = 0;
    const futureTransferDates = [];
    let futureTransferDate = cycle.paymentDueDate;
    for (const transfer of linkedTransfers) {
      const link = (transfer.fundingLinks || []).find((item) => item.accountId === cycle.accountId);
      const amount = absCents(link?.amountCents || transfer.amountCents);
      if (cycle.coverageKind === 'statement') {
        const observedDate = observedDateOnly(cycle.observedAt);
        if (observedDate && transfer.date > observedDate && transfer.date <= financeDate) {
          postedPaymentCents = sumCents([postedPaymentCents, amount]);
        } else if (transfer.date > financeDate && transfer.date <= cycle.paymentDueDate) {
          futureTransferCents = sumCents([futureTransferCents, amount]);
          futureTransferDates.push(transfer.date);
          futureTransferDate = transfer.date;
        }
      } else if (transfer.date > financeDate && transfer.date <= cycle.paymentDueDate) {
        futureTransferCents = sumCents([futureTransferCents, amount]);
        futureTransferDates.push(transfer.date);
        futureTransferDate = transfer.date;
      }
    }

    const billCents = matchingBills
      .filter((occ) => occ.date === cycle.paymentDueDate || occ.components?.liabilityCycleKey === cycle.cycleKey)
      .reduce((sum, occ) => sumCents([sum, absCents(occ.amountCents)]), 0);

    const adjustedObligationCents = computeAdjustedObligation({
      coverageKind: cycle.coverageKind,
      obligationCents: cycle.obligationCents,
      currentBalanceCents: cycle.currentBalanceCents,
      postedPaymentCents,
    });

    const evidenceIssues = [];
    if (billDueMismatch) evidenceIssues.push('due_date_mismatch');
    if (linkedTransfers.some((transfer) => transfer.date > cycle.paymentDueDate)) {
      evidenceIssues.push('future_transfer_after_due');
    }
    if (cycle.coverageKind === 'statement' && postedPaymentCents > absCents(cycle.obligationCents)) {
      evidenceIssues.push('overpayment');
    }

    const validation = validateCycleEvidence({
      adjustedObligationCents,
      billCents,
      futureTransferCents,
      billDueDate: billDueMismatch ? matchingBills[0]?.date : cycle.paymentDueDate,
      liabilityDueDate: cycle.paymentDueDate,
      futureTransferDates,
      duplicateTransferLinks,
      duplicateBillLinks,
      duplicateEvidenceCollision,
    });
    const quarantined = evidenceIssues.length > 0 || !validation.ok;
    const partition = validation.partition;

    const cycleRecord = {
      cycleKey: cycle.cycleKey,
      accountId: cycle.accountId,
      coverageKind: cycle.coverageKind,
      obligationCents: cycle.obligationCents,
      adjustedObligationCents,
      postedPaymentCents,
      billCents,
      futureTransferCents,
      quarantined,
      issues: [...evidenceIssues, ...validation.issues],
      reserved: quarantined ? null : {
        futureComponentCents: partition.futureComponentCents,
        billRemainderComponentCents: partition.billRemainderComponentCents,
        residualComponentCents: partition.residualComponentCents,
      },
    };
    state.cyclePartitions.push(cycleRecord);

    if (quarantined) {
      state.incompleteReasons = mergeReasons([state.incompleteReasons, [OBLIGATION_REASON.liabilityFundingMismatch]]);
      if (node) {
        node.incompleteReasons = mergeReasons([node.incompleteReasons, [OBLIGATION_REASON.liabilityFundingMismatch]]);
      }
      continue;
    }

    if (adjustedObligationCents <= 0) continue;

    const baseSource = {
      kind: SOURCE_KIND.CREDIT_LIABILITY,
      accountId: cycle.accountId,
      provenance: cycle.coverageKind || 'policy',
      paymentRecurringKey: cycle.paymentRecurringKey,
    };
    const fundingLink = [{ kind: 'funding_account', accountId: cycle.fundingAccountId }];

    if (partition.futureComponentCents > 0) {
      registerOccurrence(state, {
        id: stableOccurrenceId(`${cycle.cycleKey}:${PARTITION_KIND.FUTURE_TRANSFER}`, futureTransferDate, OCCURRENCE_ROLE.CASH_OUTFLOW),
        nodeId: cycle.nodeId,
        durableIdentity: cycle.durableIdentity,
        date: futureTransferDate,
        amountCents: -partition.futureComponentCents,
        role: OCCURRENCE_ROLE.CASH_OUTFLOW,
        reserved: true,
        paid: false,
        partition: PARTITION_KIND.FUTURE_TRANSFER,
        cycleKey: cycle.cycleKey,
        source: baseSource,
        explanation: [
          `Reserved operating cash for scheduled liability funding transfer (${partition.futureComponentCents}c)`,
          'Internal transfer — non-spending movement but cash outflow from operating account',
        ],
        dedupeGroup: `${cycle.cycleKey}:${PARTITION_KIND.FUTURE_TRANSFER}`,
        components: { partitionKind: PARTITION_KIND.FUTURE_TRANSFER, amountCents: partition.futureComponentCents },
        fundingLinks: fundingLink,
      });
    }

    if (partition.billRemainderComponentCents > 0) {
      registerOccurrence(state, {
        id: stableOccurrenceId(`${cycle.cycleKey}:${PARTITION_KIND.BILL_REMAINDER}`, cycle.paymentDueDate, OCCURRENCE_ROLE.CASH_OUTFLOW),
        nodeId: cycle.nodeId,
        durableIdentity: cycle.durableIdentity,
        date: cycle.paymentDueDate,
        amountCents: -partition.billRemainderComponentCents,
        role: OCCURRENCE_ROLE.CASH_OUTFLOW,
        reserved: true,
        paid: false,
        partition: PARTITION_KIND.BILL_REMAINDER,
        cycleKey: cycle.cycleKey,
        source: baseSource,
        explanation: [
          `Bill schedule remainder after future transfer overlap (${partition.billRemainderComponentCents}c)`,
        ],
        dedupeGroup: `${cycle.cycleKey}:${PARTITION_KIND.BILL_REMAINDER}`,
        components: { partitionKind: PARTITION_KIND.BILL_REMAINDER, amountCents: partition.billRemainderComponentCents },
        fundingLinks: fundingLink,
      });
    }

    if (partition.residualComponentCents > 0) {
      registerOccurrence(state, {
        id: stableOccurrenceId(`${cycle.cycleKey}:${PARTITION_KIND.RESIDUAL_LIABILITY}`, cycle.paymentDueDate, OCCURRENCE_ROLE.CASH_OUTFLOW),
        nodeId: cycle.nodeId,
        durableIdentity: cycle.durableIdentity,
        date: cycle.paymentDueDate,
        amountCents: -partition.residualComponentCents,
        role: OCCURRENCE_ROLE.CASH_OUTFLOW,
        reserved: true,
        paid: false,
        partition: PARTITION_KIND.RESIDUAL_LIABILITY,
        cycleKey: cycle.cycleKey,
        source: baseSource,
        explanation: [
          cycle.coverageKind === 'statement'
            ? `Statement liability residual after schedule evidence (${partition.residualComponentCents}c)`
            : `Current balance liability residual after schedule evidence (${partition.residualComponentCents}c)`,
        ],
        dedupeGroup: `${cycle.cycleKey}:${PARTITION_KIND.RESIDUAL_LIABILITY}`,
        components: { partitionKind: PARTITION_KIND.RESIDUAL_LIABILITY, amountCents: partition.residualComponentCents },
        fundingLinks: fundingLink,
      });
    }
  }

  const invariantCheck = verifyCyclePartitionInvariants(state.cyclePartitions);
  if (!invariantCheck.ok) {
    state.incompleteReasons = mergeReasons([state.incompleteReasons, [OBLIGATION_REASON.liabilityFundingMismatch]]);
  }
}

function dedupeOverlappingSources(registry, state) {
  const reservedByGroup = new Map();
  for (const occ of state.occurrences) {
    if (!occ.reserved || !occ.dedupeGroup) continue;
    const bucket = reservedByGroup.get(occ.dedupeGroup) || [];
    bucket.push(occ);
    reservedByGroup.set(occ.dedupeGroup, bucket);
  }
  for (const [group, occs] of reservedByGroup) {
    if (occs.length <= 1) continue;
    occs.sort((a, b) => a.date.localeCompare(b.date) || a.id.localeCompare(b.id));
    const keeper = occs[0];
    for (let i = 1; i < occs.length; i++) {
      const dup = occs[i];
      dup.reserved = false;
      dup.suppressedBy = keeper.id;
      dup.explanation = [...(dup.explanation || []), `Suppressed duplicate reservation for ${group}`];
    }
  }
}

function reservedCashOccurrences(graph, { windowStart, windowEnd } = {}) {
  return (graph.occurrences || []).filter((occ) => {
    if (!occ.reserved) return false;
    if (occ.role !== OCCURRENCE_ROLE.CASH_OUTFLOW) return false;
    if (windowStart && occ.date < windowStart) return false;
    if (windowEnd && occ.date > windowEnd) return false;
    return true;
  });
}

function reservedOutflowCents(graph, window) {
  const occs = reservedCashOccurrences(graph, window);
  return {
    totalCents: sumCents(occs.map((occ) => -occ.amountCents)),
    occurrences: occs,
  };
}

function forecastCashEventsFromGraph(graph, { windowStart, windowEnd }) {
  const completeness = graphCompleteness(graph);
  if (!completeness.complete) return [];
  const events = [];
  for (const occ of graph.occurrences || []) {
    if (occ.auditOnly) continue;
    if (occ.date < windowStart || occ.date > windowEnd) continue;
    if (occ.role === OCCURRENCE_ROLE.INTERNAL_TRANSFER) continue;
    if (occ.role === OCCURRENCE_ROLE.ECONOMIC_EXPENSE || occ.role === OCCURRENCE_ROLE.ECONOMIC_INCOME) continue;
    if (occ.role === OCCURRENCE_ROLE.LIABILITY_ACCRUAL) continue;
    if (!occ.reserved && occ.role === OCCURRENCE_ROLE.CASH_OUTFLOW) continue;
    if (occ.role === OCCURRENCE_ROLE.CASH_INFLOW && !occ.reserved) {
      events.push({
        date: occ.date,
        amountCents: occ.amountCents,
        label: explainOccurrence(graph, occ.id).label,
        kind: 'income',
        sourceId: occ.id,
        provenance: occ.source?.provenance || 'inferred',
        reserved: false,
      });
      continue;
    }
    if (occ.role === OCCURRENCE_ROLE.CASH_OUTFLOW) {
      if (occ.source?.kind === SOURCE_KIND.BUDGET) continue;
      events.push({
        date: occ.date,
        amountCents: occ.amountCents,
        label: explainOccurrence(graph, occ.id).label,
        kind: occ.source?.kind === SOURCE_KIND.BUDGET ? 'budget' : 'bill',
        sourceId: occ.id,
        provenance: occ.source?.provenance || 'inferred',
        reserved: !!occ.reserved,
      });
    }
  }
  return sortByKeys(events, ['date', 'sourceId']);
}

function billsFromGraph(graph, { windowStart, windowEnd } = {}) {
  const bills = [];
  for (const occ of graph.occurrences || []) {
    if (occ.role !== OCCURRENCE_ROLE.CASH_OUTFLOW) continue;
    if (occ.source?.kind !== SOURCE_KIND.BILL && occ.source?.kind !== SOURCE_KIND.RECURRING) continue;
    if (windowStart && occ.date < windowStart) continue;
    if (windowEnd && occ.date > windowEnd) continue;
    if (occ.source?.kind === SOURCE_KIND.RECURRING && !occ.dedupeGroup?.startsWith('bill-series:')) continue;
    bills.push({
      id: occ.source?.id || occ.id,
      key: occ.source?.key || occ.durableIdentity,
      payee: explainOccurrence(graph, occ.id).label,
      amountCents: -occ.amountCents,
      dueDate: occ.date,
      paid: !!occ.paid,
      reserved: !!occ.reserved,
      source: occ.source,
      explanation: occ.explanation,
    });
  }
  return sortByKeys(bills, ['dueDate', 'id']);
}

function safeToSpendFromGraph(graph, { operatingCashCents, monthStart, monthEnd }) {
  const completeness = graphCompleteness(graph);
  const { totalCents: reservedCents, occurrences } = reservedOutflowCents(graph, {
    windowStart: monthStart,
    windowEnd: monthEnd,
  });
  const reservations = occurrences.map((occ) => explainOccurrence(graph, occ.id));
  if (!completeness.complete) {
    return {
      valueCents: null,
      complete: false,
      incompleteReasons: completeness.incompleteReasons,
      reservedCents,
      reservations,
      method: 'obligation graph quarantined — reservations withheld',
    };
  }
  const valueCents = sumCents([operatingCashCents, -reservedCents]);
  return {
    valueCents,
    complete: true,
    incompleteReasons: [],
    reservedCents,
    reservations,
    method: 'operating cash minus obligation-graph cash reservations due this month',
  };
}

function explainOccurrence(graph, occurrenceId) {
  const occ = (graph.occurrences || []).find((item) => item.id === occurrenceId);
  if (!occ) return { id: occurrenceId, label: 'Unknown occurrence', complete: false, reasons: ['missing_occurrence'] };
  const node = (graph.nodes || []).find((item) => item.id === occ.nodeId);
  return {
    id: occ.id,
    nodeId: occ.nodeId,
    label: node?.label || occ.durableIdentity,
    date: occ.date,
    amountCents: occ.amountCents,
    role: occ.role,
    reserved: !!occ.reserved,
    paid: !!occ.paid,
    source: occ.source,
    explanation: occ.explanation || [],
    incompleteReasons: node?.incompleteReasons || [],
    suppressedBy: occ.suppressedBy || null,
  };
}

function verifyGraphInvariants(graph) {
  const issues = [];
  const reservedGroups = new Map();
  for (const occ of graph.occurrences || []) {
    if (!Number.isSafeInteger(occ.amountCents)) issues.push(`occurrence ${occ.id} has non-integer cents`);
    if (occ.reserved && occ.dedupeGroup) {
      const key = `${occ.dedupeGroup}|${occ.date}`;
      const prior = reservedGroups.get(key);
      if (prior && prior !== occ.id && !occ.suppressedBy) {
        issues.push(`double reservation ${key}`);
      }
      if (!occ.suppressedBy) reservedGroups.set(key, occ.id);
    }
  }
  const nodeIds = new Set((graph.nodes || []).map((node) => node.id));
  for (const occ of graph.occurrences || []) {
    if (!nodeIds.has(occ.nodeId)) issues.push(`orphan occurrence ${occ.id}`);
  }
  if ((graph.occurrences || []).length > MAX_OCCURRENCES) {
    issues.push('occurrence cap exceeded');
  }
  const cycleCheck = verifyCyclePartitionInvariants(graph.cyclePartitions || []);
  if (!cycleCheck.ok) issues.push(...cycleCheck.issues);
  return { ok: issues.length === 0, issues };
}

function graphSummary(graph) {
  const completeness = graphCompleteness(graph);
  const reserved = reservedOutflowCents(graph, graph.window || {});
  return {
    version: graph.version,
    nodeCount: (graph.nodes || []).length,
    edgeCount: (graph.edges || []).length,
    occurrenceCount: (graph.occurrences || []).length,
    reservedOutflowCents: reserved.totalCents,
    completeness,
  };
}

module.exports = {
  OBLIGATION_GRAPH_VERSION,
  MAX_OCCURRENCES,
  OBLIGATION_REASON,
  OBLIGATION_REASON_ORDER,
  NODE_KIND,
  SOURCE_KIND,
  EDGE_KIND,
  OCCURRENCE_ROLE,
  PARTITION_KIND,
  buildObligationGraph,
  graphCompleteness,
  graphSummary,
  reservedCashOccurrences,
  reservedOutflowCents,
  forecastCashEventsFromGraph,
  billsFromGraph,
  safeToSpendFromGraph,
  explainOccurrence,
  verifyGraphInvariants,
  stableNodeId,
  stableOccurrenceId,
};
