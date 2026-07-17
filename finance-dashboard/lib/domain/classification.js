'use strict';

const PROVENANCE = Object.freeze({
  TRANSFER_IDENTITY: 'classification:transfer_identity',
  CATEGORY: 'classification:category',
});

const TRANSFER_REASON = Object.freeze({
  ACTUAL_IDENTITY: 'actual_transfer_identity',
  ACTUAL_ONE_SIDED: 'actual_transfer_one_sided',
  ACTUAL_SPLIT_LEG: 'actual_transfer_split_leg',
  IDENTITY_MALFORMED: 'transfer_identity_malformed',
  IDENTITY_SELF_REFERENCE: 'transfer_identity_self_reference',
  PAIR_NOT_RECIPROCAL: 'transfer_pair_not_reciprocal',
  PAIR_SIGN_MISMATCH: 'transfer_pair_sign_mismatch',
  PAIR_AMOUNT_MISMATCH: 'transfer_pair_amount_mismatch',
  PAIR_DUPLICATE_ID: 'transfer_pair_duplicate_id',
  PAIR_CYCLE_INVALID: 'transfer_pair_cycle_invalid',
  PAIR_FAN_IN: 'transfer_pair_fan_in',
  PAIR_SAME_ACCOUNT: 'transfer_pair_same_account',
});

function buildCategoryInfo(groups, patterns) {
  const catInfo = {};
  for (const group of groups || []) {
    const incomeGroup = group.is_income === true || patterns.incomeGroup.test(group.name || '');
    const movementGroup = patterns.moneyMovementGroup.test(group.name || '');
    for (const category of group.categories || []) {
      let kind = 'spend';
      if (incomeGroup) kind = 'income';
      else if (patterns.reimbursementCategory.test(category.name || '')) kind = 'reimb';
      else if (movementGroup || patterns.moneyMovementCategory.test(category.name || '')) kind = 'mm';
      catInfo[category.id] = {
        name: category.name,
        group: group.name,
        kind,
        isIncome: incomeGroup,
        isMovement: movementGroup,
      };
    }
  }
  return catInfo;
}

function normalizeTransferId(value) {
  if (value == null || value === false) return null;
  const normalized = String(value).trim();
  return normalized || null;
}

function transactionLeaves(transaction) {
  if (transaction.is_parent && Array.isArray(transaction.subtransactions) && transaction.subtransactions.length) {
    return transaction.subtransactions.map((leg, index) => ({
      amount: leg.amount,
      catId: leg.category,
      notes: leg.notes,
      id: leg.id || `${transaction.id}-${index}`,
      parentId: transaction.id,
      isLeg: true,
      transferId: normalizeTransferId(leg.transfer_id),
      transferredId: normalizeTransferId(leg.transferred_id),
    }));
  }
  if (transaction.is_parent) return [];
  return [{
    amount: transaction.amount,
    catId: transaction.category,
    notes: transaction.notes,
    id: transaction.id,
    parentId: null,
    isLeg: false,
    transferId: normalizeTransferId(transaction.transfer_id),
    transferredId: normalizeTransferId(transaction.transferred_id),
  }];
}

function hasTransferIdentityFields(leaf) {
  return !!(leaf.transferId || leaf.transferredId);
}

function buildTransferIndex(rows) {
  const byTransactionId = new Map();
  const duplicateTransactionIds = new Set();
  const nodes = [];

  for (const row of rows || []) {
    const transactionId = String(row.transaction?.id || '');
    if (!transactionId) continue;
    for (const leaf of transactionLeaves(row.transaction)) {
      if (!hasTransferIdentityFields(leaf)) continue;
      const leafId = String(leaf.id || transactionId);
      const node = {
        transactionId: leafId,
        accountId: row.accountId || null,
        amount: leaf.amount,
        transferId: leaf.transferId,
        transferredId: leaf.transferredId,
        parentId: leaf.parentId || null,
      };
      if (byTransactionId.has(leafId)) duplicateTransactionIds.add(leafId);
      byTransactionId.set(leafId, node);
      nodes.push(node);
    }
  }

  const reverseRefs = new Map();
  for (const node of nodes) {
    if (!node.transferId) continue;
    const bucket = reverseRefs.get(String(node.transferId)) || [];
    bucket.push(node.transactionId);
    reverseRefs.set(String(node.transferId), bucket);
  }

  return { byTransactionId, duplicateTransactionIds, reverseRefs, nodes };
}

