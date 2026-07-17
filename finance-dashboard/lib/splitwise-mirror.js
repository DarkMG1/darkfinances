'use strict';

const crypto = require('crypto');
const { toCents } = require('./domain/money');
const { categoryIdentityFingerprint } = require('./bulk-operation-fingerprint');
const { KnownPreApplyError } = require('./errors');

const RESOLUTIONS_SCHEMA_VERSION = 1;
const MIRROR_SOURCE_TAG = /#sw-(\d+)\b/g;
const IMPORTED_ID_PREFIX = 'darkfinances:splitwise-mirror:';
const PENDING_MIRROR_ACCOUNT = 'pending';
const DEFAULT_OWES_SNAPSHOT_MAX_AGE_MS = 6 * 60 * 60 * 1000;

function owesSnapshotMaxAgeMs() {
  const parsed = Number(process.env.OWES_SNAPSHOT_MAX_AGE_MS);
  return Number.isFinite(parsed) && parsed > 0 ? parsed : DEFAULT_OWES_SNAPSHOT_MAX_AGE_MS;
}

function isPendingMirrorAccountId(accountId) {
  return accountId == null || String(accountId) === PENDING_MIRROR_ACCOUNT;
}

class SplitwiseMirrorAmbiguousError extends KnownPreApplyError {
  constructor(sourceIds = []) {
    super('Splitwise mirror has unreviewed duplicate live tags', {
      code: 'SPLITWISE_MIRROR_AMBIGUOUS',
      status: 409,
    });
    this.name = 'SplitwiseMirrorAmbiguousError';
    this.sourceIds = sourceIds;
  }
}

class SplitwiseMirrorResolutionError extends KnownPreApplyError {
  constructor(message) {
    super(message, {
      code: 'SPLITWISE_MIRROR_RESOLUTION_INVALID',
      status: 409,
    });
    this.name = 'SplitwiseMirrorResolutionError';
  }
}

class SplitwiseMirrorAdmissionError extends KnownPreApplyError {
  constructor(message, code = 'SPLITWISE_MIRROR_ADMISSION_FAILED') {
    super(message, { code, status: 409 });
    this.name = 'SplitwiseMirrorAdmissionError';
  }
}

class SplitwiseMirrorSnapshotError extends KnownPreApplyError {
  constructor(message) {
    super(message, {
      code: 'STALE_UPSTREAM_DATA',
      status: 503,
    });
    this.name = 'SplitwiseMirrorSnapshotError';
  }
}

function bootstrapAccountResourceKey(accountName) {
  return `bootstrap:account:${String(accountName || '').toLowerCase()}`;
}

function bootstrapCategoryResourceKey(categoryName) {
  return `bootstrap:category:${String(categoryName || '').toLowerCase()}`;
}

function parseMirrorSourceId(notes) {
  const text = String(notes || '');
  let lastMatch = null;
  const pattern = new RegExp(MIRROR_SOURCE_TAG.source, 'g');
  let match;
  while ((match = pattern.exec(text)) !== null) {
    lastMatch = match[1];
  }
  return lastMatch;
}

function sourceIdFromImportedId(importedId) {
  if (!importedId || !String(importedId).startsWith(IMPORTED_ID_PREFIX)) return null;
  const sourceId = String(importedId).slice(IMPORTED_ID_PREFIX.length);
  return /^\d+$/.test(sourceId) ? sourceId : null;
}

function resolveMirrorRowSourceId(row) {
  const tagId = parseMirrorSourceId(row?.notes);
  const importedSourceId = sourceIdFromImportedId(row?.imported_id);
  if (importedSourceId && tagId && importedSourceId !== tagId) {
    return {
      sourceId: null,
      disagreement: true,
      tagId,
      importedSourceId,
    };
  }
  if (importedSourceId && !tagId) {
    return {
      sourceId: null,
      disagreement: false,
      tagId,
      importedSourceId,
      orphanImported: true,
    };
  }
  return {
    sourceId: tagId || importedSourceId || null,
    disagreement: false,
    tagId,
    importedSourceId,
  };
}

