'use strict';

const { KnownPreApplyError } = require('./errors');
const {
  REVIEW_CONTENT_VERSION,
  enrichReviewTask,
  legacyRepaymentIdFromKey,
  legacyTxnIdFromKey,
  parseReviewTaskId,
  reviewTaskStableKey,
} = require('./review-task-fingerprint');

const REVIEW_STATE_SCHEMA_VERSION = 2;
const MAX_LEGACY_DISPOSITIONS = 5000;
const HIDDEN_DISPOSITIONS = new Set(['acknowledge', 'dismiss', 'resolved']);

class ReviewDispositionStaleError extends KnownPreApplyError {
  constructor(message = 'review task content changed — refresh and retry') {
    super(message, { code: 'REVIEW_DISPOSITION_STALE', status: 409 });
    this.name = 'ReviewDispositionStaleError';
  }
}

class ReviewDispositionUnknownError extends KnownPreApplyError {
  constructor(message = 'review task not found') {
    super(message, { code: 'REVIEW_DISPOSITION_UNKNOWN', status: 409 });
    this.name = 'ReviewDispositionUnknownError';
  }
}

class ReviewDispositionAmbiguousError extends KnownPreApplyError {
  constructor(message = 'legacy review disposition is ambiguous') {
    super(message, { code: 'REVIEW_DISPOSITION_AMBIGUOUS', status: 409 });
    this.name = 'ReviewDispositionAmbiguousError';
  }
}

function isPlainObject(value) {
  return !!value && typeof value === 'object' && !Array.isArray(value);
}

function cloneJson(value) {
  return JSON.parse(JSON.stringify(value));
}

function normalizeDispositionRecord(raw) {
  if (typeof raw === 'string') {
    if (raw === 'hidden') return { disposition: 'acknowledge', at: new Date(0).toISOString() };
    return { disposition: raw, at: new Date(0).toISOString() };
  }
  if (!isPlainObject(raw)) return null;
  return cloneJson(raw);
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
      const normalized = normalizeDispositionRecord(value);
      if (normalized) legacyDispositions[key] = normalized;
    }
  }
  return {
    schemaVersion: REVIEW_STATE_SCHEMA_VERSION,
    contentVersion: REVIEW_CONTENT_VERSION,
    dispositions: {},
    legacyDispositions: boundLegacyBucket(legacyDispositions),
  };
}

function boundLegacyBucket(legacyDispositions) {
  const entries = Object.entries(legacyDispositions || {});
  if (entries.length <= MAX_LEGACY_DISPOSITIONS) return Object.fromEntries(entries);
  entries.sort((left, right) => String(right[1]?.at || '').localeCompare(String(left[1]?.at || '')));
  return Object.fromEntries(entries.slice(0, MAX_LEGACY_DISPOSITIONS));
}