function gatherTransferComponent(startId, index) {
  const visited = new Set();
  const stack = [String(startId)];
  while (stack.length) {
    const id = stack.pop();
    if (visited.has(id)) continue;
    visited.add(id);
    const node = index.byTransactionId.get(id);
    if (!node) continue;
    if (node.transferId && index.byTransactionId.has(String(node.transferId))) {
      stack.push(String(node.transferId));
    }
    for (const ref of index.reverseRefs.get(id) || []) {
      if (index.byTransactionId.has(String(ref))) stack.push(String(ref));
    }
  }
  return visited;
}

function counterpartNode(selfNode, index) {
  if (!selfNode?.transferId) return null;
  const node = index.byTransactionId.get(String(selfNode.transferId));
  if (!node || node.transactionId !== String(selfNode.transferId)) return null;
  return node;
}

function validateMutualTransferPair(selfNode, counterpart, index) {
  if (index.duplicateTransactionIds.has(selfNode.transactionId) || index.duplicateTransactionIds.has(counterpart.transactionId)) {
    return TRANSFER_REASON.PAIR_DUPLICATE_ID;
  }
  if (selfNode.transactionId === counterpart.transactionId) {
    return TRANSFER_REASON.PAIR_DUPLICATE_ID;
  }
  if (selfNode.accountId && counterpart.accountId && selfNode.accountId === counterpart.accountId) {
    return TRANSFER_REASON.PAIR_SAME_ACCOUNT;
  }
  const component = gatherTransferComponent(selfNode.transactionId, index);
  if (component.size !== 2) {
    return component.size > 2 ? TRANSFER_REASON.PAIR_FAN_IN : TRANSFER_REASON.PAIR_CYCLE_INVALID;
  }
  if (String(counterpart.transferId || '') !== String(selfNode.transactionId)) {
    return TRANSFER_REASON.PAIR_NOT_RECIPROCAL;
  }
  if (!Number.isSafeInteger(selfNode.amount) || !Number.isSafeInteger(counterpart.amount)) {
    return TRANSFER_REASON.IDENTITY_MALFORMED;
  }
  if (selfNode.amount === 0 || counterpart.amount === 0) {
    return TRANSFER_REASON.PAIR_AMOUNT_MISMATCH;
  }
  if (Math.sign(selfNode.amount) === Math.sign(counterpart.amount)) {
    return TRANSFER_REASON.PAIR_SIGN_MISMATCH;
  }
  if (Math.abs(selfNode.amount) !== Math.abs(counterpart.amount)) {
    return TRANSFER_REASON.PAIR_AMOUNT_MISMATCH;
  }
  if (selfNode.amount + counterpart.amount !== 0) {
    return TRANSFER_REASON.PAIR_AMOUNT_MISMATCH;
  }
  return null;
}

function buildTransferIdentitySnapshot(leaf, selfNode, counterpart, index, { counterpartInWindow, pairValid }) {
  return {
    linkId: leaf.transferId || leaf.transferredId,
    counterpartTransactionId: leaf.transferId || null,
    transferredId: leaf.transferredId || null,
    accountId: selfNode?.accountId || null,
    counterpartAccountId: counterpart?.accountId || null,
    counterpartInWindow,
    pairValid: !!pairValid,
    componentSize: selfNode && index ? gatherTransferComponent(selfNode.transactionId, index).size : null,
  };
}

