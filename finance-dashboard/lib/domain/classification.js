'use strict';

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

function transactionLeaves(transaction, parentTransfer = false) {
  if (transaction.is_parent && Array.isArray(transaction.subtransactions) && transaction.subtransactions.length) {
    return transaction.subtransactions.map((leg, index) => ({
      amount: leg.amount,
      catId: leg.category,
      notes: leg.notes,
      transfer: !!leg.transfer_id,
      id: leg.id || `${transaction.id}-${index}`,
      parentId: transaction.id,
      isLeg: true,
    }));
  }
  if (transaction.is_parent) return [];
  return [{
    amount: transaction.amount,
    catId: transaction.category,
    notes: transaction.notes,
    transfer: parentTransfer,
    id: transaction.id,
    parentId: null,
    isLeg: false,
  }];
}

function summarizeCents(leaves, categoryInfo) {
  const spendingCents = {};
  let totalSpendCents = 0;
  let totalIncomeCents = 0;
  for (const leaf of leaves || []) {
    if (!Number.isSafeInteger(leaf.amount)) throw new TypeError('Actual transaction amounts must be integer cents');
    const meta = categoryInfo[leaf.catId];
    const kind = meta ? meta.kind : 'uncat';
    if (kind === 'mm' || kind === 'reimb') continue;
    if (kind === 'income') {
      totalIncomeCents += leaf.amount;
      continue;
    }
    if (kind === 'uncat' && leaf.amount > 0) continue;
    const name = meta ? meta.name : 'Uncategorized';
    totalSpendCents -= leaf.amount;
    spendingCents[name] = (spendingCents[name] || 0) - leaf.amount;
  }
  for (const key of Object.keys(spendingCents)) if (spendingCents[key] === 0) delete spendingCents[key];
  return { spendingCents, totalSpendCents, totalIncomeCents };
}

module.exports = { buildCategoryInfo, transactionLeaves, summarizeCents };
