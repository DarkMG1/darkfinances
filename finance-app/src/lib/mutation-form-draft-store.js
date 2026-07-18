/**
 * In-memory mutation form drafts keyed by profile scope + generation + form id.
 * Cleared on profile purge; never persisted to disk (sensitive values stripped).
 */

const { getProfileGeneration } = require('./notification-reconciliation');

const draftsByScope = new Map();
const lruByScope = new Map();
const SENSITIVE_KEY = /base64|secret|token|password|authorization|receipt|image|auth|credential|bearer|apikey|api_key/i;
const BASE64_LIKE = /^[A-Za-z0-9+/=\s]{256,}$/;
const DATA_URI = /^data:[^;]+;base64,/i;

const MAX_DRAFTS_PER_SCOPE = 32;
const MAX_DRAFTS_GLOBAL = 256;

function scopeKey(scopeDigest, profileGeneration, formId) {
  return `${String(scopeDigest || 'demo')}:${String(profileGeneration ?? getProfileGeneration())}:${String(formId || 'default')}`;
}

function isSensitiveValue(value) {
  if (typeof value !== 'string') return false;
  if (value.length > 4096) return true;
  if (DATA_URI.test(value)) return true;
  if (BASE64_LIKE.test(value)) return true;
  return false;
}

function sanitizeDraftNode(node) {
  if (node == null) return node;
  if (Array.isArray(node)) {
    return node
      .map((item) => sanitizeDraftNode(item))
      .filter((item) => item !== undefined);
  }
  if (typeof node !== 'object') {
    if (isSensitiveValue(node)) return undefined;
    return node;
  }
  const next = {};
  for (const [key, value] of Object.entries(node)) {
    if (SENSITIVE_KEY.test(key)) continue;
    if (isSensitiveValue(value)) continue;
    const sanitized = sanitizeDraftNode(value);
    if (sanitized !== undefined) next[key] = sanitized;
  }
  return next;
}

function sanitizeDraftValues(values) {
  if (!values || typeof values !== 'object' || Array.isArray(values)) return {};
  const sanitized = sanitizeDraftNode(values);
  return sanitized && typeof sanitized === 'object' && !Array.isArray(sanitized)
    ? { ...sanitized }
    : {};
}

function touchLru(scope, key) {
  if (!lruByScope.has(scope)) lruByScope.set(scope, []);
  const order = lruByScope.get(scope).filter((entry) => entry !== key);
  order.push(key);
  lruByScope.set(scope, order);
}

function evictDrafts(scope) {
  const bucket = draftsByScope.get(scope);
  const order = lruByScope.get(scope) || [];
  if (!bucket) return;
  while (order.length > MAX_DRAFTS_PER_SCOPE) {
    const evictKey = order.shift();
    bucket.delete(evictKey);
  }
  lruByScope.set(scope, order);
  let globalCount = 0;
  for (const map of draftsByScope.values()) globalCount += map.size;
  while (globalCount > MAX_DRAFTS_GLOBAL && order.length) {
    const evictKey = order.shift();
    if (bucket.delete(evictKey)) globalCount -= 1;
  }
}

function getMutationFormDraft(scopeDigest, formId, profileGeneration) {
  const key = scopeKey(scopeDigest, profileGeneration, formId);
  const scope = key.split(':')[0];
  const bucket = draftsByScope.get(scope);
  if (!bucket) return null;
  const entry = bucket.get(key);
  if (!entry) return null;
  touchLru(scope, key);
  return JSON.parse(JSON.stringify(entry));
}

function setMutationFormDraft(scopeDigest, formId, values, profileGeneration) {
  const key = scopeKey(scopeDigest, profileGeneration, formId);
  const scope = key.split(':')[0];
  if (!draftsByScope.has(scope)) draftsByScope.set(scope, new Map());
  draftsByScope.get(scope).set(key, sanitizeDraftValues(values));
  touchLru(scope, key);
  evictDrafts(scope);
}

function clearMutationFormDraft(scopeDigest, formId, profileGeneration) {
  const scope = String(scopeDigest || 'demo');
  const bucket = draftsByScope.get(scope);
  if (!bucket) return;
  if (formId == null) {
    draftsByScope.delete(scope);
    lruByScope.delete(scope);
    return;
  }
  const key = scopeKey(scopeDigest, profileGeneration, formId);
  bucket.delete(key);
  const order = lruByScope.get(scope);
  if (order) lruByScope.set(scope, order.filter((entry) => entry !== key));
  if (bucket.size === 0) {
    draftsByScope.delete(scope);
    lruByScope.delete(scope);
  }
}

function purgeMutationFormDrafts(scopeDigest) {
  if (scopeDigest) {
    draftsByScope.delete(String(scopeDigest));
    lruByScope.delete(String(scopeDigest));
    return;
  }
  draftsByScope.clear();
  lruByScope.clear();
}

module.exports = {
  MAX_DRAFTS_GLOBAL,
  MAX_DRAFTS_PER_SCOPE,
  clearMutationFormDraft,
  getMutationFormDraft,
  purgeMutationFormDrafts,
  sanitizeDraftValues,
  scopeKey,
  setMutationFormDraft,
};