function assessTransferIdentity(leaf, context = {}) {
  const transferId = leaf.transferId;
  const transferredId = leaf.transferredId;
  if (!transferId && !transferredId) return { status: 'none' };

  const selfId = String(context.transactionId || leaf.id || '');
  const { transferIndex } = context;
  const selfNode = transferIndex?.byTransactionId.get(selfId) || {
    transactionId: selfId,
    accountId: context.accountId || null,
    amount: leaf.amount,
    transferId,
    transferredId,
    parentId: leaf.parentId || null,
  };

  if (transferId && selfId && transferId === selfId) {
    return {
      status: 'malformed',
      reason: TRANSFER_REASON.IDENTITY_SELF_REFERENCE,
      identity: buildTransferIdentitySnapshot(leaf, selfNode, null, transferIndex, { counterpartInWindow: false, pairValid: false }),
    };
  }

  if (transferIndex?.duplicateTransactionIds?.has(selfId)) {
    return {
      status: 'malformed',
      reason: TRANSFER_REASON.PAIR_DUPLICATE_ID,
      identity: buildTransferIdentitySnapshot(leaf, selfNode, null, transferIndex, { counterpartInWindow: false, pairValid: false }),
    };
  }

  const counterpart = transferId && transferIndex ? counterpartNode(selfNode, transferIndex) : null;
  const counterpartInWindow = !!counterpart;

  if (counterpartInWindow) {
    const pairError = validateMutualTransferPair(selfNode, counterpart, transferIndex);
    if (pairError) {
      return {
        status: 'malformed',
        reason: pairError,
        identity: buildTransferIdentitySnapshot(leaf, selfNode, counterpart, transferIndex, { counterpartInWindow: true, pairValid: false }),
      };
    }
    return {
      status: 'transfer',
      reason: leaf.isLeg ? TRANSFER_REASON.ACTUAL_SPLIT_LEG : TRANSFER_REASON.ACTUAL_IDENTITY,
      identity: buildTransferIdentitySnapshot(leaf, selfNode, counterpart, transferIndex, { counterpartInWindow: true, pairValid: true }),
    };
  }

  let reason = TRANSFER_REASON.ACTUAL_IDENTITY;
  if (leaf.isLeg) reason = TRANSFER_REASON.ACTUAL_SPLIT_LEG;
  else if (transferId || transferredId) reason = TRANSFER_REASON.ACTUAL_ONE_SIDED;

  return {
    status: 'transfer',
    reason,
    identity: buildTransferIdentitySnapshot(leaf, selfNode, null, transferIndex, { counterpartInWindow: false, pairValid: false }),
  };
}

function incompleteTransferReviewFingerprint(leaf, classified) {
  const id = String(classified.parentId || classified.id || 'unknown');
  const reason = classified.reason || TRANSFER_REASON.IDENTITY_MALFORMED;
  return `transfer_identity:${reason}:${id}`;
}

function classifyLeaf(leaf, categoryInfo, context = {}) {
  if (!Number.isSafeInteger(leaf.amount)) throw new TypeError('Actual transaction amounts must be integer cents');

  const transfer = assessTransferIdentity(leaf, context);
  if (transfer.status === 'malformed') {
    return {
      ...leaf,
      kind: 'incomplete',
      reason: transfer.reason,
      provenance: PROVENANCE.TRANSFER_IDENTITY,
      transferIdentity: transfer.identity,
      countsAsSpending: false,
      countsAsIncome: false,
      spendingExcluded: true,
      needsReview: true,
      reviewFingerprint: incompleteTransferReviewFingerprint(leaf, { ...leaf, reason: transfer.reason }),
    };
  }
  if (transfer.status === 'transfer') {
    return {
      ...leaf,
      kind: 'transfer',
      reason: transfer.reason,
      provenance: PROVENANCE.TRANSFER_IDENTITY,
      transferIdentity: transfer.identity,
      countsAsSpending: false,
      countsAsIncome: false,
      spendingExcluded: true,
      needsReview: false,
    };
  }

  const meta = categoryInfo[leaf.catId];
  const catKind = meta ? meta.kind : 'uncat';
  const provenance = PROVENANCE.CATEGORY;
  if (catKind === 'income') {
    return {
      ...leaf,
      kind: 'income',
      reason: `category:${meta.name}`,
      provenance,
      transferIdentity: null,
      countsAsSpending: false,
      countsAsIncome: true,
      spendingExcluded: true,
      needsReview: false,
    };
  }
  if (catKind === 'reimb' || catKind === 'mm') {
    return {
      ...leaf,
      kind: catKind,
      reason: `category:${meta.name}`,
      provenance,
      transferIdentity: null,
      countsAsSpending: false,
      countsAsIncome: false,
      spendingExcluded: true,
      needsReview: false,
    };
  }
  if (catKind === 'uncat' && leaf.amount > 0) {
    return {
      ...leaf,
      kind: 'uncat',
      reason: 'uncategorized_inflow',
      provenance,
      transferIdentity: null,
      countsAsSpending: false,
      countsAsIncome: false,
      spendingExcluded: true,
      needsReview: true,
    };
  }
  const spendKind = catKind === 'uncat' ? 'uncat' : 'spend';
  return {
    ...leaf,
    kind: spendKind,
    reason: meta ? `category:${meta.name}` : 'uncategorized',
    provenance,
    transferIdentity: null,
    countsAsSpending: true,
    countsAsIncome: false,
    spendingExcluded: false,
    needsReview: spendKind === 'uncat',
  };
}

