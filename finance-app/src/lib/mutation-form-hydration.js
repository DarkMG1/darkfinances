/**
 * Draft hydration lifecycle for useMutationForm persistence ordering.
 */

function buildMutationFormIdentityKey(scopeDigest, profileGeneration, formId) {
  return `${scopeDigest}:${profileGeneration}:${formId}`;
}

function shouldPersistMutationFormDraft(
  hydratedIdentity,
  currentIdentity,
  fields,
  baseline,
  fieldsEqual,
  suppressPersist,
) {
  if (suppressPersist) return false;
  if (hydratedIdentity !== currentIdentity) return false;
  if (fieldsEqual(fields, baseline)) return false;
  return true;
}

module.exports = {
  buildMutationFormIdentityKey,
  shouldPersistMutationFormDraft,
};
