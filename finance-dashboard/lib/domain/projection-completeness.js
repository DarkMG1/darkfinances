'use strict';

const { PROVENANCE } = require('./classification');
const { fromCents } = require('./money');

const PROJECTION_INCOMPLETE_REASON = 'transfer_identity_unresolved';

function projectionCompletenessFromLeaves(classifiedLeaves) {
  const incomplete = (classifiedLeaves || []).filter(
    (leaf) => leaf.kind === 'incomplete' && leaf.provenance === PROVENANCE.TRANSFER_IDENTITY,
  );
  const transferIdentityReasons = [...new Set(incomplete.map((leaf) => leaf.reason).filter(Boolean))].sort();
  const complete = incomplete.length === 0;
  return {
    complete,
    incompleteReasons: complete ? [] : [PROJECTION_INCOMPLETE_REASON, ...transferIdentityReasons],
    transferIdentityUnresolvedCount: incomplete.length,
    transferIdentityReasons,
  };
}

function mergeProjectionCompleteness(parts) {
  const items = (parts || []).filter(Boolean);
  const transferIdentityReasons = [...new Set(items.flatMap((part) => part.transferIdentityReasons || []))].sort();
  const transferIdentityUnresolvedCount = items.reduce(
    (sum, part) => sum + (part.transferIdentityUnresolvedCount || 0),
    0,
  );
  const complete = items.every((part) => part.complete !== false);
  return {
    complete,
    incompleteReasons: complete ? [] : [PROJECTION_INCOMPLETE_REASON, ...transferIdentityReasons],
    transferIdentityUnresolvedCount,
    transferIdentityReasons,
  };
}

function spendSummaryFromClassifiedLeaves(classifiedLeaves) {
  const totals = classifiedLeaves.reduce((acc, leaf) => {
    if (!Number.isSafeInteger(leaf.amount)) return acc;
    if (leaf.countsAsIncome) acc.incomeCents += leaf.amount;
    else if (leaf.countsAsSpending) acc.spendCents -= leaf.amount;
    return acc;
  }, { spendCents: 0, incomeCents: 0 });
  const spendingCents = {};
  for (const leaf of classifiedLeaves || []) {
    if (!leaf.countsAsSpending) continue;
    const metaName = leaf.reason?.startsWith('category:') ? leaf.reason.slice('category:'.length) : 'Uncategorized';
    const name = leaf.kind === 'uncat' ? 'Uncategorized' : metaName;
    spendingCents[name] = (spendingCents[name] || 0) - leaf.amount;
  }
  for (const key of Object.keys(spendingCents)) if (spendingCents[key] === 0) delete spendingCents[key];
  const completeness = projectionCompletenessFromLeaves(classifiedLeaves);
  const spending = Object.fromEntries(Object.entries(spendingCents).map(([name, cents]) => [name, fromCents(cents)]));
  if (completeness.complete) {
    return {
      spending,
      totalSpend: fromCents(totals.spendCents),
      totalIncome: fromCents(totals.incomeCents),
      completeness,
    };
  }
  return {
    spending,
    totalSpend: null,
    totalIncome: null,
    knownSpendSubtotal: fromCents(totals.spendCents),
    knownIncomeSubtotal: fromCents(totals.incomeCents),
    completeness,
  };
}

module.exports = {
  PROJECTION_INCOMPLETE_REASON,
  mergeProjectionCompleteness,
  projectionCompletenessFromLeaves,
  spendSummaryFromClassifiedLeaves,
};
