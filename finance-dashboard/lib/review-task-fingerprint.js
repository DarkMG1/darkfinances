'use strict';

const crypto = require('crypto');

const REVIEW_CONTENT_VERSION = 1;

function amountCentsFromDollars(amount) {
  const n = Number(amount);
  if (!Number.isFinite(n)) return 0;
  return Math.round(n * 100);
}

function hashPayload(value) {
  return crypto.createHash('sha256').update(JSON.stringify(value)).digest('hex');
}

function txnImportedId(txn) {
  if (!txn) return null;
  const imported = txn.imported_id ?? txn.importedId;
  return imported != null && String(imported).trim() ? String(imported).trim() : null;
}

function txnPayeeId(txn) {
  if (!txn) return null;
  const payeeId = txn.payeeId ?? txn.payee_id;
  return payeeId != null && String(payeeId).trim() ? String(payeeId).trim() : null;
}

function normalizePayeeText(payee) {
  return String(payee || '')
    .normalize('NFKD')
    .replace(/[\u0300-\u036f]/g, '')
    .toLowerCase()
    .replace(/\s+/g, ' ')
    .trim();
}

function payeeIdentityRef(txn) {
  const payeeId = txnPayeeId(txn);
  if (payeeId) return { kind: 'payeeId', value: payeeId };
  return { kind: 'payee', value: normalizePayeeText(txn?.payee) };
}

function buildImportedIdCounts(transactions = []) {
  const counts = new Map();
  for (const txn of transactions) {
    const imported = txnImportedId(txn);
    if (!imported) continue;
    counts.set(imported, (counts.get(imported) || 0) + 1);
  }
  return counts;
}

function importedAnchorUnique(importedId, context = {}) {
  if (!importedId) return false;
  const counts = context.importedIdCounts;
  if (!counts) return true;
  return counts.get(importedId) === 1;
}

function parentStableAnchor(parentId, context = {}) {
  const parent = context.parentById?.get(String(parentId));
  if (!parent) return `id:${parentId}`;
  return stableEntityAnchor({ ...parent, parentId: null, isLeg: false }, context);
}

function stableEntityAnchor(txn, context = {}) {
  if (!txn) return 'unknown';
  const imported = txnImportedId(txn);
  const rawId = String(txn.id || 'unknown');

  if (txn.isLeg && txn.parentId) {
    const parentAnchor = parentStableAnchor(txn.parentId, context);
    return `leg:${parentAnchor}:${rawId}`;
  }

  if (imported && importedAnchorUnique(imported, context)) {
    return `imported:${imported}`;
  }

  const parts = [`id:${rawId}`];
  if (imported && !importedAnchorUnique(imported, context)) {
    parts.push(`ambiguousImport:${imported}`);
  }
  return parts.join(':');
}

function contentEntityAnchor(txn, context = {}) {
  if (!txn) return 'unknown';
  const stable = stableEntityAnchor(txn, context);
  if (!txn.isLeg || !txn.parentId) return stable;
  const payeeRef = payeeIdentityRef(txn);
  return [
    stable,
    String(amountCentsFromDollars(txn.amount)),
    String(txn.categoryId || ''),
    `${payeeRef.kind}:${payeeRef.value}`,
    String(txn.date || ''),
  ].join(':');
}

function entityAnchor(txn, context = {}) {
  return stableEntityAnchor(txn, context);
}

function transferIdentityContentHash(identity) {
  if (!identity || typeof identity !== 'object') return hashPayload(null);
  return hashPayload({
    linkId: identity.linkId ?? null,
    counterpartTransactionId: identity.counterpartTransactionId ?? null,
    transferredId: identity.transferredId ?? null,
    accountId: identity.accountId ?? null,
    counterpartAccountId: identity.counterpartAccountId ?? null,
    counterpartInWindow: !!identity.counterpartInWindow,
    pairValid: !!identity.pairValid,
    componentSize: identity.componentSize ?? null,
    reason: identity.reason ?? null,
  });
}

function reconciliationUnresolvedEntries(task) {
  const entries = (task.unresolvedItems || []).map((item) => ({
    anchor: entityAnchor(item, task._fingerprintContext || {}),
    amountCents: amountCentsFromDollars(item.amount),
    id: String(item.id || ''),
    importedId: txnImportedId(item) || null,
  }));
  entries.sort((left, right) => JSON.stringify(left).localeCompare(JSON.stringify(right)));
  return entries;
}

function repaymentAllocationEntries(task, context = {}) {
  const entries = [];
  for (const allocation of task.allocations || []) {
    const expense = allocation?.expense || {};
    const amount = allocation?.amount ?? expense.amount ?? task.amount;
    entries.push({
      person: String(allocation?.person || task.person || ''),
      expenseAnchor: entityAnchor(expense, context),
      amountCents: amountCentsFromDollars(amount),
      allocationKind: String(allocation?.kind || task.allocationKind || ''),
    });
  }
  entries.sort((left, right) => JSON.stringify(left).localeCompare(JSON.stringify(right)));
  return entries;
}

