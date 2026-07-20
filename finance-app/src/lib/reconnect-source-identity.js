'use strict';

const { canonicalJson } = require('./request-operation-state');

/**
 * @typedef {{
 *   cacheGeneration: number;
 *   sourceObservedRevision: string | null;
 *   sourceObservedAt: number;
 *   deployIdentity: string | null;
 *   probeKind: string | null;
 * }} SourceIdentity
 */

function asNonNegativeInt(value) {
  const candidate = Number(value);
  return Number.isInteger(candidate) && candidate >= 0 ? candidate : null;
}

/**
 * Extracts confirmed source identity from reconnect-freshness probe evidence.
 * @param {Record<string, unknown> | null | undefined} payload
 * @returns {SourceIdentity | null}
 */
function extractSourceIdentity(payload) {
  if (!payload || typeof payload !== 'object') return null;

  const cacheGeneration = asNonNegativeInt(payload.cacheGenerationAfter);
  if (cacheGeneration == null) return null;

  return {
    cacheGeneration,
    sourceObservedRevision: typeof payload.sourceObservedRevision === 'string'
      ? payload.sourceObservedRevision
      : null,
    sourceObservedAt: asNonNegativeInt(payload.sourceObservedAt) ?? Date.now(),
    deployIdentity: typeof payload.deployIdentity === 'string' ? payload.deployIdentity : null,
    probeKind: typeof payload.probeKind === 'string' ? payload.probeKind : null,
  };
}

function identityDigest(identity) {
  return canonicalJson({
    cacheGeneration: identity.cacheGeneration,
    sourceObservedRevision: identity.sourceObservedRevision,
  });
}

function identitiesEqual(left, right) {
  if (!left || !right) return false;
  return identityDigest(left) === identityDigest(right);
}

module.exports = {
  extractSourceIdentity,
  identitiesEqual,
  identityDigest,
};
