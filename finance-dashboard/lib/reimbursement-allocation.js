'use strict';

const crypto = require('crypto');
const { KnownPreApplyError } = require('./errors');
const { fromCents, sumCents, toCents } = require('./domain/money');

class ReimbursementAllocationInvalidError extends KnownPreApplyError {
  constructor(message = 'reimbursement allocation is invalid') {
    super(message, { code: 'REIMBURSEMENT_ALLOCATION_INVALID', status: 409 });
    this.name = 'ReimbursementAllocationInvalidError';
  }
}

class ReimbursementLinkStaleError extends KnownPreApplyError {
  constructor(message = 'reimbursement link state changed — refresh and retry') {
    super(message, { code: 'REIMBURSEMENT_LINK_STALE', status: 409 });
    this.name = 'ReimbursementLinkStaleError';
  }
}

class ReimbursementLegacyAmbiguityBlockedError extends KnownPreApplyError {
  constructor(message = 'legacy ambiguous links on this endpoint must be reviewed before new allocations') {
    super(message, { code: 'REIMBURSEMENT_LEGACY_AMBIGUITY_BLOCKED', status: 409 });
    this.name = 'ReimbursementLegacyAmbiguityBlockedError';
  }
}

class ReimbursementAllocationFieldsError extends KnownPreApplyError {
  constructor(message = 'allocationCents and amount must agree when both are provided') {
    super(message, { code: 'REIMBURSEMENT_ALLOCATION_FIELDS_DISAGREE', status: 400 });
    this.name = 'ReimbursementAllocationFieldsError';
  }
}

function allocationInvalid(message) {
  throw new ReimbursementAllocationInvalidError(message);
}

function linkStale(message) {
  throw new ReimbursementLinkStaleError(message);
}

function legacyAmbiguityBlocked(message) {
  throw new ReimbursementLegacyAmbiguityBlockedError(message);
}

function allocationFieldsDisagree(message) {
  throw new ReimbursementAllocationFieldsError(message);
}

function sameTransactionId(left, right) {
  return String(left) === String(right);
}

function linkPairKey(inflowId, expenseId) {
  return `${String(inflowId)}:${String(expenseId)}`;
}

function requireSafeCents(value, label) {
  if (!Number.isSafeInteger(value)) allocationInvalid(`${label} must be a safe integer cent amount`);
  return value;
}

function assertAllocationFieldsAgree(body) {
  if (body?.allocationCents == null || body?.amount == null) return;
  const fromCents = requireSafeCents(body.allocationCents, 'allocationCents');
  const fromAmount = Math.abs(toCents(body.amount));
  if (fromCents !== fromAmount) allocationFieldsDisagree();
}

function parseRequestedAllocationCents(body) {
  assertAllocationFieldsAgree(body);
  if (body?.allocationCents != null) {
    const cents = requireSafeCents(body.allocationCents, 'allocationCents');
    if (cents <= 0) allocationInvalid('allocationCents must be positive');
    return cents;
  }
  if (body?.amount != null) {
    const cents = Math.abs(toCents(body.amount));
    if (cents <= 0) allocationInvalid('amount must be greater than zero');
    return cents;
  }
  allocationInvalid('explicit allocationCents or amount is required');
}

function ambiguousLegacyLinksOnEndpoint(links, txnId, excludePair = null) {
  return (links || []).filter((link) => {
    const classified = classifyStoredLink(link);
    if (!classified.ambiguous) return false;
    const touches = sameTransactionId(link?.inflow?.id, txnId)
      || sameTransactionId(link?.expense?.id, txnId);
    if (!touches) return false;
    if (excludePair
      && sameTransactionId(link?.inflow?.id, excludePair.inflowId)
      && sameTransactionId(link?.expense?.id, excludePair.expenseId)) return false;
    return true;
  });
}

function assertLegacyAmbiguityAdmission({
  links,
  inflowId,
  expenseId,
  existingLink,
  allowSamePairResolution = false,
}) {
  const pair = { inflowId: String(inflowId), expenseId: String(expenseId) };
  const exclude = allowSamePairResolution ? pair : null;
  const inflowAmbiguous = ambiguousLegacyLinksOnEndpoint(links, inflowId, exclude);
  const expenseAmbiguous = ambiguousLegacyLinksOnEndpoint(links, expenseId, exclude);
  if (inflowAmbiguous.length > 0 || expenseAmbiguous.length > 0) {
    legacyAmbiguityBlocked();
  }
}

function endpointAdmissionFingerprint(live) {
  if (!live?.id) return '';
  return [
    String(live.id),
    String(live.accountId ?? ''),
    String(live.date ?? ''),
    String(live.amountCents ?? ''),
    String(live.category ?? ''),
    live.isLeg ? String(live.parentId ?? '') : '',
  ].join('|');
}