function canonicalReviewContent(task, context = {}) {
  const kind = task.kind;
  const txn = task.transaction;
  const fingerprintContext = task._fingerprintContext || context;
  const anchor = contentEntityAnchor(txn, fingerprintContext);
  const stableAnchor = stableEntityAnchor(txn, fingerprintContext);
  const payeeRef = payeeIdentityRef(txn);
  const base = { v: REVIEW_CONTENT_VERSION, kind };

  switch (kind) {
    case 'uncategorized':
      return {
        ...base,
        anchor: stableAnchor,
        contentAnchor: anchor,
        date: String(task.date || txn?.date || ''),
        amountCents: amountCentsFromDollars(txn?.amount ?? task.amount),
        payee: payeeRef,
        accountId: String(txn?.accountId || ''),
        categoryId: txn?.categoryId ? String(txn.categoryId) : '',
        cleared: txn?.cleared === false ? false : true,
      };
    case 'large_charge':
      return {
        ...base,
        anchor: stableAnchor,
        contentAnchor: anchor,
        date: String(task.date || txn?.date || ''),
        amountCents: amountCentsFromDollars(txn?.amount ?? task.amount),
        payee: payeeRef,
        accountId: String(txn?.accountId || ''),
        categoryId: txn?.categoryId ? String(txn.categoryId) : '',
        thresholdCents: Math.round(Number(context.largeThreshold ?? 200) * 100),
      };
    case 'missing_receipt':
      return {
        ...base,
        anchor: stableAnchor,
        contentAnchor: anchor,
        date: String(task.date || txn?.date || ''),
        amountCents: amountCentsFromDollars(txn?.amount ?? task.amount),
        payee: payeeRef,
        accountId: String(txn?.accountId || ''),
        categoryId: txn?.categoryId ? String(txn.categoryId) : '',
      };
    case 'pending':
      return {
        ...base,
        anchor: stableAnchor,
        contentAnchor: anchor,
        date: String(task.date || txn?.date || ''),
        amountCents: amountCentsFromDollars(txn?.amount ?? task.amount),
        payee: payeeRef,
        accountId: String(txn?.accountId || ''),
        categoryId: txn?.categoryId ? String(txn.categoryId) : '',
        cleared: txn?.cleared === false ? false : true,
      };
    case 'repayment': {
      const inflow = task.inflow || { id: task.inflowId };
      return {
        ...base,
        person: String(task.person || ''),
        inflowAnchor: entityAnchor(inflow, fingerprintContext),
        inflowAmountCents: amountCentsFromDollars(inflow.amount ?? task.amount),
        allocations: repaymentAllocationEntries(task, fingerprintContext),
        allocationKind: String(task.allocationKind || task.kind_alloc || ''),
      };
    }
    case 'price_change':
      return {
        ...base,
        recurringKey: String(task.key || ''),
        fromCents: amountCentsFromDollars(task.priceChange?.from ?? task.from),
        toCents: amountCentsFromDollars(task.priceChange?.to ?? task.to),
        pct: Number(task.priceChange?.pct ?? task.pct ?? 0),
      };
    case 'reconciliation':
      return {
        ...base,
        month: String(task.month || ''),
        unresolved: reconciliationUnresolvedEntries(task),
      };
    case 'transfer_identity':
      return {
        ...base,
        reason: String(task.transferReason || ''),
        anchor: stableAnchor,
        contentAnchor: anchor,
        identityHash: transferIdentityContentHash(task.transferIdentity),
      };
    default:
      return { ...base, anchor: String(task.stableKey || task.id || 'unknown') };
  }
}

function reviewTaskContentHash(task, context = {}) {
  return hashPayload(canonicalReviewContent(task, context));
}

function reviewTaskStableKey(task, context = {}) {
  const kind = task.kind;
  const fingerprintContext = task._fingerprintContext || context;
  switch (kind) {
    case 'uncategorized':
    case 'large_charge':
    case 'missing_receipt':
    case 'pending':
      return `${kind}:${stableEntityAnchor(task.transaction, fingerprintContext)}`;
    case 'repayment':
      return `repayment:${String(task.suggestionId || task.id?.replace(/^repayment:/, '').split('@')[0] || '')}`;
    case 'price_change':
      return `price:${String(task.key || '')}`;
    case 'reconciliation':
      return `reconcile:${String(task.month || '')}`;
    case 'transfer_identity':
      return `transfer_identity:${String(task.transferReason || '')}:${stableEntityAnchor(task.transaction, fingerprintContext)}`;
    default:
      return String(task.id || 'unknown');
  }
}

function stableKeyDigest(stableKey) {
  return hashPayload(String(stableKey || ''));
}

function reviewTaskPublicId(stableKey, contentHash) {
  return `${stableKeyDigest(stableKey)}@${contentHash}`;
}

