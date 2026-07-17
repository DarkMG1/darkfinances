'use strict';

const { canonicalJson } = require('./request-operation-state');

/**
 * @typedef {{
 *   cacheGeneration: number;
 *   sourceRevision: string | null;
 *   financeTimeZone: string | null;
 *   observedAt: number;
 * }} SourceIdentity
 */

function asNonNegativeInt(value) {
  const candidate = Number(value);
  return Number.isInteger(candidate) && candidate >= 0 ? candidate : null;
}

/**
 * Extracts the bounded source-freshness contract from ping/source payloads.
 * @param {Record<string, unknown> | null | undefined} payload
 * @returns {SourceIdentity | null}
 */
function extractSourceIdentity(payload) {
  if (!payload || typeof payload !== 'object') return null;

  const explicit = payload.sourceFreshness;
  if (explicit && typeof explicit === 'object') {
    const cacheGeneration = asNonNegativeInt(explicit.cacheGeneration);
    if (cacheGeneration == null) return null;
    return {
      cacheGeneration,
      sourceRevision: typeof explicit.sourceRevision === 'string' ? explicit.sourceRevision : null,
      financeTimeZone: typeof explicit.financeTimeZone === 'string' ? explicit.financeTimeZone : null,
      observedAt: asNonNegativeInt(explicit.observedAt) ?? Date.now(),
    };
  }

  const coordinator = payload.actualCoordinator;
  const release = payload.release;
  const cacheGeneration = coordinator && typeof coordinator === 'object'
    ? asNonNegativeInt(coordinator.generation)
    : null;
  if (cacheGeneration == null) return null;

  const sourceRevision = release && typeof release === 'object'
    ? (typeof release.contract === 'string'
      ? release.contract
      : (typeof release.lockSha256 === 'string' ? release.lockSha256 : null))
    : null;

  return {
    cacheGeneration,
    sourceRevision,
    financeTimeZone: typeof payload.financeTimeZone === 'string' ? payload.financeTimeZone : null,
    observedAt: asNonNegativeInt(payload.ts) ?? Date.now(),
  };
}

function identityDigest(identity) {
  return canonicalJson({
    cacheGeneration: identity.cacheGeneration,
    sourceRevision: identity.sourceRevision,
    financeTimeZone: identity.financeTimeZone,
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