function snapshotBoundImportedTagMismatchSourceIds(rows, truth) {
  const wanted = new Set(
    (truth?.othersPaidItems || [])
      .map((item) => String(item?.id || ''))
      .filter((id) => /^\d+$/.test(id)),
  );
  const sourceIds = new Set();
  for (const row of rows || []) {
    const importedSourceId = sourceIdFromImportedId(row?.imported_id);
    if (!importedSourceId || !wanted.has(importedSourceId)) continue;
    const tagId = parseMirrorSourceId(row.notes);
    if (tagId !== importedSourceId) sourceIds.add(importedSourceId);
  }
  return [...sourceIds].sort();
}

function importedTagDisagreementSourceIds(rows) {
  const ids = new Set();
  for (const row of rows || []) {
    const resolved = resolveMirrorRowSourceId(row);
    if (resolved.disagreement) {
      if (resolved.importedSourceId) ids.add(resolved.importedSourceId);
      if (resolved.tagId) ids.add(resolved.tagId);
    }
  }
  return [...ids].sort();
}

function ambiguousDuplicateImportedSourceIds(rows) {
  const byImported = new Map();
  for (const row of rows || []) {
    if (!row.imported_id || !String(row.imported_id).startsWith(IMPORTED_ID_PREFIX)) continue;
    const list = byImported.get(row.imported_id) || [];
    list.push(row);
    byImported.set(row.imported_id, list);
  }
  const sourceIds = new Set();
  for (const [, dupRows] of byImported.entries()) {
    if (dupRows.length <= 1) continue;
    for (const row of dupRows) {
      const fromImported = sourceIdFromImportedId(row.imported_id);
      const fromTag = parseMirrorSourceId(row.notes);
      if (fromImported) sourceIds.add(fromImported);
      else if (fromTag) sourceIds.add(fromTag);
    }
  }
  return [...sourceIds].sort();
}

function indexMirrorRowsBySourceId(transactions) {
  const map = new Map();
  for (const row of transactions || []) {
    if (row.is_parent || row.parent_id) continue;
    const resolved = resolveMirrorRowSourceId(row);
    if (resolved.disagreement || !resolved.sourceId) continue;
    const sourceId = resolved.sourceId;
    const list = map.get(sourceId) || [];
    list.push(row);
    map.set(sourceId, list);
  }
  return map;
}

function canonicalSnapshotItem(item) {
  return {
    id: String(item.id),
    myShare: Number(item.myShare),
    date: String(item.date || '').slice(0, 10),
    desc: String(item.desc || ''),
    category: String(item.category || ''),
    payer: String(item.payer || ''),
    currency: item.currency ? String(item.currency) : null,
  };
}

function snapshotManifestFingerprint(truth) {
  return crypto.createHash('sha256')
    .update(JSON.stringify({
      generatedAt: truth.generatedAt,
      manifest: truth.manifest,
      items: (truth.othersPaidItems || [])
        .map(canonicalSnapshotItem)
        .sort((left, right) => left.id.localeCompare(right.id)),
    }))
    .digest('hex');
}

function snapshotBinding(truth) {
  return {
    fingerprint: snapshotManifestFingerprint(truth),
    generatedAt: truth.generatedAt,
    manifest: truth.manifest,
  };
}

function myShareExpenseCents(item) {
  const id = String(item?.id || '');
  try {
    const share = Number(item.myShare);
    if (!Number.isFinite(share) || share <= 0) {
      throw new Error(`Splitwise snapshot contains an invalid share for expense ${id}`);
    }
    return -toCents(share);
  } catch (error) {
    if (error instanceof RangeError || error instanceof TypeError) {
      throw new Error(`Splitwise snapshot share for expense ${id} is not an exact cent amount`);
    }
    throw error;
  }
}