function storedEndpointIdentityFingerprint(ref, role) {
  if (!ref?.id) return '';
  let amountCents = '';
  if (ref.amount != null) {
    try {
      const cents = Math.abs(toCents(ref.amount));
      amountCents = String(role === 'expense' ? -cents : cents);
    } catch (_) {
      amountCents = '';
    }
  } else if (ref.amountCents != null && Number.isSafeInteger(ref.amountCents)) {
    amountCents = String(ref.amountCents);
  }
  return [
    String(ref.id),
    String(ref.accountId ?? ''),
    String(ref.date ?? ''),
    amountCents,
  ].join('|');
}

function liveEndpointIdentityFingerprint(live) {
  if (!live?.id) return '';
  return [
    String(live.id),
    String(live.accountId ?? ''),
    String(live.date ?? ''),
    String(live.amountCents ?? ''),
  ].join('|');
}

function assessLiveReimbursementEndpoint(live, { reimbCategoryId, role } = {}) {
  if (!live?.id) return { eligible: false, reason: 'missing_live' };
  if (role === 'inflow') {
    if (!(live.amountCents > 0)) return { eligible: false, reason: 'inflow_sign' };
    return { eligible: true, reason: null };
  }
  if (role === 'expense') {
    if (!(live.amountCents < 0)) return { eligible: false, reason: 'expense_sign' };
    if (reimbCategoryId != null) {
      if (live.category == null) return { eligible: false, reason: 'missing_category' };
      if (String(live.category) !== String(reimbCategoryId)) {
        return { eligible: false, reason: 'category_mismatch' };
      }
    }
    return { eligible: true, reason: null };
  }
  if (live.amountCents > 0) return assessLiveReimbursementEndpoint(live, { reimbCategoryId, role: 'inflow' });
  if (live.amountCents < 0) return assessLiveReimbursementEndpoint(live, { reimbCategoryId, role: 'expense' });
  return { eligible: false, reason: 'zero_amount' };
}

function classifyStoredLink(link) {
  if (link?.allocationCents != null) {
    const cents = requireSafeCents(link.allocationCents, 'stored allocationCents');
    if (cents <= 0) {
      return { allocationCents: null, trusted: false, ambiguous: true, reason: 'invalid_stored_cents' };
    }
    return { allocationCents: cents, trusted: true, ambiguous: false, reason: 'explicit_cents' };
  }
  if (link?.amount != null) {
    try {
      const cents = Math.abs(toCents(link.amount));
      if (cents <= 0) {
        return { allocationCents: null, trusted: false, ambiguous: true, reason: 'invalid_legacy_amount' };
      }
      return { allocationCents: cents, trusted: true, ambiguous: false, reason: 'legacy_amount' };
    } catch (_) {
      return { allocationCents: null, trusted: false, ambiguous: true, reason: 'invalid_legacy_amount' };
    }
  }
  return { allocationCents: null, trusted: false, ambiguous: true, reason: 'legacy_null' };
}

function trustedLinkedCents(link) {
  const classified = classifyStoredLink(link);
  return classified.trusted ? classified.allocationCents : 0;
}

function sumTrustedAllocationsForExpense(links, expenseId, excludePair = null) {
  let total = 0;
  for (const link of links || []) {
    if (!sameTransactionId(link?.expense?.id, expenseId)) continue;
    if (excludePair
      && sameTransactionId(link?.inflow?.id, excludePair.inflowId)
      && sameTransactionId(link?.expense?.id, excludePair.expenseId)) continue;
    total = sumCents([total, trustedLinkedCents(link)]);
  }
  return total;
}

function sumTrustedAllocationsForInflow(links, inflowId, excludePair = null) {
  let total = 0;
  for (const link of links || []) {
    if (!sameTransactionId(link?.inflow?.id, inflowId)) continue;
    if (excludePair
      && sameTransactionId(link?.inflow?.id, excludePair.inflowId)
      && sameTransactionId(link?.expense?.id, excludePair.expenseId)) continue;
    total = sumCents([total, trustedLinkedCents(link)]);
  }
  return total;
}

function absExpenseCents(expenseAmountCents) {
  const cents = requireSafeCents(expenseAmountCents, 'expense amount');
  if (cents >= 0) allocationInvalid('expense amount must be negative cents');
  return Math.abs(cents);
}

function absInflowCents(inflowAmountCents) {
  const cents = requireSafeCents(inflowAmountCents, 'inflow amount');
  if (cents <= 0) allocationInvalid('inflow amount must be positive cents');
  return cents;
}

