'use strict';

const { KnownPreApplyError } = require('./errors');
const {
  REVIEW_CONTENT_VERSION,
  canonicalReviewContent,
  enrichReviewTask,
  expandTransactionTargetEvidence,
  hashPayload,
  legacyRepaymentIdFromKey,
  legacyTxnIdFromKey,
  parseReviewTaskId,
  stableKeyDigest,
  txnImportedId,
} = require('./review-task-fingerprint');

const REVIEW_STATE_SCHEMA_VERSION = 2;
const MAX_NEW_DISPOSITION_ENTRIES = 10000;
const HIDDEN_DISPOSITIONS = new Set(['acknowledge', 'dismiss', 'resolved']);

class ReviewDispositionStaleError extends KnownPreApplyError {
  constructor(message = 'review task content changed — refresh and retry') {
    super(message, { code: 'REVIEW_DISPOSITION_STALE', status: 409 });
    this.name = 'ReviewDispositionStaleError';
  }
}

class ReviewDispositionUnknownError extends KnownPreApplyError {
  constructor(message = 'review task not found') {
    super(message, { code: 'REVIEW_DISPOSITION_UNKNOWN', status: 404 });
    this.name = 'ReviewDispositionUnknownError';
  }
}

class ReviewDispositionAmbiguousError extends KnownPreApplyError {
  constructor(message = 'legacy review disposition is ambiguous') {
    super(message, { code: 'REVIEW_DISPOSITION_AMBIGUOUS', status: 409 });
    this.name = 'ReviewDispositionAmbiguousError';
  }
}

class ReviewDispositionLegacyRefetchError extends KnownPreApplyError {
  constructor(message = 'review task id requires refresh with current content hash') {
    super(message, { code: 'REVIEW_DISPOSITION_LEGACY_REFETCH', status: 409 });
    this.name = 'ReviewDispositionLegacyRefetchError';
  }
}

class ReviewDispositionCapacityError extends KnownPreApplyError {
  constructor(message = 'review disposition store at capacity') {
    super(message, { code: 'REVIEW_DISPOSITION_CAPACITY', status: 409 });
    this.name = 'ReviewDispositionCapacityError';
  }
}

function isPlainObject(value) {
  return !!value && typeof value === 'object' && !Array.isArray(value);
}

function cloneJson(value) {
  return JSON.parse(JSON.stringify(value));
}

function preserveLegacyDispositionValue(raw) {
  if (typeof raw === 'string') return raw;
  if (!isPlainObject(raw)) return null;
  return cloneJson(raw);
}

function normalizeActiveDispositionRecord(raw) {
  if (typeof raw === 'string') {
    return { disposition: raw === 'hidden' ? 'acknowledge' : raw, at: new Date(0).toISOString() };
  }
  if (!isPlainObject(raw)) return null;
  return cloneJson(raw);
}

function normalizeDispositionRecord(raw) {
  return normalizeActiveDispositionRecord(raw);
}

function emptyReviewState() {
  return {
    schemaVersion: REVIEW_STATE_SCHEMA_VERSION,
    contentVersion: REVIEW_CONTENT_VERSION,
    dispositions: {},
    legacyDispositions: {},
  };
}

function normalizeReviewState(raw) {
  if (!isPlainObject(raw)) return emptyReviewState();
  if (raw.schemaVersion === REVIEW_STATE_SCHEMA_VERSION) {
    return {
      schemaVersion: REVIEW_STATE_SCHEMA_VERSION,
      contentVersion: Number.isInteger(raw.contentVersion) ? raw.contentVersion : REVIEW_CONTENT_VERSION,
      dispositions: isPlainObject(raw.dispositions) ? cloneJson(raw.dispositions) : {},
      legacyDispositions: isPlainObject(raw.legacyDispositions) ? cloneJson(raw.legacyDispositions) : {},
    };
  }
  const dispositions = isPlainObject(raw.dispositions) ? raw.dispositions : raw;
  const legacyDispositions = {};
  if (isPlainObject(dispositions)) {
    for (const [key, value] of Object.entries(dispositions)) {
      if (key === 'schemaVersion' || key === 'contentVersion' || key === 'legacyDispositions') continue;
      const preserved = preserveLegacyDispositionValue(value);
      if (preserved != null) legacyDispositions[key] = preserved;
    }
  }
  return {
    schemaVersion: REVIEW_STATE_SCHEMA_VERSION,
    contentVersion: REVIEW_CONTENT_VERSION,
    dispositions: {},
    legacyDispositions,
  };
}

