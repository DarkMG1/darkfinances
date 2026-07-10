function hasOwn(object, key) {
  return Object.prototype.hasOwnProperty.call(object, key);
}

function mappedId(idMap, value) {
  const id = String(value);
  return hasOwn(idMap, id) ? idMap[id] : id;
}

function rewriteTransactionReferences(stores, idMap) {
  const stats = { receipts: 0, links: 0, suggestions: 0, reconciliation: 0, phantomSeen: 0 };
  const receiptFilesToDelete = [];

  const receipts = { byTxn: {} };
  for (const [oldTxnId, list] of Object.entries(stores.receipts?.byTxn || {})) {
    const nextTxnId = mappedId(idMap, oldTxnId);
    if (nextTxnId == null) {
      for (const receipt of list || []) if (receipt?.file) receiptFilesToDelete.push(receipt.file);
      stats.receipts += (list || []).length;
      continue;
    }
    const destination = receipts.byTxn[nextTxnId] || (receipts.byTxn[nextTxnId] = []);
    for (const receipt of list || []) {
      const next = { ...receipt, txnId: nextTxnId };
      if (next.txnId !== receipt.txnId || nextTxnId !== oldTxnId) stats.receipts += 1;
      destination.push(next);
    }
  }

  const links = { links: [] };
  for (const link of stores.links?.links || []) {
    const inflowId = link?.inflow?.id == null ? null : mappedId(idMap, link.inflow.id);
    const expenseId = link?.expense?.id == null ? null : mappedId(idMap, link.expense.id);
    if (inflowId == null || expenseId == null || inflowId === expenseId) {
      stats.links += 1;
      continue;
    }
    const next = {
      ...link,
      inflow: { ...link.inflow, id: inflowId },
      expense: { ...link.expense, id: expenseId },
    };
    if (inflowId !== link.inflow.id || expenseId !== link.expense.id) stats.links += 1;
    links.links.push(next);
  }

  const suggestions = {
    confirmed: {},
    dismissed: [],
  };
  for (const value of stores.suggestions?.dismissed || []) {
    const next = mappedId(idMap, value);
    if (next == null) {
      stats.suggestions += 1;
      continue;
    }
    if (next !== value) stats.suggestions += 1;
    if (!suggestions.dismissed.includes(next)) suggestions.dismissed.push(next);
  }
  for (const [key, value] of Object.entries(stores.suggestions?.confirmed || {})) {
    const oldInflowId = value?.inflowId;
    const nextInflowId = oldInflowId == null ? oldInflowId : mappedId(idMap, oldInflowId);
    if (nextInflowId == null) {
      stats.suggestions += 1;
      continue;
    }
    let nextKey = key;
    if (key.startsWith('sg_')) {
      const mapped = mappedId(idMap, key.slice(3));
      if (mapped == null) {
        stats.suggestions += 1;
        continue;
      }
      nextKey = `sg_${mapped}`;
    }
    if (nextKey !== key || nextInflowId !== oldInflowId) stats.suggestions += 1;
    suggestions.confirmed[nextKey] = { ...value, inflowId: nextInflowId };
  }

  const reconciliation = {
    ...stores.reconciliation,
    months: {},
  };
  for (const [month, value] of Object.entries(stores.reconciliation?.months || {})) {
    const items = {};
    for (const [id, timestamp] of Object.entries(value?.items || {})) {
      const next = mappedId(idMap, id);
      if (next == null) {
        stats.reconciliation += 1;
        continue;
      }
      if (next !== id) stats.reconciliation += 1;
      items[next] = timestamp;
    }
    reconciliation.months[month] = { ...value, items };
  }

  const phantomSeen = { seen: {} };
  for (const [id, value] of Object.entries(stores.phantomSeen?.seen || {})) {
    const next = mappedId(idMap, id);
    if (next == null) {
      stats.phantomSeen += 1;
      continue;
    }
    if (next !== id) stats.phantomSeen += 1;
    phantomSeen.seen[next] = value;
  }

  return {
    stores: { receipts, links, suggestions, reconciliation, phantomSeen },
    receiptFilesToDelete,
    stats,
  };
}

module.exports = { rewriteTransactionReferences };