function classifyTransactionLeaves(transaction, categoryInfo, context = {}) {
  return transactionLeaves(transaction).map((leaf) => classifyLeaf(leaf, categoryInfo, {
    ...context,
    transactionId: leaf.id,
  }));
}

function leafCountsAsRealSpend(classified) {
  return !!classified.countsAsSpending && classified.amount < 0;
}

function leafCountsAsRealIncome(classified) {
  return !!classified.countsAsIncome;
}

function summarizeClassifiedLeaves(classifiedLeaves) {
  const spendingCents = {};
  let totalSpendCents = 0;
  let totalIncomeCents = 0;
  for (const leaf of classifiedLeaves || []) {
    if (leaf.countsAsIncome) {
      totalIncomeCents += leaf.amount;
      continue;
    }
    if (!leaf.countsAsSpending) continue;
    const metaName = leaf.reason?.startsWith('category:') ? leaf.reason.slice('category:'.length) : 'Uncategorized';
    const name = leaf.kind === 'uncat' ? 'Uncategorized' : metaName;
    totalSpendCents -= leaf.amount;
    spendingCents[name] = (spendingCents[name] || 0) - leaf.amount;
  }
  for (const key of Object.keys(spendingCents)) if (spendingCents[key] === 0) delete spendingCents[key];
  return { spendingCents, totalSpendCents, totalIncomeCents };
}

function summarizeCents(leaves, categoryInfo, context = {}) {
  const classified = (leaves || []).map((leaf) => (
    leaf.kind != null && Object.prototype.hasOwnProperty.call(leaf, 'countsAsSpending')
      ? leaf
      : classifyLeaf(leaf, categoryInfo, context)
  ));
  return summarizeClassifiedLeaves(classified);
}

function hasActualTransferIdentity(transaction) {
  if (!transaction) return false;
  if (normalizeTransferId(transaction.transfer_id) || normalizeTransferId(transaction.transferred_id)) return true;
  if (Array.isArray(transaction.subtransactions)) {
    return transaction.subtransactions.some((leg) => normalizeTransferId(leg.transfer_id) || normalizeTransferId(leg.transferred_id));
  }
  return false;
}

function leafHasTransferIdentity(leg) {
  return !!(normalizeTransferId(leg?.transfer_id) || normalizeTransferId(leg?.transferred_id));
}

module.exports = {
  PROVENANCE,
  TRANSFER_REASON,
  buildCategoryInfo,
  buildTransferIndex,
  classifyLeaf,
  classifyTransactionLeaves,
  gatherTransferComponent,
  hasActualTransferIdentity,
  incompleteTransferReviewFingerprint,
  leafHasTransferIdentity,
  leafCountsAsRealIncome,
  leafCountsAsRealSpend,
  normalizeTransferId,
  summarizeClassifiedLeaves,
  summarizeCents,
  transactionLeaves,
  validateMutualTransferPair,
};