function reviewStateRevision(state) {
  const normalized = normalizeReviewState(state);
  return hashPayload({
    contentVersion: normalized.contentVersion,
    dispositionKeys: Object.keys(normalized.dispositions).sort(),
    legacyKeys: Object.keys(normalized.legacyDispositions).sort(),
  });
}

function buildReviewTaskIndex(tasks) {
  const byStableKey = new Map();
  const byStableKeyDigest = new Map();
  const byLegacyKey = new Map();
  const byTxnId = new Map();
  const bySuggestionId = new Map();

  for (const task of tasks || []) {
    byStableKey.set(task.stableKey, task);
    if (task.stableKeyHash) byStableKeyDigest.set(task.stableKeyHash, task);
    byStableKeyDigest.set(stableKeyDigest(task.stableKey), task);
    byLegacyKey.set(task.stableKey, task);
    byLegacyKey.set(task.id, task);

    const txnId = task.transaction?.id;
    if (txnId) {
      const txnTasks = byTxnId.get(String(txnId)) || [];
      txnTasks.push(task);
      byTxnId.set(String(txnId), txnTasks);
      for (const kind of ['uncategorized', 'large_charge', 'missing_receipt', 'pending']) {
        if (task.kind === kind) byLegacyKey.set(`${kind}:${txnId}`, task);
      }
    }
    if (task.kind === 'repayment') {
      const suggestionId = task.suggestionId || String(task.id || '').replace(/^repayment:/, '').split('@')[0];
      if (suggestionId) {
        bySuggestionId.set(suggestionId, task);
        byLegacyKey.set(`repayment:${suggestionId}`, task);
      }
    }
    if (task.kind === 'price_change' && task.key) byLegacyKey.set(`price:${task.key}`, task);
    if (task.kind === 'reconciliation' && task.month) byLegacyKey.set(`reconcile:${task.month}`, task);
  }

  return { byStableKey, byStableKeyDigest, byLegacyKey, byTxnId, bySuggestionId };
}

function resolveTaskForDispositionId(id, taskIndex) {
  const parsed = parseReviewTaskId(id, taskIndex);
  if (!parsed.legacy) {
    const stableKey = parsed.stableKey || parsed.task?.stableKey;
    const task = parsed.task || (stableKey ? taskIndex.byStableKey.get(stableKey) : null);
    if (task) return { task, parsed };
    throw new ReviewDispositionUnknownError();
  }

  const legacyKey = parsed.legacyKey;
  const direct = taskIndex.byLegacyKey.get(legacyKey);
  if (direct) return { task: direct, parsed: { ...parsed, mappedFromLegacy: true } };

  const txnId = legacyTxnIdFromKey(legacyKey);
  if (txnId) {
    const matches = (taskIndex.byTxnId.get(txnId) || []).filter((task) => legacyKey.startsWith(`${task.kind}:`));
    if (matches.length === 1) return { task: matches[0], parsed: { ...parsed, mappedFromLegacy: true } };
    if (matches.length > 1) throw new ReviewDispositionAmbiguousError();
  }

  const repaymentId = legacyRepaymentIdFromKey(legacyKey);
  if (repaymentId) {
    const match = taskIndex.bySuggestionId.get(repaymentId);
    if (match) return { task: match, parsed: { ...parsed, mappedFromLegacy: true } };
  }

  throw new ReviewDispositionUnknownError();
}

function dispositionCanHide(record) {
  if (!record || typeof record !== 'object') return false;
  return typeof record.contentHash === 'string' && /^[a-f0-9]{64}$/.test(record.contentHash);
}

function dispositionRecordMatchesTask(record, task) {
  if (!record || !task?.contentHash) return false;
  if (!dispositionCanHide(record)) return false;
  if (record.contentHash !== task.contentHash) return false;
  if (record.kind && record.kind !== task.kind) return false;
  return true;
}

function lookupDispositionForTask(state, task, taskIndex) {
  const direct = state.dispositions[task.stableKey];
  if (direct && dispositionRecordMatchesTask(direct, task)) return normalizeActiveDispositionRecord(direct);

  for (const [legacyKey, record] of Object.entries(state.legacyDispositions || {})) {
    let mapped = taskIndex.byLegacyKey.get(legacyKey);
    if (!mapped) {
      const txnId = legacyTxnIdFromKey(legacyKey);
      if (txnId && legacyKey.startsWith(`${task.kind}:`)) {
        const matches = (taskIndex.byTxnId.get(txnId) || []).filter((entry) => entry.kind === task.kind);
        if (matches.length === 1) mapped = matches[0];
      }
    }
    if (!mapped || mapped.stableKey !== task.stableKey) continue;
    const normalized = typeof record === 'string' ? record : normalizeActiveDispositionRecord(record);
    if (!normalized || typeof normalized === 'string') continue;
    if (!dispositionRecordMatchesTask(normalized, task)) continue;
    return normalized;
  }

  return null;
}