function parseReviewTaskId(id, taskIndex = null) {
  const raw = String(id || '');
  if (!raw) return { legacy: true, legacyKey: raw, stableKey: null, contentHash: null };
  const at = raw.lastIndexOf('@');
  if (at <= 0 || at >= raw.length - 1) {
    return { legacy: true, legacyKey: raw, stableKey: null, contentHash: null };
  }
  const prefix = raw.slice(0, at);
  const contentHash = raw.slice(at + 1);
  if (!/^[a-f0-9]{64}$/.test(contentHash)) {
    return { legacy: true, legacyKey: raw, stableKey: null, contentHash: null };
  }

  if (/^[a-f0-9]{64}$/.test(prefix) && taskIndex?.byStableKeyDigest?.has(prefix)) {
    const task = taskIndex.byStableKeyDigest.get(prefix);
    return {
      legacy: false,
      legacyKey: raw,
      stableKey: task.stableKey,
      stableKeyDigest: prefix,
      contentHash,
      task,
    };
  }

  if (prefix.includes(':')) {
    return {
      legacy: false,
      legacyKey: raw,
      stableKey: prefix,
      contentHash,
      legacyBoundFormat: true,
    };
  }

  return { legacy: true, legacyKey: raw, stableKey: null, contentHash: null };
}

function enrichReviewTask(task, context = {}) {
  const fingerprintContext = buildReviewFingerprintContext(context.transactions || []);
  Object.assign(fingerprintContext, {
    largeThreshold: context.largeThreshold,
    receiptThreshold: context.receiptThreshold,
    importedIdCounts: context.importedIdCounts || fingerprintContext.importedIdCounts,
  });
  const draft = { ...task, _fingerprintContext: fingerprintContext };
  const stableKey = reviewTaskStableKey(draft, fingerprintContext);
  const contentHash = reviewTaskContentHash(draft, fingerprintContext);
  const stableKeyHash = stableKeyDigest(stableKey);
  return {
    ...task,
    stableKey,
    stableKeyHash,
    contentHash,
    contentVersion: REVIEW_CONTENT_VERSION,
    id: reviewTaskPublicId(stableKey, contentHash),
  };
}

function legacyTxnIdFromKey(legacyKey) {
  const match = String(legacyKey || '').match(/^(?:uncategorized|large_charge|missing_receipt|pending):(.+)$/);
  if (!match) return null;
  const tail = match[1];
  if (tail.includes('@') || /^[a-f0-9]{64}$/.test(tail)) return null;
  if (tail.startsWith('id:')) return tail.slice(3).split(':')[0];
  if (tail.startsWith('imported:')) return null;
  if (tail.startsWith('leg:')) {
    const parts = tail.split(':');
    return parts[parts.length - 1] || null;
  }
  return tail;
}

function legacyRepaymentIdFromKey(legacyKey) {
  const match = String(legacyKey || '').match(/^repayment:(.+)$/);
  return match ? match[1] : null;
}

function expandTransactionTargetEvidence(transactions = []) {
  const targets = new Set();
  const importedIds = new Set();
  const parentById = new Map();
  for (const txn of transactions || []) {
    if (!txn) continue;
    if (txn.id != null) {
      targets.add(String(txn.id));
      parentById.set(String(txn.id), txn);
    }
    if (txn.parentId != null) targets.add(String(txn.parentId));
    const imported = txnImportedId(txn);
    if (imported) importedIds.add(imported);
  }
  return { targets: [...targets], importedIds: [...importedIds], transactions };
}

function expandDeletionSnapshotEvidence(snapshot) {
  if (!snapshot || typeof snapshot !== 'object') {
    return { targets: [], importedIds: [], transactions: [] };
  }
  const transactions = [{
    id: snapshot.id,
    imported_id: snapshot.imported_id || null,
    parentId: null,
    isLeg: false,
  }];
  for (const leg of snapshot.subtransactions || []) {
    transactions.push({
      id: leg.id,
      imported_id: leg.imported_id || null,
      parentId: snapshot.id,
      isLeg: true,
    });
    if (leg.id != null) transactions[transactions.length - 1].id = String(leg.id);
  }
  return expandTransactionTargetEvidence(transactions);
}

function buildReviewFingerprintContext(transactions = []) {
  const parentById = new Map();
  for (const txn of transactions || []) {
    if (txn?.id != null) parentById.set(String(txn.id), txn);
  }
  return {
    importedIdCounts: buildImportedIdCounts(transactions),
    transactions,
    parentById,
  };
}

module.exports = {
  REVIEW_CONTENT_VERSION,
  amountCentsFromDollars,
  buildImportedIdCounts,
  canonicalReviewContent,
  enrichReviewTask,
  entityAnchor,
  buildReviewFingerprintContext,
  contentEntityAnchor,
  expandDeletionSnapshotEvidence,
  expandTransactionTargetEvidence,
  hashPayload,
  importedAnchorUnique,
  legacyRepaymentIdFromKey,
  legacyTxnIdFromKey,
  normalizePayeeText,
  parseReviewTaskId,
  payeeIdentityRef,
  reconciliationUnresolvedEntries,
  repaymentAllocationEntries,
  reviewTaskContentHash,
  reviewTaskPublicId,
  reviewTaskStableKey,
  stableKeyDigest,
  transferIdentityContentHash,
  stableEntityAnchor,
  txnAnchor: stableEntityAnchor,
  txnImportedId,
  txnPayeeId,
};
