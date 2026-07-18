'use strict';

const {
  expandDeletionSnapshotEvidence,
  expandTransactionTargetEvidence,
} = require('./review-task-fingerprint');
const { rewriteReviewDispositionsForDeletion } = require('./review-disposition');

const REFERENCE_STEPS = Object.freeze([
  'receipts',
  'links',
  'suggestions',
  'reconciliation',
  'phantomSeen',
  'reviewState',
]);

function isObject(value) {
  return Boolean(value) && typeof value === 'object' && !Array.isArray(value);
}

function normalizeDeletionTargetEvidence(targetEvidence) {
  if (targetEvidence?.snapshot) return expandDeletionSnapshotEvidence(targetEvidence.snapshot);
  if (Array.isArray(targetEvidence)) {
    return expandTransactionTargetEvidence(targetEvidence.map((id) => ({ id: String(id) })));
  }
  if (targetEvidence?.transactions) return expandTransactionTargetEvidence(targetEvidence.transactions);
  if (targetEvidence?.ids) {
    return expandTransactionTargetEvidence(targetEvidence.ids.map((id) => ({ id: String(id) })));
  }
  throw new Error('transaction deletion reference evidence required');
}

function targetSet(targetEvidence) {
  const expanded = normalizeDeletionTargetEvidence(targetEvidence);
  const targets = new Set(expanded.targets.map(String));
  if (!targets.size) throw new Error('transaction deletion reference targets required');
  return targets;
}

function refersTo(targets, value) {
  return value != null && targets.has(String(value));
}

function assertStores(stores) {
  if (!isObject(stores)) throw new Error('transaction deletion reference stores must be an object');
  if (!isObject(stores.receipts) || !isObject(stores.receipts.byTxn)) {
    throw new Error('invalid receipts reference store');
  }
  for (const list of Object.values(stores.receipts.byTxn)) {
    if (!Array.isArray(list)) throw new Error('invalid receipts reference bucket');
  }
  if (!isObject(stores.links) || !Array.isArray(stores.links.links)) {
    throw new Error('invalid reimbursement links reference store');
  }
  if (!isObject(stores.suggestions)
    || !isObject(stores.suggestions.confirmed)
    || !Array.isArray(stores.suggestions.dismissed)) {
    throw new Error('invalid reimbursement suggestions reference store');
  }
  if (!isObject(stores.reconciliation) || !isObject(stores.reconciliation.months)) {
    throw new Error('invalid reconciliation reference store');
  }
  if (!isObject(stores.phantomSeen) || !isObject(stores.phantomSeen.seen)) {
    throw new Error('invalid phantom-seen reference store');
  }
  if (stores.reviewState != null
    && (!isObject(stores.reviewState)
      || !isObject(stores.reviewState.dispositions)
      || !isObject(stores.reviewState.legacyDispositions))) {
    throw new Error('invalid review-state reference store');
  }
}

function rewriteReceipts(store, targets, stats) {
  const byTxn = { ...store.byTxn };
  const removedFiles = new Set();
  const survivingFiles = new Set();

  for (const [txnId, receipts] of Object.entries(store.byTxn)) {
    const removeBucket = refersTo(targets, txnId);
    const kept = [];
    for (const receipt of receipts) {
      if (removeBucket || refersTo(targets, receipt?.txnId)) {
        stats.receipts += 1;
        if (receipt?.file != null) {
          if (typeof receipt.file !== 'string') throw new Error('invalid receipt file reference');
          removedFiles.add(receipt.file);
        }
      } else {
        kept.push(receipt);
        if (receipt?.file != null) {
          if (typeof receipt.file !== 'string') throw new Error('invalid receipt file reference');
          survivingFiles.add(receipt.file);
        }
      }
    }
    if (removeBucket || kept.length === 0) delete byTxn[txnId];
    else if (kept.length !== receipts.length) byTxn[txnId] = kept;
  }

  return {
    store: { ...store, byTxn },
    receiptFilesToDelete: [...removedFiles]
      .filter((file) => !survivingFiles.has(file))
      .sort(),
  };
}