function countMigrationRequired(state, taskIndex = null) {
  const normalized = normalizeReviewState(state);
  let count = 0;
  for (const record of Object.values(normalized.legacyDispositions)) {
    if (!dispositionCanHide(record)) count += 1;
    else if (taskIndex) {
      // legacy with hash but not yet promoted counts as zero migration-required for API
    }
  }
  for (const record of Object.values(normalized.dispositions)) {
    if (!dispositionCanHide(record)) count += 1;
  }
  return count;
}

function isReviewTaskVisible(task, state, now = Date.now(), taskIndex = null) {
  const index = taskIndex || buildReviewTaskIndex([task]);
  const saved = lookupDispositionForTask(state, task, index);
  if (!saved) return true;

  if (saved.disposition === 'snooze') {
    const until = Date.parse(saved.until || '');
    if (Number.isFinite(until) && until > now) return false;
    return true;
  }

  if (!HIDDEN_DISPOSITIONS.has(saved.disposition)) return true;
  return !dispositionRecordMatchesTask(saved, task);
}

function collectExpiredSnoozeKeys(state, now = Date.now()) {
  const normalized = normalizeReviewState(state);
  const expired = [];
  for (const bucketName of ['dispositions', 'legacyDispositions']) {
    for (const [key, record] of Object.entries(normalized[bucketName] || {})) {
      if (record?.disposition !== 'snooze') continue;
      const until = Date.parse(record.until || '');
      if (Number.isFinite(until) && until <= now) expired.push({ bucket: bucketName, key, disposition: record.disposition, until: record.until });
    }
  }
  return expired;
}

function pruneExpiredReviewSnoozes(state, now = Date.now()) {
  const next = normalizeReviewState(state);
  let changed = false;
  const pruneBucket = (bucket) => {
    for (const [key, record] of Object.entries(bucket)) {
      if (record?.disposition !== 'snooze') continue;
      const until = Date.parse(record.until || '');
      if (Number.isFinite(until) && until > now) continue;
      delete bucket[key];
      changed = true;
    }
  };
  pruneBucket(next.dispositions);
  pruneBucket(next.legacyDispositions);
  return { state: next, changed };
}

function assertNewDispositionCapacity(state, stableKey) {
  const normalized = normalizeReviewState(state);
  if (normalized.dispositions[stableKey]) return;
  const total = Object.keys(normalized.dispositions).length + Object.keys(normalized.legacyDispositions).length;
  if (total >= MAX_NEW_DISPOSITION_ENTRIES) {
    throw new ReviewDispositionCapacityError();
  }
}

function preflightReviewDispositionAdmission(state, payload, { taskIndex, now = Date.now() } = {}) {
  const { id, disposition, contentHash } = payload || {};
  if (!id) throw new Error('review task id required');

  const normalized = normalizeReviewState(state);

  if (disposition === 'clear') {
    return { state: normalized, revision: reviewStateRevision(normalized), admitted: true };
  }

  const { task, parsed } = resolveTaskForDispositionId(id, taskIndex);

  if (parsed.legacy || parsed.mappedFromLegacy) {
    if (!contentHash) {
      throw new ReviewDispositionLegacyRefetchError();
    }
    if (contentHash !== task.contentHash) {
      throw new ReviewDispositionStaleError();
    }
  }

  if (contentHash && contentHash !== task.contentHash) {
    throw new ReviewDispositionStaleError();
  }

  if (!parsed.legacy && parsed.contentHash && parsed.contentHash !== task.contentHash) {
    throw new ReviewDispositionStaleError();
  }

  assertNewDispositionCapacity(normalized, task.stableKey);

  const saved = lookupDispositionForTask(normalized, task, taskIndex);
  if (saved?.disposition === 'snooze') {
    const until = Date.parse(saved.until || '');
    if (Number.isFinite(until) && until <= now) {
      // expired snooze visible; admission proceeds and post-write prune clears it
    }
  }

  return {
    state: normalized,
    revision: reviewStateRevision(normalized),
    task,
    parsed,
    admitted: true,
  };
}