function buildReviewTaskIndex(tasks) {
  const byStableKey = new Map();
  const byLegacyKey = new Map();
  const byTxnId = new Map();
  const bySuggestionId = new Map();

  for (const task of tasks || []) {
    byStableKey.set(task.stableKey, task);
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

  return { byStableKey, byLegacyKey, byTxnId, bySuggestionId };
}

function resolveTaskForDispositionId(id, taskIndex) {
  const parsed = parseReviewTaskId(id);
  if (!parsed.legacy && parsed.stableKey) {
    const exact = taskIndex.byStableKey.get(parsed.stableKey);
    if (exact) return { task: exact, parsed };
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

function dispositionRecordMatchesTask(record, task) {
  if (!record) return false;
  if (record.contentHash && record.contentHash !== task.contentHash) return false;
  if (record.kind && record.kind !== task.kind) return false;
  return true;
}

function lookupDispositionForTask(state, task, taskIndex) {
  const direct = state.dispositions[task.stableKey];
  if (direct && dispositionRecordMatchesTask(direct, task)) return direct;

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
    if (!dispositionRecordMatchesTask(record, task)) continue;
    return record;
  }

  return null;
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
  return saved.contentHash !== task.contentHash;
}

function collectExpiredSnoozeKeys(state, now = Date.now()) {
  const normalized = normalizeReviewState(state);
  const expired = [];
  for (const bucketName of ['dispositions', 'legacyDispositions']) {
    for (const [key, record] of Object.entries(normalized[bucketName] || {})) {
      if (record?.disposition !== 'snooze') continue;
      const until = Date.parse(record.until || '');
      if (Number.isFinite(until) && until <= now) expired.push({ bucket: bucketName, key });
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

function migrateResolvedLegacyEntries(state, taskIndex) {
  const next = normalizeReviewState(state);
  let changed = false;
  for (const [legacyKey, record] of Object.entries(next.legacyDispositions)) {
    let task = next.legacyDispositions === state.legacyDispositions ? null : null;
    try {
      ({ task } = resolveTaskForDispositionId(legacyKey, taskIndex));
    } catch {
      continue;
    }
    if (!task || !dispositionRecordMatchesTask(record, task)) continue;
    if (next.dispositions[task.stableKey]) continue;
    next.dispositions[task.stableKey] = {
      ...record,
      kind: task.kind,
      contentHash: task.contentHash,
      contentVersion: task.contentVersion,
    };
    delete next.legacyDispositions[legacyKey];
    changed = true;
  }
  return { state: next, changed };
}

function applyReviewDisposition(state, payload, { taskIndex, now = Date.now() } = {}) {
  const { id, disposition, until, note, contentHash } = payload || {};
  if (!id) throw new Error('review task id required');

  let next = normalizeReviewState(state);
  ({ state: next } = pruneExpiredReviewSnoozes(next, now));

  if (disposition === 'clear') {
    const parsed = parseReviewTaskId(id);
    if (!parsed.legacy && parsed.stableKey) {
      delete next.dispositions[parsed.stableKey];
    }
    delete next.legacyDispositions[parsed.legacyKey || id];
    return { state: next, id, disposition };
  }

  const { task, parsed } = resolveTaskForDispositionId(id, taskIndex);
  if (contentHash && contentHash !== task.contentHash) {
    throw new ReviewDispositionStaleError();
  }
  if (!parsed.legacy && parsed.contentHash && parsed.contentHash !== task.contentHash) {
    throw new ReviewDispositionStaleError();
  }
  if (parsed.legacy && parsed.contentHash && parsed.contentHash !== task.contentHash) {
    throw new ReviewDispositionStaleError();
  }

  next.dispositions[task.stableKey] = {
    disposition,
    at: new Date(now).toISOString(),
    kind: task.kind,
    contentHash: task.contentHash,
    contentVersion: task.contentVersion,
    ...(until ? { until } : {}),
    ...(note ? { note } : {}),
  };
  if (parsed.legacyKey) delete next.legacyDispositions[parsed.legacyKey];

  return { state: next, id: task.id, disposition, stableKey: task.stableKey };
}

function rewriteStableKeyWithIdMap(stableKey, idMap) {
  let next = String(stableKey || '');
  for (const [oldId, newId] of Object.entries(idMap || {})) {
    next = next.split(`:id:${oldId}`).join(`:id:${newId}`);
    next = next.split(`:leg:${oldId}:`).join(`:leg:${newId}:`);
  }
  return next;
}

function rewriteLegacyKeyWithIdMap(legacyKey, idMap) {
  let next = String(legacyKey || '');
  for (const [oldId, newId] of Object.entries(idMap || {})) {
    for (const prefix of ['uncategorized', 'large_charge', 'missing_receipt', 'pending']) {
      const needle = `${prefix}:${oldId}`;
      if (next === needle) next = `${prefix}:${newId}`;
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

function rewriteReviewDispositionsForReplacement(reviewState, idMap, { tasksBefore = [], tasksAfter = [] } = {}) {
  const stats = { reviewState: 0 };
  const next = normalizeReviewState(reviewState);
  const beforeIndex = buildReviewTaskIndex(tasksBefore);
  const afterIndex = buildReviewTaskIndex(tasksAfter);

  const rewriteBucket = (bucket, label) => {
    const rewritten = {};
    for (const [key, record] of Object.entries(bucket)) {
      const nextKey = key.includes(':id:') || key.includes(':leg:')
        ? rewriteStableKeyWithIdMap(key, idMap)
        : rewriteLegacyKeyWithIdMap(key, idMap);
      let nextRecord = cloneJson(record);

      const beforeTask = beforeIndex.byStableKey.get(key) || beforeIndex.byLegacyKey.get(key);
      const afterTask = afterIndex.byStableKey.get(nextKey)
        || afterIndex.byLegacyKey.get(nextKey)
        || (beforeTask ? afterIndex.byStableKey.get(rewriteStableKeyWithIdMap(beforeTask.stableKey, idMap)) : null);

      if (!afterTask) {
        if (nextKey !== key) {
          assignWithoutLoss(rewritten, nextKey, nextRecord, label);
          if (nextKey !== key || JSON.stringify(nextRecord) !== JSON.stringify(record)) stats.reviewState += 1;
          continue;
        }
        stats.reviewState += 1;
        continue;
      }
      if (record.contentHash && record.contentHash !== afterTask.contentHash) {
        stats.reviewState += 1;
        continue;
      }
      if (beforeTask && afterTask && beforeTask.contentHash !== afterTask.contentHash) {
        stats.reviewState += 1;
        continue;
      }
      if (afterTask) {
        nextRecord = {
          ...nextRecord,
          kind: afterTask.kind,
          contentHash: afterTask.contentHash,
          contentVersion: afterTask.contentVersion,
        };
      }
      if (nextKey !== key || JSON.stringify(nextRecord) !== JSON.stringify(record)) stats.reviewState += 1;
      assignWithoutLoss(rewritten, nextKey, nextRecord, label);
    }
    return rewritten;
  };

  next.dispositions = rewriteBucket(next.dispositions, 'review disposition');
  next.legacyDispositions = rewriteBucket(next.legacyDispositions, 'legacy review disposition');
  return { reviewState: next, stats };
}

function stableKeyRefersToTarget(stableKey, targets) {
  const key = String(stableKey || '');
  for (const id of targets) {
    if (key.includes(`:id:${id}`) || key.includes(`:leg:${id}:`) || key.includes(`:imported:${id}`)) return true;
    if (key.endsWith(`:${id}`)) return true;
  }
  return false;
}

function legacyKeyRefersToTarget(legacyKey, targets) {
  const key = String(legacyKey || '');
  for (const id of targets) {
    for (const prefix of ['uncategorized', 'large_charge', 'missing_receipt', 'pending']) {
      if (key === `${prefix}:${id}`) return true;
    }
    if (key === `repayment:sg_${id}` || key === `repayment:${id}`) return true;
  }
  return false;
}

function rewriteReviewDispositionsForDeletion(reviewState, targetIds) {
  const stats = { reviewState: 0 };
  const next = normalizeReviewState(reviewState);
  const targets = new Set((targetIds || []).map(String));

  for (const key of Object.keys(next.dispositions)) {
    if (!stableKeyRefersToTarget(key, targets)) continue;
    delete next.dispositions[key];
    stats.reviewState += 1;
  }
  for (const key of Object.keys(next.legacyDispositions)) {
    if (!legacyKeyRefersToTarget(key, targets)) continue;
    delete next.legacyDispositions[key];
    stats.reviewState += 1;
  }

  return { reviewState: next, stats };
}

function filterVisibleReviewTasks(tasks, state, now = Date.now()) {
  const normalized = normalizeReviewState(state);
  const taskIndex = buildReviewTaskIndex(tasks);
  return tasks.filter((task) => isReviewTaskVisible(task, normalized, now, taskIndex));
}

module.exports = {
  MAX_LEGACY_DISPOSITIONS,
  REVIEW_STATE_SCHEMA_VERSION,
  ReviewDispositionAmbiguousError,
  ReviewDispositionStaleError,
  ReviewDispositionUnknownError,
  applyReviewDisposition,
  boundLegacyBucket,
  buildReviewTaskIndex,
  collectExpiredSnoozeKeys,
  emptyReviewState,
  filterVisibleReviewTasks,
  isReviewTaskVisible,
  lookupDispositionForTask,
  migrateResolvedLegacyEntries,
  normalizeReviewState,
  pruneExpiredReviewSnoozes,
  resolveTaskForDispositionId,
  rewriteReviewDispositionsForDeletion,
  rewriteReviewDispositionsForReplacement,
};
