/**
 * In-memory mutation form drafts keyed by profile scope + generation + form id.
 * Cleared on profile purge; never persisted to disk (sensitive values stripped).
 */

const { getProfileGeneration } = require('./notification-reconciliation');

const draftsByScope = new Map();
const SENSITIVE_KEY = /base64|secret|token|password|authorization|receipt|image/i;

function scopeKey(scopeDigest, profileGeneration, formId) {
  return `${String(scopeDigest || 'demo')}:${String(profileGeneration ?? getProfileGeneration())}:${String(formId || 'default')}`;
}

function sanitizeDraftValues(values) {
  if (!values || typeof values !== 'object' || Array.isArray(values)) return {};
  const next = Object.create(null);
  for (const [key, value] of Object.entries(values)) {
    if (SENSITIVE_KEY.test(key)) continue;
    if (typeof value === 'string' && value.length > 4096) continue;
    next[key] = value;
  }
  return { ...next };
}

function getMutationFormDraft(scopeDigest, formId, profileGeneration) {
  const key = scopeKey(scopeDigest, profileGeneration, formId);
  const scope = key.split(':')[0];
  const bucket = draftsByScope.get(scope);
  if (!bucket) return null;
  const entry = bucket.get(key);
  return entry ? JSON.parse(JSON.stringify(entry)) : null;
}

function setMutationFormDraft(scopeDigest, formId, values, profileGeneration) {
  const key = scopeKey(scopeDigest, profileGeneration, formId);
  const scope = key.split(':')[0];
  if (!draftsByScope.has(scope)) draftsByScope.set(scope, new Map());
  draftsByScope.get(scope).set(key, sanitizeDraftValues(values));
}

function clearMutationFormDraft(scopeDigest, formId, profileGeneration) {
  const scope = String(scopeDigest || 'demo');
  const bucket = draftsByScope.get(scope);
  if (!bucket) return;
  if (formId == null) {
    draftsByScope.delete(scope);
    return;
  }
  const key = scopeKey(scopeDigest, profileGeneration, formId);
  bucket.delete(key);
  if (bucket.size === 0) draftsByScope.delete(scope);
}

function purgeMutationFormDrafts(scopeDigest) {
  if (scopeDigest) {
    draftsByScope.delete(String(scopeDigest));
    return;
  }
  draftsByScope.clear();
}

module.exports = {
  clearMutationFormDraft,
  getMutationFormDraft,
  purgeMutationFormDrafts,
  sanitizeDraftValues,
  scopeKey,
  setMutationFormDraft,
};