function applyReviewDisposition(state, payload, { taskIndex, now = Date.now(), preflight } = {}) {
  const { id, disposition, until, note, contentHash } = payload || {};
  if (!id) throw new Error('review task id required');

  const admission = preflight || preflightReviewDispositionAdmission(state, payload, { taskIndex, now });
  let next = normalizeReviewState(admission.state);

  if (disposition === 'clear') {
    const parsed = parseReviewTaskId(id, taskIndex);
    if (!parsed.legacy && parsed.stableKey) delete next.dispositions[parsed.stableKey];
    if (parsed.stableKeyDigest) {
      const task = taskIndex.byStableKeyDigest.get(parsed.stableKeyDigest);
      if (task) delete next.dispositions[task.stableKey];
    }
    delete next.legacyDispositions[parsed.legacyKey || id];
    ({ state: next } = pruneExpiredReviewSnoozes(next, now));
    return { state: next, id, disposition };
  }

  const { task, parsed } = admission.task
    ? { task: admission.task, parsed: admission.parsed }
    : resolveTaskForDispositionId(id, taskIndex);

  next.dispositions[task.stableKey] = {
    disposition,
    at: new Date(now).toISOString(),
    kind: task.kind,
    contentHash: task.contentHash,
    contentVersion: task.contentVersion,
    stableKey: task.stableKey,
    stableKeyHash: task.stableKeyHash || stableKeyDigest(task.stableKey),
    ...(until ? { until } : {}),
    ...(note ? { note } : {}),
  };
  if (parsed.legacyKey) delete next.legacyDispositions[parsed.legacyKey];
  ({ state: next } = pruneExpiredReviewSnoozes(next, now));

  return { state: next, id: task.id, disposition, stableKey: task.stableKey };
}

function compareAndSwapReviewStateMaintenance(state, { expectedRevision, expiredSnoozeKeys = [], now = Date.now() } = {}) {
  const normalized = normalizeReviewState(state);
  if (expectedRevision && reviewStateRevision(normalized) !== expectedRevision) {
    return { state: normalized, changed: false, conflict: true };
  }

  let next = cloneJson(normalized);
  let changed = false;

  for (const entry of expiredSnoozeKeys) {
    const bucket = entry?.bucket;
    const key = entry?.key;
    const record = next[bucket]?.[key];
    if (!record || record.disposition !== 'snooze') continue;
    const until = Date.parse(record.until || '');
    if (!Number.isFinite(until) || until > now) continue;
    if (entry.until && entry.until !== record.until) continue;
    delete next[bucket][key];
    changed = true;
  }

  const pruned = pruneExpiredReviewSnoozes(next, now);
  if (pruned.changed) {
    next = pruned.state;
    changed = true;
  }

  return { state: next, changed, conflict: false };
}

function invalidateReviewDispositionsForTargets(reviewState, { targetIds = [], importedIds = [], stableKeys = [] } = {}) {
  const next = normalizeReviewState(reviewState);
  const stats = { reviewState: 0 };
  const targets = new Set((targetIds || []).map(String));
  const imports = new Set((importedIds || []).map(String));
  const keys = new Set((stableKeys || []).map(String));

  const refers = (key, record) => {
    const keyStr = String(key || '');
    if (keys.has(keyStr)) return true;
    if (record?.stableKey && keys.has(String(record.stableKey))) return true;
    for (const id of targets) {
      if (keyStr.includes(`:id:${id}`) || keyStr.includes(`:leg:${id}:`) || keyStr.includes(`:imported:${id}`)) return true;
      if (keyStr.endsWith(`:${id}`)) return true;
      if (keyStr === `uncategorized:${id}` || keyStr === `large_charge:${id}` || keyStr === `missing_receipt:${id}` || keyStr === `pending:${id}`) return true;
    }
    for (const imported of imports) {
      if (keyStr.includes(`:imported:${imported}`) || keyStr.includes(`ambiguousImport:${imported}`)) return true;
    }
    return false;
  };

  for (const bucketName of ['dispositions', 'legacyDispositions']) {
    for (const key of Object.keys(next[bucketName])) {
      if (!refers(key, next[bucketName][key])) continue;
      delete next[bucketName][key];
      stats.reviewState += 1;
    }
  }

  return { reviewState: next, stats };
}

function rewriteStableKeyWithIdMap(stableKey, idMap) {
  let next = String(stableKey || '');
  for (const [oldId, newId] of Object.entries(idMap || {})) {
    next = next.split(`:id:${oldId}`).join(`:id:${newId}`);
    next = next.replace(new RegExp(`:leg:((?:[^:]+(?::[^:]+)*)):${oldId}$`, 'g'), `:leg:$1:${newId}`);
  }
  return next;
}