function validateLinkCapacity({
  allocationCents,
  inflowAmountCents,
  expenseAmountCents,
  existingLinks,
  inflowId,
  expenseId,
}) {
  const alloc = requireSafeCents(allocationCents, 'allocationCents');
  if (alloc <= 0) allocationInvalid('allocation amount must be positive cents');

  const inflowCap = absInflowCents(inflowAmountCents);
  const expenseCap = absExpenseCents(expenseAmountCents);
  const pair = { inflowId: String(inflowId), expenseId: String(expenseId) };

  const priorInflow = sumTrustedAllocationsForInflow(existingLinks, inflowId, pair);
  const priorExpense = sumTrustedAllocationsForExpense(existingLinks, expenseId, pair);

  const inflowRemaining = inflowCap - priorInflow;
  const expenseRemaining = expenseCap - priorExpense;

  if (alloc > inflowRemaining) {
    allocationInvalid(`allocation exceeds remaining inflow capacity for ${inflowId}`);
  }
  if (alloc > expenseRemaining) {
    allocationInvalid(`allocation exceeds remaining expense capacity for ${expenseId}`);
  }
  return {
    allocationCents: alloc,
    inflowRemainingCents: inflowRemaining - alloc,
    expenseRemainingCents: expenseRemaining - alloc,
    inflowCapCents: inflowCap,
    expenseCapCents: expenseCap,
    inflowAllocatedCents: priorInflow + alloc,
    expenseAllocatedCents: priorExpense + alloc,
  };
}

function linkVersion(link) {
  if (link?.version != null) return Number(link.version) || 0;
  if (link?.allocationCents != null || link?.amount != null) return 1;
  return 0;
}

function assertExpectedVersion(existingLink, expectedVersion) {
  if (expectedVersion == null) return;
  const current = linkVersion(existingLink);
  if (Number(expectedVersion) !== current) {
    linkStale(`expected link version ${expectedVersion} but found ${current}`);
  }
}

function txnRefFromLive({
  id,
  date,
  payee,
  amountCents,
  accountId,
  accountName,
  imported,
  category,
  categoryId,
}) {
  return {
    id: String(id),
    date: date || null,
    payee: payee || '',
    amount: fromCents(amountCents),
    accountId: accountId || null,
    account: accountName || '',
    imported: Boolean(imported),
    categoryId: categoryId ?? category ?? null,
  };
}

function buildExplicitLinkRecord({
  inflowLive,
  expenseLive,
  allocationCents,
  person,
  existingLink,
  expectedVersion,
}) {
  if (existingLink) assertExpectedVersion(existingLink, expectedVersion);
  const classified = existingLink ? classifyStoredLink(existingLink) : null;
  if (existingLink && classified?.trusted && classified.allocationCents === allocationCents) {
    return { record: existingLink, changed: false, idempotent: true };
  }
  if (existingLink && classified?.trusted && classified.allocationCents !== allocationCents && expectedVersion == null) {
    linkStale('allocation update requires expectedVersion');
  }

  const now = new Date().toISOString();
  const nextVersion = existingLink ? linkVersion(existingLink) + 1 : 1;
  const record = {
    linkKey: linkPairKey(inflowLive.id, expenseLive.id),
    inflow: txnRefFromLive(inflowLive),
    expense: txnRefFromLive(expenseLive),
    allocationCents,
    amount: fromCents(allocationCents),
    person: person || existingLink?.person || null,
    version: nextVersion,
    createdAt: existingLink?.createdAt || now,
    updatedAt: now,
  };
  return { record, changed: true, idempotent: false };
}

function applyLinkRecord(store, record) {
  const index = store.links.findIndex(
    (link) => sameTransactionId(link?.inflow?.id, record.inflow.id)
      && sameTransactionId(link?.expense?.id, record.expense.id),
  );
  if (index >= 0) store.links[index] = { ...store.links[index], ...record };
  else store.links.push(record);
}

function removeLinkRecord(store, { inflowId, expenseId }) {
  const before = store.links.length;
  store.links = store.links.filter(
    (link) => !(sameTransactionId(link?.inflow?.id, inflowId)
      && sameTransactionId(link?.expense?.id, expenseId)),
  );
  return before - store.links.length;
}

function linkRecordConverged(store, record) {
  const existing = store.links.find(
    (link) => sameTransactionId(link?.inflow?.id, record.inflow.id)
      && sameTransactionId(link?.expense?.id, record.expense.id),
  );
  if (!existing) return false;
  const classified = classifyStoredLink(existing);
  return classified.trusted && classified.allocationCents === record.allocationCents
    && linkVersion(existing) === record.version;
}

