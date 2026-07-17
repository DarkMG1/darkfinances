'use strict';

const {
  buildCategoryInfo,
  buildTransferIndex,
  classifyTransactionLeaves,
  leafCountsAsRealSpend,
} = require('../../finance-dashboard/lib/domain/classification');

const DEFAULT_PATTERNS = {
  incomeGroup: /^income$/i,
  moneyMovementGroup: /money\s*movement/i,
  moneyMovementCategory: /^(transfers?|investments?|credit\s*card\s*payments?|cc\s*payments?)$/i,
  reimbursementCategory: /^reimbursement$/i,
};

function buildToolCategoryInfo(groups) {
  return buildCategoryInfo(groups, DEFAULT_PATTERNS);
}

function classifiedLeavesForAccountTransactions(transactions, catInfo, account, payeeNameFor) {
  const rows = transactions.map((transaction) => ({
    transaction,
    accountId: account.id,
    accountIncluded: !account.offbudget,
    accountClosed: !!account.closed,
  }));
  const transferIndex = buildTransferIndex(rows);
  return rows.flatMap((row) => {
    const payeeName = payeeNameFor ? payeeNameFor(row.transaction) : '';
    return classifyTransactionLeaves(row.transaction, catInfo, {
      accountId: row.accountId,
      transferIndex,
    }).map((leaf) => ({
      ...leaf,
      accountId: row.accountId,
      onbudget: !account.offbudget,
      date: row.transaction.date,
      payee: payeeName,
    }));
  });
}

function isRealSpendLeaf(leaf) {
  return leaf.onbudget !== false && leafCountsAsRealSpend(leaf);
}

module.exports = {
  buildToolCategoryInfo,
  buildTransferIndex,
  classifiedLeavesForAccountTransactions,
  classifyTransactionLeaves,
  isRealSpendLeaf,
  leafCountsAsRealSpend,
};
