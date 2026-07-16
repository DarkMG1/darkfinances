'use strict';

function hasOwn(object, key) {
  return Object.prototype.hasOwnProperty.call(object, key);
}

function mappedId(idMap, value) {
  const id = String(value);
  const mapped = hasOwn(idMap, id) ? idMap[id] : id;
  if (mapped == null) {
    throw new Error('transaction replacement cannot delete referenced evidence');
  }
  return String(mapped);
}

function assignWithoutLoss(target, key, value, label) {
  if (hasOwn(target, key) && JSON.stringify(target[key]) !== JSON.stringify(value)) {
    throw new Error(`${label} reference migration would overwrite distinct evidence`);
  }
  target[key] = value;
}

function assertRelationship(pairs, inflowId, expenseId, label) {
  if (inflowId == null || expenseId == null) return;
  const inflow = String(inflowId);
  const expense = String(expenseId);
  if (inflow === expense) {
    throw new Error(`${label} reference migration would create a self-relationship`);
  }
  const pair = JSON.stringify([inflow, expense]);
  if (pairs.has(pair)) {
    throw new Error(`${label} reference migration would create a duplicate relationship`);
  }
  pairs.add(pair);
}

function rewriteSnapshot(snapshot, idMap) {
  if (!snapshot || typeof snapshot !== 'object' || snapshot.id == null) return snapshot;
  return { ...snapshot, id: mappedId(idMap, snapshot.id) };
}

function rewriteSuggestionValue(value, nextInflowId, idMap) {
  const next = { ...value, inflowId: nextInflowId };
  if (value?.inflow) next.inflow = rewriteSnapshot(value.inflow, idMap);
  if (value?.expense) next.expense = rewriteSnapshot(value.expense, idMap);
  if (Array.isArray(value?.allocations)) {
    next.allocations = value.allocations.map((allocation) => ({
      ...allocation,
      ...(allocation?.inflow ? { inflow: rewriteSnapshot(allocation.inflow, idMap) } : {}),
      ...(allocation?.expense ? { expense: rewriteSnapshot(allocation.expense, idMap) } : {}),
    }));
  }
  return next;
}

function rewriteTransactionReplacementReferences(stores, idMap) {
  const stats = { receipts: 0, links: 0, suggestions: 0, reconciliation: 0, phantomSeen: 0 };
  const receipts = { byTxn: {} };
  for (const [oldTxnId, list] of Object.entries(stores.receipts?.byTxn || {})) {
    const nextTxnId = mappedId(idMap, oldTxnId);
    const destination = receipts.byTxn[nextTxnId] || (receipts.byTxn[nextTxnId] = []);
    for (const receipt of list || []) {
      const next = { ...receipt, txnId: nextTxnId };
      if (next.txnId !== receipt.txnId || nextTxnId !== oldTxnId) stats.receipts += 1;
      destination.push(next);
    }
  }

  const links = { links: [] };
  const linkPairs = new Set();
  for (const link of stores.links?.links || []) {
    const inflowId = link?.inflow?.id == null ? null : mappedId(idMap, link.inflow.id);
    const expenseId = link?.expense?.id == null ? null : mappedId(idMap, link.expense.id);
    assertRelationship(linkPairs, inflowId, expenseId, 'reimbursement link');
    const next = {
      ...link,
      inflow: { ...link.inflow, id: inflowId },
      expense: { ...link.expense, id: expenseId },
    };
    if (inflowId !== link.inflow.id || expenseId !== link.expense.id) stats.links += 1;
    links.links.push(next);
  }

  const suggestions = { confirmed: {}, dismissed: [] };
  const suggestionPairs = new Set();
  for (const value of stores.suggestions?.dismissed || []) {
    const next = mappedId(idMap, value);
    if (next !== value) stats.suggestions += 1;
    if (!suggestions.dismissed.includes(next)) suggestions.dismissed.push(next);
  }
  for (const [key, value] of Object.entries(stores.suggestions?.confirmed || {})) {
    const oldInflowId = value?.inflowId;
    const nextInflowId = oldInflowId == null ? oldInflowId : mappedId(idMap, oldInflowId);
    const nextKey = key.startsWith('sg_') ? `sg_${mappedId(idMap, key.slice(3))}` : key;
    if (nextKey !== key || nextInflowId !== oldInflowId) stats.suggestions += 1;
    if (hasOwn(suggestions.confirmed, nextKey)) {
      throw new Error('reimbursement suggestion reference migration would create a duplicate relationship');
    }
    const nextValue = rewriteSuggestionValue(value, nextInflowId, idMap);
    const topInflowId = nextValue.inflowId
      ?? nextValue.inflow?.id
      ?? (nextKey.startsWith('sg_') ? nextKey.slice(3) : null);
    if (nextValue.expense?.id != null) {
      assertRelationship(
        suggestionPairs,
        topInflowId ?? nextValue.inflow?.id,
        nextValue.expense.id,
        'reimbursement suggestion',
      );
    }
    for (const allocation of Array.isArray(nextValue.allocations) ? nextValue.allocations : []) {
      const allocationInflowId = allocation?.inflow?.id;
      const allocationExpenseId = allocation?.expense?.id;
      if (allocationExpenseId == null) continue;
      const effectiveInflowId = topInflowId ?? allocationInflowId;
      assertRelationship(
        suggestionPairs,
        effectiveInflowId,
        allocationExpenseId,
        'reimbursement allocation',
      );
      if (allocationInflowId != null && String(allocationInflowId) !== String(effectiveInflowId)) {
        assertRelationship(
          suggestionPairs,
          allocationInflowId,
          allocationExpenseId,
          'reimbursement allocation snapshot',
        );
      }
    }
    suggestions.confirmed[nextKey] = nextValue;
  }

  const reconciliation = { ...stores.reconciliation, months: {} };
  for (const [month, value] of Object.entries(stores.reconciliation?.months || {})) {
    const items = {};
    for (const [id, timestamp] of Object.entries(value?.items || {})) {
      const next = mappedId(idMap, id);
      if (next !== id) stats.reconciliation += 1;
      assignWithoutLoss(items, next, timestamp, 'reconciliation');
    }
    reconciliation.months[month] = { ...value, items };
  }

  const phantomSeen = { seen: {} };
  for (const [id, value] of Object.entries(stores.phantomSeen?.seen || {})) {
    const next = mappedId(idMap, id);
    if (next !== id) stats.phantomSeen += 1;
    assignWithoutLoss(phantomSeen.seen, next, value, 'phantom-seen');
  }

  return {
    stores: { receipts, links, suggestions, reconciliation, phantomSeen },
    stats,
  };
}

module.exports = { rewriteTransactionReplacementReferences };