function buildMirrorNotes(item) {
  const id = String(item.id);
  let desc = String(item.desc || 'Splitwise expense').replace(/\s#sw-\d+\b/g, '').trim();
  if (!desc) desc = 'Splitwise expense';
  const payerPart = item.payer ? ` (paid by ${item.payer})` : '';
  return `${desc}${payerPart} #sw-${id}`;
}

function durableImportedId(sourceId) {
  return `${IMPORTED_ID_PREFIX}${String(sourceId)}`;
}

function mirrorIdentityFingerprint(transaction, sourceId) {
  const importedId = transaction?.imported_id;
  if (importedId && importedId === durableImportedId(sourceId)) {
    return crypto.createHash('sha256')
      .update(JSON.stringify({ kind: 'imported', importedId: String(importedId) }))
      .digest('hex');
  }
  return crypto.createHash('sha256')
    .update(JSON.stringify({
      kind: 'legacy-tag',
      sourceId: String(sourceId),
      txnId: String(transaction.id),
      fingerprint: categoryIdentityFingerprint(transaction),
    }))
    .digest('hex');
}

function mirrorIntentFromItem(item, accountId, categoryId, {
  useRuntimeCategoryFallback = false,
  accountPending = false,
} = {}) {
  const sourceId = String(item.id);
  return {
    sourceId,
    accountId: accountPending ? null : (accountId ? String(accountId) : null),
    accountPending,
    amount: myShareExpenseCents(item),
    date: String(item.date || '').slice(0, 10),
    categoryId: categoryId ? String(categoryId) : null,
    useRuntimeCategoryFallback,
    notes: buildMirrorNotes(item),
    importedId: durableImportedId(sourceId),
  };
}

function resolveMirrorAccountId(saga, item, runtimeAccountId = null) {
  const runtime = runtimeAccountId || saga?.mirrorRuntime?.accountId || null;
  if (runtime) return String(runtime);
  if (item?.accountId && !isPendingMirrorAccountId(item.accountId)) return String(item.accountId);
  return null;
}

function effectiveMirrorIntent(saga, item, runtimeAccountId = null) {
  const intent = { ...item.intent };
  const accountId = resolveMirrorAccountId(saga, item, runtimeAccountId);
  if (accountId) intent.accountId = accountId;
  if (intent.useRuntimeCategoryFallback) {
    const runtimeCategory = saga?.mirrorRuntime?.categoryId || null;
    if (runtimeCategory) intent.categoryId = String(runtimeCategory);
  }
  return intent;
}

function mirrorIntentMatches(transaction, intent, accountId) {
  if (!transaction || !intent) return false;
  const resolvedAccount = intent.accountId || accountId;
  if (!resolvedAccount || isPendingMirrorAccountId(resolvedAccount)) return false;
  return String(transaction.amount) === String(intent.amount)
    && String(transaction.date).slice(0, 10) === String(intent.date)
    && String(transaction.notes || '') === String(intent.notes)
    && String(transaction.category || '') === String(intent.categoryId || '')
    && String(transaction.account || resolvedAccount) === String(resolvedAccount);
}

function observedDuplicateSet(rows) {
  return rows
    .map((row) => ({
      id: String(row.id),
      fingerprint: categoryIdentityFingerprint(row),
    }))
    .sort((left, right) => left.id.localeCompare(right.id));
}

function observedSetsMatch(left, right) {
  return JSON.stringify(left || []) === JSON.stringify(right || []);
}

function normalizeResolutionRecord(record) {
  if (!record || typeof record !== 'object') return null;
  const sourceId = String(record.sourceId || '');
  if (!/^\d+$/.test(sourceId)) return null;
  const keepTxnId = String(record.keepTxnId || '');
  const dropTxnIds = Array.isArray(record.dropTxnIds)
    ? record.dropTxnIds.map(String)
    : null;
  const observed = Array.isArray(record.observed)
    ? record.observed
      .map((entry) => ({
        id: String(entry?.id || ''),
        fingerprint: String(entry?.fingerprint || ''),
      }))
      .filter((entry) => entry.id && entry.fingerprint)
    : null;
  const reviewedAt = String(record.reviewedAt || '');
  if (!keepTxnId || !dropTxnIds || !observed || !reviewedAt || !Number.isFinite(Date.parse(reviewedAt))) {
    return null;
  }
  if (observed.length < 2) return null;
  const observedIds = observed.map((entry) => entry.id);
  if (new Set(observedIds).size !== observedIds.length) return null;
  if (new Set(dropTxnIds).size !== dropTxnIds.length) return null;
  if (dropTxnIds.includes(keepTxnId)) return null;
  const sortedObserved = [...observed].sort((left, right) => left.id.localeCompare(right.id));
  const expectedDrops = observedIds.filter((id) => id !== keepTxnId).sort();
  const sortedDrops = [...dropTxnIds].sort();
  if (sortedDrops.length !== expectedDrops.length
    || sortedDrops.some((id, index) => id !== expectedDrops[index])) {
    return null;
  }
  if (!observedIds.includes(keepTxnId)) return null;
  return {
    sourceId,
    keepTxnId,
    dropTxnIds: sortedDrops,
    observed: sortedObserved,
    reviewedAt,
    note: record.note == null ? null : String(record.note),
  };
}

function loadSplitwiseMirrorResolutions(raw) {
  if (raw == null) {
    return { schemaVersion: RESOLUTIONS_SCHEMA_VERSION, resolutions: [] };
  }
  if (typeof raw !== 'object' || Array.isArray(raw)) {
    throw new SplitwiseMirrorResolutionError('Splitwise mirror resolutions sidecar has an invalid shape');
  }
  if (raw.schemaVersion !== RESOLUTIONS_SCHEMA_VERSION) {
    throw new SplitwiseMirrorResolutionError(
      `Splitwise mirror resolutions schemaVersion must be ${RESOLUTIONS_SCHEMA_VERSION}`,
    );
  }
  if (!Array.isArray(raw.resolutions)) {
    throw new SplitwiseMirrorResolutionError('Splitwise mirror resolutions must be an array');
  }
  const resolutions = [];
  const seenSources = new Set();
  for (let index = 0; index < raw.resolutions.length; index += 1) {
    const normalized = normalizeResolutionRecord(raw.resolutions[index]);
    if (!normalized) {
      throw new SplitwiseMirrorResolutionError(
        `Splitwise mirror resolution record ${index} is malformed`,
      );
    }
    if (seenSources.has(normalized.sourceId)) {
      throw new SplitwiseMirrorResolutionError(
        `Splitwise mirror resolutions contain duplicate sourceId ${normalized.sourceId}`,
      );
    }
    seenSources.add(normalized.sourceId);
    resolutions.push(normalized);
  }
  const store = { schemaVersion: RESOLUTIONS_SCHEMA_VERSION, resolutions };
  for (const [key, value] of Object.entries(raw)) {
    if (key === 'schemaVersion' || key === 'resolutions') continue;
    store[key] = value;
  }
  return store;
}

function readResolutionsStore(raw) {
  return loadSplitwiseMirrorResolutions(raw);
}

function resolutionIndex(resolutions) {
  const bySource = new Map();
  for (const resolution of resolutions || []) {
    if (!bySource.has(resolution.sourceId)) bySource.set(resolution.sourceId, resolution);
  }
  return bySource;
}

function findMirrorAccounts(accounts, accountName) {
  const needle = String(accountName || '').toLowerCase();
  return (accounts || []).filter(
    (account) => (account.name || '').toLowerCase() === needle,
  );
}

function findMirrorCategories(groups, categoryName) {
  const needle = String(categoryName || '').toLowerCase();
  const matches = [];
  for (const group of groups || []) {
    for (const category of group.categories || []) {
      if ((category.name || '').toLowerCase() === needle) matches.push(category);
    }
  }
  return matches;
}

function assertMirrorStructuralAdmission(accounts, groups, { accountName, categoryName }) {
  const accountMatches = findMirrorAccounts(accounts, accountName);
  if (accountMatches.length > 1) {
    throw new SplitwiseMirrorAdmissionError(
      `Multiple Actual accounts match Splitwise mirror name ${accountName}`,
      'SPLITWISE_MIRROR_ACCOUNT_AMBIGUOUS',
    );
  }
  if (accountMatches.length === 1 && accountMatches[0].closed) {
    throw new SplitwiseMirrorAdmissionError(
      `Splitwise mirror account ${accountName} is closed`,
      'SPLITWISE_MIRROR_ACCOUNT_CLOSED',
    );
  }
  const categoryMatches = findMirrorCategories(groups, categoryName);
  if (categoryMatches.length > 1) {
    throw new SplitwiseMirrorAdmissionError(
      `Multiple categories match Splitwise mirror name ${categoryName}`,
      'SPLITWISE_MIRROR_CATEGORY_AMBIGUOUS',
    );
  }
  return {
    account: accountMatches[0] || null,
    category: categoryMatches[0] || null,
  };
}

function validateResolutionAgainstLive(resolution, rows) {
  if (!resolution || !Array.isArray(rows) || rows.length < 2) return false;
  const liveObserved = observedDuplicateSet(rows);
  return observedSetsMatch(resolution.observed, liveObserved);
}

function findAmbiguousSourceIds(bySource, resolutionsBySource) {
  const ambiguous = [];
  for (const [sourceId, rows] of bySource.entries()) {
    if (rows.length <= 1) continue;
    const resolution = resolutionsBySource.get(sourceId);
    if (!resolution || !validateResolutionAgainstLive(resolution, rows)) {
      ambiguous.push(sourceId);
    }
  }
  return ambiguous.sort();
}

function assertNoMirrorAmbiguity(bySource, resolutions) {
  const ambiguous = findAmbiguousSourceIds(bySource, resolutionIndex(resolutions));
  if (ambiguous.length) throw new SplitwiseMirrorAmbiguousError(ambiguous);
}

function keeperRowForSource(rows, resolution) {
  if (!rows?.length) return null;
  if (rows.length === 1) return rows[0];
  if (!resolution) return null;
  return rows.find((row) => String(row.id) === String(resolution.keepTxnId)) || null;
}

function importedIdMatches(rows, sourceId) {
  const expected = durableImportedId(sourceId);
  return (rows || []).filter((row) => row.imported_id === expected);
}

function importedIdConflict(rows, sourceId, exceptTxnId = null) {
  const matches = importedIdMatches(rows, sourceId);
  return matches.find((row) => String(row.id) !== String(exceptTxnId || '')) || null;
}

function duplicateImportedIdsInAccount(rows) {
  const byImported = new Map();
  for (const row of rows || []) {
    if (!row.imported_id || !String(row.imported_id).startsWith(IMPORTED_ID_PREFIX)) continue;
    const list = byImported.get(row.imported_id) || [];
    list.push(String(row.id));
    byImported.set(row.imported_id, list);
  }
  return [...byImported.entries()].filter(([, ids]) => ids.length > 1);
}

function assertMirrorRowSourceIntegrity(rows) {
  const disagreements = importedTagDisagreementSourceIds(rows);
  if (disagreements.length) {
    throw new SplitwiseMirrorAmbiguousError(disagreements);
  }
  const duplicateImported = ambiguousDuplicateImportedSourceIds(rows);
  if (duplicateImported.length) {
    throw new SplitwiseMirrorAmbiguousError(duplicateImported);
  }
}

function validateReviewedDuplicateLiveState(rows, resolution, completedDropTxnIds = new Set()) {
  if (!resolution) return { ok: false, reason: 'missing resolution' };
  const observedById = new Map(resolution.observed.map((entry) => [entry.id, entry.fingerprint]));
  for (const row of rows || []) {
    const id = String(row.id);
    if (!observedById.has(id)) {
      return { ok: false, reason: 'unexpected duplicate row', sourceId: resolution.sourceId, id };
    }
    if (categoryIdentityFingerprint(row) !== observedById.get(id)) {
      return { ok: false, reason: 'duplicate fingerprint drift', sourceId: resolution.sourceId, id };
    }
  }
  for (const dropId of resolution.dropTxnIds) {
    if (completedDropTxnIds.has(dropId) && rows.some((row) => String(row.id) === dropId)) {
      return { ok: false, reason: 'completed duplicate drop still live', sourceId: resolution.sourceId, id: dropId };
    }
  }
  const liveIds = new Set((rows || []).map((row) => String(row.id)));
  for (const dropId of resolution.dropTxnIds) {
    if (!completedDropTxnIds.has(dropId) && !liveIds.has(dropId)) {
      return { ok: false, reason: 'pending duplicate drop missing', sourceId: resolution.sourceId, id: dropId };
    }
  }
  const completedDropCount = resolution.dropTxnIds
    .filter((dropId) => completedDropTxnIds.has(dropId)).length;
  const expectedCount = resolution.observed.length - completedDropCount;
  if ((rows || []).length !== expectedCount) {
    return { ok: false, reason: 'duplicate row count mismatch', sourceId: resolution.sourceId };
  }
  if (expectedCount === 1 && rows.length === 1
    && String(rows[0].id) !== String(resolution.keepTxnId)) {
    return { ok: false, reason: 'reviewed keeper mismatch', sourceId: resolution.sourceId };
  }
  return { ok: true };
}

function assertLiveMirrorLedgerConsistent(rows, {
  resolutions,
  resolutionBySource,
  completedDropTxnIdsBySource = new Map(),
  plannedSourceIds = new Set(),
}) {
  const bySource = indexMirrorRowsBySourceId(rows);
  assertMirrorRowSourceIntegrity(rows);
  const importedDupes = duplicateImportedIdsInAccount(rows);
  if (importedDupes.length) {
    throw new SplitwiseMirrorAmbiguousError(ambiguousDuplicateImportedSourceIds(rows));
  }
  const resolutionsBySource = resolutionBySource || resolutionIndex(resolutions);
  for (const [sourceId, liveRows] of bySource.entries()) {
    const resolution = resolutionsBySource.get(sourceId);
    if (liveRows.length <= 1) {
      const imported = importedIdMatches(rows, sourceId);
      const tagged = liveRows;
      if (imported.length === 1 && tagged.length === 1 && String(imported[0].id) !== String(tagged[0].id)) {
        throw new SplitwiseMirrorAmbiguousError([sourceId]);
      }
      if (imported.length > 1) throw new SplitwiseMirrorAmbiguousError([sourceId]);
      continue;
    }
    if (!resolution) {
      if (plannedSourceIds.has(sourceId)) {
        throw new SplitwiseMirrorAmbiguousError([sourceId]);
      }
      throw new SplitwiseMirrorAmbiguousError([sourceId]);
    }
    const completed = completedDropTxnIdsBySource.get(sourceId) || new Set();
    const state = validateReviewedDuplicateLiveState(liveRows, resolution, completed);
    if (!state.ok) throw new SplitwiseMirrorAmbiguousError([sourceId]);
  }
}

function verifyCreateMirrorIdentity(rows, intent, accountId, { checkpointedTxnId = null, rowsByAccount = null } = {}) {
  if (checkpointedTxnId && rowsByAccount) {
    for (const [acctId, acctRows] of Object.entries(rowsByAccount)) {
      if (String(acctId) === String(accountId)) continue;
      if (acctRows.some((row) => String(row.id) === String(checkpointedTxnId))) {
        return { ok: false, reason: 'checkpointed transaction moved to foreign account', id: checkpointedTxnId };
      }
    }
  }
  const imported = importedIdMatches(rows, intent.sourceId);
  if (imported.length > 1) {
    return { ok: false, reason: 'duplicate imported_id', sourceId: intent.sourceId };
  }
  const tagged = (rows || []).filter((row) => parseMirrorSourceId(row.notes) === intent.sourceId);
  if (imported.length === 1) {
    const row = imported[0];
    if (parseMirrorSourceId(row.notes) !== intent.sourceId) {
      return { ok: false, reason: 'imported_id/tag disagreement', sourceId: intent.sourceId, id: row.id };
    }
    if (tagged.length > 1 || (tagged.length === 1 && String(tagged[0].id) !== String(row.id))) {
      return { ok: false, reason: 'tag decoy with imported_id', sourceId: intent.sourceId };
    }
    if (checkpointedTxnId && String(row.id) !== String(checkpointedTxnId)) {
      return { ok: false, reason: 'imported_id identity mismatch', sourceId: intent.sourceId };
    }
    return { ok: true, row };
  }
  if (tagged.length > 1) {
    const exact = tagged.filter((row) => mirrorIntentMatches(row, intent, accountId));
    if (exact.length !== 1) {
      return { ok: false, reason: 'ambiguous tag-only rows', sourceId: intent.sourceId };
    }
    if (exact[0].imported_id && exact[0].imported_id !== intent.importedId) {
      return { ok: false, reason: 'foreign imported_id on tag row', sourceId: intent.sourceId, id: exact[0].id };
    }
    return { ok: true, row: exact[0] };
  }
  if (tagged.length === 1) {
    if (tagged[0].imported_id && tagged[0].imported_id !== intent.importedId) {
      return { ok: false, reason: 'tag decoy imported_id', sourceId: intent.sourceId, id: tagged[0].id };
    }
    return { ok: true, row: tagged[0] };
  }
  return { ok: true, row: null };
}

function locateCreatedMirrorRow(rows, intent, accountId) {
  const verification = verifyCreateMirrorIdentity(rows, intent, accountId);
  if (!verification.ok) return null;
  return verification.row || null;
}

function completedDropTxnIdsForSource(saga, sourceId) {
  const completed = new Set();
  for (const item of saga?.plan?.items || []) {
    if (item.itemType !== 'splitwise_duplicate_drop' || String(item.sourceId) !== String(sourceId)) continue;
    const outcome = saga.itemOutcomes?.[String(item.globalIndex)];
    if (outcome?.status === 'completed' && item.txnId) completed.add(String(item.txnId));
  }
  return completed;
}

function completedDropTxnIdsBySource(saga) {
  const map = new Map();
  for (const item of saga?.plan?.items || []) {
    if (item.itemType !== 'splitwise_duplicate_drop' || !item.sourceId) continue;
    const sourceId = String(item.sourceId);
    if (!map.has(sourceId)) map.set(sourceId, new Set());
    const outcome = saga.itemOutcomes?.[String(item.globalIndex)];
    if (outcome?.status === 'completed' && item.txnId) {
      map.get(sourceId).add(String(item.txnId));
    }
  }
  return map;
}

function plannedMirrorSourceIds(saga) {
  return new Set(
    (saga?.plan?.items || [])
      .map((item) => item.sourceId)
      .filter(Boolean)
      .map(String),
  );
}

async function preflightSplitwiseMirrorAdmission({
  api,
  readTruth,
  validateSnapshot,
  readResolutions,
  accountName,
  categoryName,
  accountRangeStart,
  accountRangeEnd,
}) {
  let truth;
  try {
    truth = readTruth();
    validateSnapshot(truth);
  } catch (error) {
    if (error instanceof SplitwiseMirrorSnapshotError) throw error;
    throw new SplitwiseMirrorSnapshotError(String(error?.message || error || 'Splitwise snapshot validation failed'));
  }
  const resolutions = readResolutions();
  let accounts;
  let groups;
  try {
    accounts = await api.getAccounts();
    groups = await api.getCategoryGroups();
  } catch (error) {
    throw new SplitwiseMirrorAdmissionError(
      'Unable to enumerate Actual accounts during splitwise mirror admission',
      'SPLITWISE_MIRROR_ADMISSION_FAILED',
    );
  }
  assertMirrorStructuralAdmission(accounts, groups, {
    accountName,
    categoryName,
  });
  const found = (accounts || []).find(
    (account) => (account.name || '').toLowerCase() === String(accountName).toLowerCase(),
  );
  if (!found) return;
  let rows;
  try {
    rows = await api.getTransactions(found.id, accountRangeStart, accountRangeEnd);
  } catch (error) {
    throw new SplitwiseMirrorAdmissionError(
      'Unable to query splitwise account during mirror admission',
      'SPLITWISE_MIRROR_ADMISSION_FAILED',
    );
  }
  assertNoMirrorAmbiguity(indexMirrorRowsBySourceId(rows), resolutions.resolutions || []);
  assertMirrorRowSourceIntegrity(rows);
  const snapshotMismatch = snapshotBoundImportedTagMismatchSourceIds(rows, truth);
  if (snapshotMismatch.length) {
    throw new SplitwiseMirrorAmbiguousError(snapshotMismatch);
  }
}

function completedMirrorDeletionMatchesItem(deletionSaga, item) {
  if (!deletionSaga || deletionSaga.phase !== 'completed') return false;
  if (String(deletionSaga.target?.parentId) !== String(item.txnId)) return false;
  if (String(deletionSaga.accountId) !== String(item.accountId)) return false;
  const snapshot = deletionSaga.target?.snapshot;
  if (!snapshot || !item.sourceId || !item.identityFingerprint) return false;
  return mirrorIdentityFingerprint(snapshot, item.sourceId) === item.identityFingerprint;
}

module.exports = {
  IMPORTED_ID_PREFIX,
  PENDING_MIRROR_ACCOUNT,
  RESOLUTIONS_SCHEMA_VERSION,
  DEFAULT_OWES_SNAPSHOT_MAX_AGE_MS,
  SplitwiseMirrorAdmissionError,
  SplitwiseMirrorSnapshotError,
  assertMirrorRowSourceIntegrity,
  SplitwiseMirrorAmbiguousError,
  SplitwiseMirrorResolutionError,
  assertLiveMirrorLedgerConsistent,
  assertMirrorStructuralAdmission,
  assertNoMirrorAmbiguity,
  bootstrapAccountResourceKey,
  bootstrapCategoryResourceKey,
  buildMirrorNotes,
  completedDropTxnIdsBySource,
  completedDropTxnIdsForSource,
  completedMirrorDeletionMatchesItem,
  durableImportedId,
  duplicateImportedIdsInAccount,
  effectiveMirrorIntent,
  findAmbiguousSourceIds,
  findMirrorAccounts,
  findMirrorCategories,
  importedIdConflict,
  importedIdMatches,
  indexMirrorRowsBySourceId,
  isPendingMirrorAccountId,
  keeperRowForSource,
  loadSplitwiseMirrorResolutions,
  locateCreatedMirrorRow,
  mirrorIdentityFingerprint,
  mirrorIntentFromItem,
  mirrorIntentMatches,
  myShareExpenseCents,
  normalizeResolutionRecord,
  observedDuplicateSet,
  observedSetsMatch,
  owesSnapshotMaxAgeMs,
  parseMirrorSourceId,
  plannedMirrorSourceIds,
  preflightSplitwiseMirrorAdmission,
  readResolutionsStore,
  resolutionIndex,
  resolveMirrorAccountId,
  snapshotBinding,
  snapshotManifestFingerprint,
  resolveMirrorRowSourceId,
  sourceIdFromImportedId,
  validateResolutionAgainstLive,
  validateReviewedDuplicateLiveState,
  verifyCreateMirrorIdentity,
};