function rewriteLegacyKeyWithIdMap(legacyKey, idMap) {
  let next = String(legacyKey || '');
  for (const [oldId, newId] of Object.entries(idMap || {})) {
    for (const prefix of ['uncategorized', 'large_charge', 'missing_receipt', 'pending']) {
      const needle = `${prefix}:${oldId}`;
      if (next === needle) next = `${prefix}:${newId}`;
      if (next === `${prefix}:id:${oldId}`) next = `${prefix}:id:${newId}`;
    }
    const repaymentNeedle = `repayment:sg_${oldId}`;
    if (next === repaymentNeedle) next = `repayment:sg_${newId}`;
    if (next === `repayment:${oldId}`) next = `repayment:${newId}`;
  }
  return next;
}

function assignWithoutLoss(target, key, value, label) {
  if (Object.prototype.hasOwnProperty.call(target, key)
    && JSON.stringify(target[key]) !== JSON.stringify(value)) {
    throw new Error(`${label} reference migration would overwrite distinct evidence`);
  }
  target[key] = value;
}

function reviewTaskSemanticContentEqual(left, right) {
  if (!left || !right || left.kind !== right.kind) return false;
  if (left.contentHash === right.contentHash) return true;
  const leftContent = canonicalReviewContent(left, left._fingerprintContext || {});
  const rightContent = canonicalReviewContent(right, right._fingerprintContext || {});
  const stripIdentity = (content) => {
    const { anchor, contentAnchor, ...rest } = content;
    return rest;
  };
  return JSON.stringify(stripIdentity(leftContent)) === JSON.stringify(stripIdentity(rightContent));
}

function rewriteReviewDispositionsForReplacement(reviewState, idMap, { tasksBefore = [], tasksAfter = [] } = {}) {
  const stats = { reviewState: 0 };
  const next = normalizeReviewState(reviewState);
  const beforeIndex = buildReviewTaskIndex(tasksBefore);
  const afterIndex = buildReviewTaskIndex(tasksAfter);

  const rewriteBucket = (bucket, label) => {
    const rewritten = {};
    for (const [key, record] of Object.entries(bucket)) {
      const nextKey = key.includes(':id:') || key.includes(':leg:') || key.includes(':imported:')
        ? rewriteStableKeyWithIdMap(key, idMap)
        : rewriteLegacyKeyWithIdMap(key, idMap);
      const nextRecord = cloneJson(record);

      const beforeTask = beforeIndex.byStableKey.get(key) || beforeIndex.byLegacyKey.get(key);
      let afterTask = afterIndex.byStableKey.get(nextKey) || afterIndex.byLegacyKey.get(nextKey);
      if (!afterTask && beforeTask) {
        afterTask = afterIndex.byStableKey.get(rewriteStableKeyWithIdMap(beforeTask.stableKey, idMap));
      }

      if (!afterTask) {
        stats.reviewState += 1;
        continue;
      }

      const explicitHashMatch = record.contentHash === afterTask.contentHash;
      const semanticMatch = beforeTask && afterTask && reviewTaskSemanticContentEqual(beforeTask, afterTask);

      if (beforeTask && afterTask && (beforeTask.contentHash === afterTask.contentHash || semanticMatch)) {
        nextRecord.kind = afterTask.kind;
        nextRecord.contentHash = afterTask.contentHash;
        nextRecord.contentVersion = afterTask.contentVersion;
        nextRecord.stableKey = afterTask.stableKey;
        nextRecord.stableKeyHash = afterTask.stableKeyHash || stableKeyDigest(afterTask.stableKey);
        assignWithoutLoss(rewritten, afterTask.stableKey, nextRecord, label);
        if (nextKey !== key || afterTask.stableKey !== key) stats.reviewState += 1;
        continue;
      }

      if (!explicitHashMatch && !semanticMatch && record.contentHash && record.contentHash !== afterTask.contentHash) {
        stats.reviewState += 1;
        continue;
      }

      if (!explicitHashMatch && !semanticMatch && beforeTask && beforeTask.contentHash !== afterTask.contentHash) {
        stats.reviewState += 1;
        continue;
      }

      if (afterTask) {
        nextRecord.kind = afterTask.kind;
        nextRecord.contentHash = afterTask.contentHash;
        nextRecord.contentVersion = afterTask.contentVersion;
        nextRecord.stableKey = afterTask.stableKey;
        nextRecord.stableKeyHash = afterTask.stableKeyHash || stableKeyDigest(afterTask.stableKey);
        assignWithoutLoss(rewritten, afterTask.stableKey, nextRecord, label);
      }
      if (nextKey !== key) stats.reviewState += 1;
    }
    return rewritten;
  };

  next.dispositions = rewriteBucket(next.dispositions, 'review disposition');
  next.legacyDispositions = rewriteBucket(next.legacyDispositions, 'legacy review disposition');
  return { reviewState: next, stats };
}