function buildLegacyMigrationReport(links) {
  const rows = [];
  for (const link of links || []) {
    const classified = classifyStoredLink(link);
    if (!classified.ambiguous) continue;
    rows.push({
      linkKey: linkPairKey(link?.inflow?.id, link?.expense?.id),
      inflowId: link?.inflow?.id ?? null,
      expenseId: link?.expense?.id ?? null,
      inflowDate: link?.inflow?.date ?? null,
      expenseDate: link?.expense?.date ?? null,
      reason: classified.reason,
      createdAt: link?.createdAt ?? null,
    });
  }
  rows.sort((a, b) => String(a.linkKey).localeCompare(String(b.linkKey)));
  return {
    ambiguousCount: rows.length,
    rows,
    generatedAt: new Date().toISOString(),
  };
}

function enrichEndpointForRead(ref, link, role) {
  const classified = classifyStoredLink(link);
  const allocatedCents = classified.trusted ? classified.allocationCents : null;
  return {
    ...ref,
    allocated: allocatedCents != null ? fromCents(allocatedCents) : null,
    allocatedCents,
    allocationTrusted: classified.trusted,
    allocationAmbiguous: classified.ambiguous,
    allocationReason: classified.reason,
    linkVersion: linkVersion(link),
    linkKey: link?.linkKey || linkPairKey(link?.inflow?.id, link?.expense?.id),
    role,
  };
}

function summarizeEndpointCapacity({
  txnId,
  txnAmountCents,
  links,
  role,
}) {
  const absCap = role === 'inflow'
    ? absInflowCents(txnAmountCents)
    : absExpenseCents(txnAmountCents);
  const allocatedTrustedCents = role === 'inflow'
    ? sumTrustedAllocationsForInflow(links, txnId)
    : sumTrustedAllocationsForExpense(links, txnId);
  const ambiguousLinkCount = (links || []).filter((link) => {
    const classified = classifyStoredLink(link);
    if (!classified.ambiguous) return false;
    return role === 'inflow'
      ? sameTransactionId(link?.inflow?.id, txnId)
      : sameTransactionId(link?.expense?.id, txnId);
  }).length;
  const remainingTrustedCents = absCap - allocatedTrustedCents;
  let completeness = 'complete';
  let completenessReason = null;
  if (ambiguousLinkCount > 0) {
    completeness = 'ambiguous';
    completenessReason = `${ambiguousLinkCount} legacy link${ambiguousLinkCount === 1 ? '' : 's'} without explicit allocation`;
  } else if (allocatedTrustedCents > absCap) {
    completeness = 'overallocated';
    completenessReason = 'trusted allocations exceed live transaction capacity';
  }
  return {
    role,
    absCapCents: absCap,
    allocatedTrustedCents,
    remainingTrustedCents,
    ambiguousLinkCount,
    completeness,
    completenessReason,
  };
}

function transactionFingerprint(snapshot) {
  return crypto.createHash('sha256').update(JSON.stringify(snapshot)).digest('hex');
}

function migrateLinkToSchemaV2(link) {
  const classified = classifyStoredLink(link);
  const next = { ...link };
  next.linkKey = link?.linkKey || linkPairKey(link?.inflow?.id, link?.expense?.id);
  if (classified.trusted && next.allocationCents == null) {
    next.allocationCents = classified.allocationCents;
  }
  if (classified.trusted && next.amount == null) {
    next.amount = fromCents(classified.allocationCents);
  }
  if (next.version == null && classified.trusted) next.version = 1;
  for (const role of ['inflow', 'expense']) {
    const ref = next?.[role];
    if (!ref || ref.categoryId != null) continue;
    if (ref.category != null) ref.categoryId = ref.category;
  }
  return next;
}

module.exports = {
  ReimbursementAllocationFieldsError,
  ReimbursementAllocationInvalidError,
  ReimbursementLegacyAmbiguityBlockedError,
  ReimbursementLinkStaleError,
  absExpenseCents,
  absInflowCents,
  ambiguousLegacyLinksOnEndpoint,
  applyLinkRecord,
  assertAllocationFieldsAgree,
  assertExpectedVersion,
  assertLegacyAmbiguityAdmission,
  assessLiveReimbursementEndpoint,
  buildExplicitLinkRecord,
  buildLegacyMigrationReport,
  classifyStoredLink,
  enrichEndpointForRead,
  endpointAdmissionFingerprint,
  liveEndpointIdentityFingerprint,
  linkPairKey,
  linkRecordConverged,
  linkVersion,
  migrateLinkToSchemaV2,
  parseRequestedAllocationCents,
  removeLinkRecord,
  sameTransactionId,
  storedEndpointIdentityFingerprint,
  summarizeEndpointCapacity,
  sumTrustedAllocationsForExpense,
  sumTrustedAllocationsForInflow,
  transactionFingerprint,
  trustedLinkedCents,
  txnRefFromLive,
  validateLinkCapacity,
};
