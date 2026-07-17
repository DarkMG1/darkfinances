'use strict';

const {
  buildCategoryInfo,
  buildTransferIndex,
  classifyTransactionLeaves,
  leafCountsAsRealSpend,
  PROVENANCE,
  TRANSFER_REASON,
} = require('../vendor/classification');

const DEFAULT_PATTERNS = {
  incomeGroup: /^income$/i,
  moneyMovementGroup: /money\s*movement/i,
  moneyMovementCategory: /^(transfers?|investments?|credit\s*card\s*payments?|cc\s*payments?)$/i,
  reimbursementCategory: /^reimbursement$/i,
};

function buildToolCategoryInfo(groups) {
  return buildCategoryInfo(groups, DEFAULT_PATTERNS);
}

function classifiedLeavesForRows(rows, catInfo, payeeNameFor, { transferIndex: providedIndex } = {}) {
  const transferIndex = providedIndex ?? buildTransferIndex(rows);
  return rows.flatMap((row) => {
    const payeeName = payeeNameFor ? payeeNameFor(row.transaction) : '';
    return classifyTransactionLeaves(row.transaction, catInfo, {
      accountId: row.accountId,
      transferIndex,
    }).map((leaf) => ({
      ...leaf,
      accountId: row.accountId,
      onbudget: row.accountIncluded !== false,
      date: row.transaction.date,
      payee: payeeName,
      transferReason: leaf.reason,
    }));
  });
}

function classifiedLeavesForAccountTransactions(transactions, catInfo, account, payeeNameFor, { transferIndex } = {}) {
  const rows = transactions.map((transaction) => ({
    transaction,
    accountId: account.id,
    accountIncluded: !account.offbudget,
    accountClosed: !!account.closed,
  }));
  return classifiedLeavesForRows(rows, catInfo, payeeNameFor, { transferIndex });
}

function classifiedLeavesForAccounts(accounts, transactionsByAccountId, catInfo, payeeNameFor) {
  const rows = [];
  for (const account of accounts) {
    const txns = transactionsByAccountId.get(account.id) || [];
    for (const transaction of txns) {
      rows.push({
        transaction,
        accountId: account.id,
        accountIncluded: !account.offbudget,
        accountClosed: !!account.closed,
      });
    }
  }
  return classifiedLeavesForRows(rows, catInfo, payeeNameFor);
}

function isRealSpendLeaf(leaf) {
  return leaf.onbudget !== false && leafCountsAsRealSpend(leaf);
}

function incompleteTransferLeaves(leaves) {
  return leaves.filter((leaf) => leaf.kind === 'incomplete' && leaf.provenance === PROVENANCE.TRANSFER_IDENTITY);
}

module.exports = {
  buildToolCategoryInfo,
  buildTransferIndex,
  classifiedLeavesForAccountTransactions,
  classifiedLeavesForAccounts,
  classifiedLeavesForRows,
  classifyTransactionLeaves,
  incompleteTransferLeaves,
  isRealSpendLeaf,
  leafCountsAsRealSpend,
  PROVENANCE,
  TRANSFER_REASON,
};
