/**
 * Draft hydration lifecycle for useMutationForm persistence ordering.
 */

function buildMutationFormIdentityKey(scopeDigest, profileGeneration, formId) {
  return `${scopeDigest}:${profileGeneration}:${formId}`;
}

function shouldMarkHydrationReady(hydrationTargetIdentity, currentIdentity, fields, target, fieldsEqual) {
  if (hydrationTargetIdentity !== currentIdentity) return false;
  if (target == null) return false;
  return fieldsEqual(fields, target);
}

function shouldPersistMutationFormDraft(
  hydrationReadyIdentity,
  currentIdentity,
  fields,
  baseline,
  fieldsEqual,
  suppressPersist,
) {
  if (suppressPersist) return false;
  if (hydrationReadyIdentity !== currentIdentity) return false;
  if (fieldsEqual(fields, baseline)) return false;
  return true;
}

module.exports = {
  buildMutationFormIdentityKey,
  shouldMarkHydrationReady,
  shouldPersistMutationFormDraft,
};
