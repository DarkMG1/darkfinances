/**
 * In-memory mutation form drafts keyed by profile scope + form id.
 * Cleared on profile purge; never persisted to disk (sensitive values).
 */

const draftsByScope = new Map();

function scopeKey(scopeDigest, formId) {
  return `${String(scopeDigest || 'demo')}:${String(formId || 'default')}`;
}

function getMutationFormDraft(scopeDigest, formId) {
  const bucket = draftsByScope.get(String(scopeDigest || 'demo'));
  if (!bucket) return null;
  const entry = bucket.get(String(formId));
  return entry ? JSON.parse(JSON.stringify(entry)) : null;
}

function setMutationFormDraft(scopeDigest, formId, values) {
  const scope = String(scopeDigest || 'demo');
  if (!draftsByScope.has(scope)) draftsByScope.set(scope, new Map());
  draftsByScope.get(scope).set(String(formId), JSON.parse(JSON.stringify(values)));
}

function clearMutationFormDraft(scopeDigest, formId) {
  const scope = String(scopeDigest || 'demo');
  const bucket = draftsByScope.get(scope);
  if (!bucket) return;
  if (formId == null) {
    draftsByScope.delete(scope);
    return;
  }
  bucket.delete(String(formId));
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
  scopeKey,
  setMutationFormDraft,
};
