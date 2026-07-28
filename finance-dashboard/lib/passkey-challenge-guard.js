'use strict';

const crypto = require('crypto');

const DEFAULT_MAX_ENTRIES = 4096;
const DEFAULT_TTL_MS = 10 * 60 * 1000;

/**
 * Operator-enforced deployment contract: exactly one finance-dashboard process
 * may serve WebAuthn finish for an instance. Consumed challenges live in-process
 * only; systemd/process managers must not run multiple workers against one
 * session store. Pair with PASSKEY_CREDENTIALS_DEPLOYMENT_CONTRACT in
 * passkey-credentials-store.js — no runtime cross-process lock is provided.
 */
const PASSKEY_CHALLENGE_GUARD_DEPLOYMENT_CONTRACT = Object.freeze({
  id: 'single-process-challenge-guard',
  requirement: 'One finance-dashboard process owns in-process challenge consumption.',
});

/** @type {Map<string, number>} digest -> expiresAtMs */
const consumed = new Map();

function challengeDigest(sessionId, kind, challenge) {
  return crypto.createHash('sha256')
    .update(String(sessionId))
    .update('\0')
    .update(String(kind))
    .update('\0')
    .update(String(challenge))
    .digest('hex');
}

function evictExpired(now = Date.now()) {
  for (const [key, expiresAt] of consumed) {
    if (expiresAt <= now) consumed.delete(key);
  }
}

/**
 * Marks a WebAuthn finish challenge consumed in-process. Returns false when the
 * challenge was already consumed, inputs are invalid, or capacity is full.
 * Expired entries are pruned first; unexpired consumed challenges are never
 * evicted. Never logs raw challenges.
 */
function tryConsumePasskeyChallenge({
  sessionId,
  kind,
  challenge,
  ttlMs = DEFAULT_TTL_MS,
  maxEntries = DEFAULT_MAX_ENTRIES,
  now = Date.now(),
} = {}) {
  if (!sessionId || !kind || challenge == null || challenge === '') return false;
  evictExpired(now);
  const key = challengeDigest(sessionId, kind, challenge);
  if (consumed.has(key)) return false;
  if (consumed.size >= maxEntries) return false;
  consumed.set(key, now + ttlMs);
  return true;
}

function resetPasskeyChallengeGuard() {
  consumed.clear();
}

module.exports = {
  DEFAULT_MAX_ENTRIES,
  DEFAULT_TTL_MS,
  PASSKEY_CHALLENGE_GUARD_DEPLOYMENT_CONTRACT,
  resetPasskeyChallengeGuard,
  tryConsumePasskeyChallenge,
};
