'use strict';

function sameTransactionId(left, right) {
  return String(left) === String(right);
}

function enrichSplitLeg(parent, leg) {
  return {
    ...leg,
    parent_id: leg.parent_id != null ? leg.parent_id : parent.id,
    date: leg.date || parent.date,
    account: leg.account || parent.account,
    accountId: leg.accountId || parent.accountId || parent.account,
    accountName: leg.accountName || parent.accountName,
  };
}

function locateExactTransactionId(rows, id) {
  const target = String(id);
  if (!Array.isArray(rows) || !target) return null;
  for (const row of rows) {
    if (sameTransactionId(row?.id, target)) {
      return {
        transaction: row,
        parent: null,
        isLeg: false,
      };
    }
    for (const leg of row.subtransactions || []) {
      if (sameTransactionId(leg?.id, target)) {
        return {
          transaction: enrichSplitLeg(row, leg),
          parent: row,
          isLeg: true,
        };
      }
    }
  }
  return null;
}

function locateExactTransactionIdInAccounts(rowsByAccount, id, preferredAccountId = null) {
  if (preferredAccountId) {
    const located = locateExactTransactionId(rowsByAccount[String(preferredAccountId)] || [], id);
    if (located) return { ...located, accountId: String(preferredAccountId) };
  }
  for (const [accountId, rows] of Object.entries(rowsByAccount || {})) {
    const located = locateExactTransactionId(rows, id);
    if (located) return { ...located, accountId: String(accountId) };
  }
  return null;
}

module.exports = {
  enrichSplitLeg,
  locateExactTransactionId,
  locateExactTransactionIdInAccounts,
  sameTransactionId,
};