function rewriteLinks(store, targets, stats) {
  const links = store.links.filter((link) => {
    const remove = refersTo(targets, link?.inflow?.id)
      || refersTo(targets, link?.expense?.id);
    if (remove) stats.links += 1;
    return !remove;
  });
  return links.length === store.links.length ? store : { ...store, links };
}

function suggestionRefersToTarget(key, value, targets) {
  return (key.startsWith('sg_') && refersTo(targets, key.slice(3)))
    || refersTo(targets, value?.inflowId)
    || refersTo(targets, value?.expenseId)
    || refersTo(targets, value?.inflow?.id)
    || refersTo(targets, value?.expense?.id);
}

function allocationRefersToTarget(allocation, targets) {
  return refersTo(targets, allocation?.inflowId)
    || refersTo(targets, allocation?.expenseId)
    || refersTo(targets, allocation?.inflow?.id)
    || refersTo(targets, allocation?.expense?.id);
}

function rewriteSuggestions(store, targets, stats) {
  const dismissed = store.dismissed.filter((value) => {
    const remove = refersTo(targets, value);
    if (remove) stats.suggestions += 1;
    return !remove;
  });
  const confirmed = { ...store.confirmed };
  let confirmedChanged = false;

  for (const [key, value] of Object.entries(store.confirmed)) {
    if (suggestionRefersToTarget(key, value, targets)) {
      delete confirmed[key];
      stats.suggestions += 1;
      confirmedChanged = true;
      continue;
    }
    if (!Array.isArray(value?.allocations)) continue;
    const allocations = value.allocations.filter((allocation) => {
      const remove = allocationRefersToTarget(allocation, targets);
      if (remove) stats.suggestions += 1;
      return !remove;
    });
    if (allocations.length !== value.allocations.length) {
      confirmed[key] = { ...value, allocations };
      confirmedChanged = true;
    }
  }

  if (dismissed.length === store.dismissed.length && !confirmedChanged) return store;
  return { ...store, dismissed, confirmed };
}

function rewriteReconciliation(store, targets, stats) {
  const months = { ...store.months };
  let changed = false;
  for (const [month, value] of Object.entries(store.months)) {
    if (!isObject(value) || !isObject(value.items)) continue;
    const items = { ...value.items };
    let monthChanged = false;
    for (const id of Object.keys(value.items)) {
      if (!refersTo(targets, id)) continue;
      delete items[id];
      stats.reconciliation += 1;
      monthChanged = true;
    }
    if (monthChanged) {
      months[month] = { ...value, items };
      changed = true;
    }
  }
  return changed ? { ...store, months } : store;
}

function rewritePhantomSeen(store, targets, stats) {
  const seen = { ...store.seen };
  let changed = false;
  for (const id of Object.keys(store.seen)) {
    if (!refersTo(targets, id)) continue;
    delete seen[id];
    stats.phantomSeen += 1;
    changed = true;
  }
  return changed ? { ...store, seen } : store;
}

function rewriteReviewState(store, targetEvidence, stats) {
  const { reviewState, stats: reviewStats } = rewriteReviewDispositionsForDeletion(store, targetEvidence);
  stats.reviewState += reviewStats.reviewState;
  return reviewState;
}

function rewriteTransactionDeletionReferences(stores, targetEvidence) {
  assertStores(stores);
  const targets = targetSet(targetEvidence);
  const stats = {
    receipts: 0,
    links: 0,
    suggestions: 0,
    reconciliation: 0,
    phantomSeen: 0,
    reviewState: 0,
  };
  const receipts = rewriteReceipts(stores.receipts, targets, stats);
  return {
    stores: {
      receipts: receipts.store,
      links: rewriteLinks(stores.links, targets, stats),
      suggestions: rewriteSuggestions(stores.suggestions, targets, stats),
      reconciliation: rewriteReconciliation(stores.reconciliation, targets, stats),
      phantomSeen: rewritePhantomSeen(stores.phantomSeen, targets, stats),
      reviewState: rewriteReviewState(stores.reviewState, targetEvidence, stats),
    },
    receiptFilesToDelete: receipts.receiptFilesToDelete,
    stats,
  };
}

module.exports = {
  REFERENCE_STEPS,
  normalizeDeletionTargetEvidence,
  rewriteTransactionDeletionReferences,
};