function dispositionRefersToEvidence(key, record, { targets, importedIds }) {
  const keyStr = String(key || '');
  for (const id of targets) {
    if (keyStr.includes(`:id:${id}`) || keyStr.includes(`:imported:${id}`)) return true;
    if (keyStr.endsWith(`:${id}`)) return true;
    if (keyStr.includes(':leg:') && new RegExp(`:leg:(?:[^:]+(?::[^:]+)*)?:${id}$`).test(keyStr)) return true;
    for (const prefix of ['uncategorized', 'large_charge', 'missing_receipt', 'pending']) {
      if (keyStr === `${prefix}:${id}` || keyStr === `${prefix}:id:${id}`) return true;
    }
    if (keyStr === `repayment:sg_${id}` || keyStr === `repayment:${id}`) return true;
  }
  for (const imported of importedIds) {
    if (keyStr.includes(`:imported:${imported}`) || keyStr.includes(`ambiguousImport:${imported}`)) return true;
  }
  if (record?.stableKey) {
    return dispositionRefersToEvidence(record.stableKey, null, { targets, importedIds });
  }
  if (record?.stableId) {
    return dispositionRefersToEvidence(record.stableId, null, { targets, importedIds });
  }
  return false;
}

function normalizeDeletionTargetEvidence(targetEvidence) {
  if (Array.isArray(targetEvidence)) {
    return { targets: targetEvidence.map(String), importedIds: [], transactions: [] };
  }
  if (targetEvidence?.snapshot) {
    const { expandDeletionSnapshotEvidence } = require('./review-task-fingerprint');
    return expandDeletionSnapshotEvidence(targetEvidence.snapshot);
  }
  if (targetEvidence?.transactions) {
    return expandTransactionTargetEvidence(targetEvidence.transactions);
  }
  return expandTransactionTargetEvidence([]);
}

function rewriteReviewDispositionsForDeletion(reviewState, targetEvidence) {
  const stats = { reviewState: 0 };
  const next = normalizeReviewState(reviewState);
  const expanded = normalizeDeletionTargetEvidence(targetEvidence);
  const targets = new Set(expanded.targets || []);
  const importedIds = new Set(expanded.importedIds || []);

  for (const bucketName of ['dispositions', 'legacyDispositions']) {
    for (const key of Object.keys(next[bucketName])) {
      const record = next[bucketName][key];
      if (!dispositionRefersToEvidence(key, record, { targets, importedIds })) continue;
      delete next[bucketName][key];
      stats.reviewState += 1;
    }
  }

  return { reviewState: next, stats };
}

function filterVisibleReviewTasks(tasks, state, now = Date.now()) {
  const normalized = normalizeReviewState(state);
  const taskIndex = buildReviewTaskIndex(tasks);
  return tasks.filter((task) => isReviewTaskVisible(task, normalized, now, taskIndex));
}

module.exports = {
  MAX_NEW_DISPOSITION_ENTRIES,
  REVIEW_STATE_SCHEMA_VERSION,
  ReviewDispositionAmbiguousError,
  ReviewDispositionCapacityError,
  ReviewDispositionLegacyRefetchError,
  ReviewDispositionStaleError,
  ReviewDispositionUnknownError,
  applyReviewDisposition,
  buildReviewTaskIndex,
  collectExpiredSnoozeKeys,
  compareAndSwapReviewStateMaintenance,
  countMigrationRequired,
  emptyReviewState,
  filterVisibleReviewTasks,
  invalidateReviewDispositionsForTargets,
  isReviewTaskVisible,
  lookupDispositionForTask,
  normalizeReviewState,
  preserveLegacyDispositionValue,
  normalizeActiveDispositionRecord,
  preflightReviewDispositionAdmission,
  pruneExpiredReviewSnoozes,
  resolveTaskForDispositionId,
  reviewStateRevision,
  rewriteReviewDispositionsForDeletion,
  rewriteReviewDispositionsForReplacement,
};
