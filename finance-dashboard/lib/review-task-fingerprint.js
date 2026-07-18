'use strict';

const crypto = require('crypto');

const REVIEW_CONTENT_VERSION = 1;

function normalizePayeeKey(payee) {
  return String(payee || '')
    .toLowerCase()
    .replace(/[#*]?\d{3,}/g, ' ')
    .replace(/[^a-z0-9 ]+/g, ' ')
    .replace(/\s+/g, ' ')
    .trim();
}

function amountCentsFromDollars(amount) {
  return Math.round(Number(amount) * 100);
}

function hashPayload(value) {
  return crypto.createHash('sha256').update(JSON.stringify(value)).digest('hex');
}

function txnImportedId(txn) {
  if (!txn) return null;
  const imported = txn.imported_id ?? txn.importedId;
  return imported != null && String(imported).trim() ? String(imported).trim() : null;
}

function txnAnchor(txn, kind) {
  if (!txn) return `${kind}:unknown`;
  const imported = txnImportedId(txn);
  if (imported) return `${kind}:imported:${imported}`;
  const id = String(txn.id || 'unknown');
  if (txn.isLeg && txn.parentId) {
    return `${kind}:leg:${txn.parentId}:${amountCentsFromDollars(txn.amount)}:${txn.categoryId || ''}:${normalizePayeeKey(txn.payee)}`;
  }
  return `${kind}:id:${id}`;
}

function transferIdentityContentHash(identity) {
  if (!identity || typeof identity !== 'object') return '';
  return hashPayload({
    linkId: identity.linkId ?? null,
    counterpartTransactionId: identity.counterpartTransactionId ?? null,
    transferredId: identity.transferredId ?? null,
    accountId: identity.accountId ?? null,
    counterpartAccountId: identity.counterpartAccountId ?? null,
    counterpartInWindow: !!identity.counterpartInWindow,
    pairValid: !!identity.pairValid,
    componentSize: identity.componentSize ?? null,
  });
}

function repaymentAllocationAnchors(suggestion) {
  const anchors = [];
  for (const allocation of suggestion?.allocations || []) {
    const expense = allocation?.expense;
    if (!expense?.id) continue;
    anchors.push(`id:${expense.id}`);
  }
  return anchors.sort();
}

function canonicalReviewContent(task, context = {}) {
  const kind = task.kind;
  const txn = task.transaction;
  const base = { v: REVIEW_CONTENT_VERSION, kind };

  switch (kind) {
    case 'uncategorized':
      return {
        ...base,
        anchor: txnAnchor(txn, kind),
        date: String(task.date || txn?.date || ''),
        amountCents: amountCentsFromDollars(txn?.amount ?? task.amount),
        payeeKey: normalizePayeeKey(txn?.payee),
        accountId: String(txn?.accountId || ''),
        categoryId: txn?.categoryId ? String(txn.categoryId) : '',
      };
    case 'large_charge':
      return {
        ...base,
        anchor: txnAnchor(txn, kind),
        date: String(task.date || txn?.date || ''),
        amountCents: amountCentsFromDollars(txn?.amount ?? task.amount),
        thresholdCents: Math.round(Number(context.largeThreshold ?? 200) * 100),
      };
    case 'missing_receipt':
      return {
        ...base,
        anchor: txnAnchor(txn, kind),
        date: String(task.date || txn?.date || ''),
        amountCents: amountCentsFromDollars(txn?.amount ?? task.amount),
      };
    case 'pending':
      return {
        ...base,
        anchor: txnAnchor(txn, kind),
        date: String(task.date || txn?.date || ''),
        amountCents: amountCentsFromDollars(txn?.amount ?? task.amount),
        cleared: txn?.cleared === false ? false : true,
      };
    case 'repayment':
      return {
        ...base,
        person: String(task.person || ''),
        inflowAnchor: txnAnchor(task.inflow || { id: task.inflowId }, kind),
        amountCents: amountCentsFromDollars(task.amount),
        allocationAnchors: repaymentAllocationAnchors(task),
        allocationKind: String(task.allocationKind || task.kind_alloc || ''),
      };
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
        remaining: Number(task.remaining ?? task.amount ?? 0),
        total: Number(task.total ?? 0),
      };
    case 'transfer_identity':
      return {
        ...base,
        reason: String(task.transferReason || ''),
        anchor: txnAnchor(txn, kind),
        identityHash: transferIdentityContentHash(task.transferIdentity),
      };
    default:
      return { ...base, anchor: String(task.id || 'unknown') };
  }
}

function reviewTaskContentHash(task, context = {}) {
  return hashPayload(canonicalReviewContent(task, context));
}

function reviewTaskStableKey(task) {
  const kind = task.kind;
  switch (kind) {
    case 'uncategorized':
    case 'large_charge':
    case 'missing_receipt':
    case 'pending':
      return `${kind}:${txnAnchor(task.transaction, kind)}`;
    case 'repayment':
      return `repayment:${String(task.suggestionId || task.id?.replace(/^repayment:/, '') || '')}`;
    case 'price_change':
      return `price:${String(task.key || '')}`;
    case 'reconciliation':
      return `reconcile:${String(task.month || '')}`;
    case 'transfer_identity':
      return `transfer_identity:${String(task.transferReason || '')}:${txnAnchor(task.transaction, kind)}`;
    default:
      return String(task.id || 'unknown');
  }
}

function reviewTaskPublicId(stableKey, contentHash) {
  const candidate = `${stableKey}@${contentHash}`;
  if (candidate.length <= 500) return candidate;
  return `${hashPayload({ stableKey }).slice(0, 16)}@${contentHash}`;
}

function parseReviewTaskId(id) {
  const raw = String(id || '');
  if (!raw) return { legacy: true, legacyKey: raw, stableKey: null, contentHash: null };
  const at = raw.lastIndexOf('@');
  if (at <= 0 || at >= raw.length - 1) {
    return { legacy: true, legacyKey: raw, stableKey: null, contentHash: null };
  }
  const stableKey = raw.slice(0, at);
  const contentHash = raw.slice(at + 1);
  if (!/^[a-f0-9]{64}$/.test(contentHash)) {
    return { legacy: true, legacyKey: raw, stableKey: null, contentHash: null };
  }
  return { legacy: false, legacyKey: raw, stableKey, contentHash };
}

function enrichReviewTask(task, context = {}) {
  const stableKey = reviewTaskStableKey(task);
  const contentHash = reviewTaskContentHash(task, context);
  return {
    ...task,
    stableKey,
    contentHash,
    contentVersion: REVIEW_CONTENT_VERSION,
    id: reviewTaskPublicId(stableKey, contentHash),
  };
}

function legacyTxnIdFromKey(legacyKey) {
  const match = String(legacyKey || '').match(/^(?:uncategorized|large_charge|missing_receipt|pending):(.+)$/);
  if (!match) return null;
  const tail = match[1];
  if (tail.includes('@')) return null;
  return tail;
}

function legacyRepaymentIdFromKey(legacyKey) {
  const match = String(legacyKey || '').match(/^repayment:(.+)$/);
  return match ? match[1] : null;
}

module.exports = {
  REVIEW_CONTENT_VERSION,
  amountCentsFromDollars,
  canonicalReviewContent,
  enrichReviewTask,
  hashPayload,
  legacyRepaymentIdFromKey,
  legacyTxnIdFromKey,
  normalizePayeeKey,
  parseReviewTaskId,
  repaymentAllocationAnchors,
  reviewTaskContentHash,
  reviewTaskPublicId,
  reviewTaskStableKey,
  transferIdentityContentHash,
  txnAnchor,
  txnImportedId,
};
