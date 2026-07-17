/**
 * Mutation outcome haptic ownership (L5).
 *
 * Contract:
 * - User-initiated finance mutations emit at most one success OR one error haptic
 *   per logical idempotency operation (idempotency key), not per request digest
 *   for the app lifetime. Request digests are callback lookup keys only.
 * - Retry/reconciliation chains reuse the same operation identity; a later distinct
 *   same-payload user action receives a new idempotency key and a new session.
 * - Terminal success or failure closes the session after dispatch so memory stays
 *   bounded. Unknown/timeout keeps the session open with no haptic until terminal
 *   proof.
 * - When the session map is at capacity, expired and least-recent abandoned unknown
 *   sessions are evicted before insertion. If every slot is a genuinely active retry,
 *   beginUserMutation returns false and installs no digest mapping.
 * - Background reconciliation, operation polling, cache refetch, and in-flight
 *   replay/coalescing emit none.
 */

const NON_TERMINAL_OUTCOME_CODES = new Set([
  'OUTCOME_UNKNOWN',
]);

const DEFAULT_MAX_SESSIONS = 128;
const DEFAULT_UNKNOWN_SESSION_TTL_MS = 24 * 60 * 60 * 1000;

function isTerminalMutationError(error) {
  if (!error || typeof error !== 'object') return true;
  const code = typeof error.code === 'string' ? error.code : '';
  if (NON_TERMINAL_OUTCOME_CODES.has(code)) return false;
  const status = Number(error.status);
  if (code === 'TIMEOUT' || status === 408) return false;
  return true;
}

function createMutationOutcomeHapticGate(hapticsApi, options = {}) {
  const maxSessions = Number(options.maxSessions) > 0
    ? Number(options.maxSessions)
    : DEFAULT_MAX_SESSIONS;
  const unknownSessionTtlMs = Number(options.unknownSessionTtlMs) > 0
    ? Number(options.unknownSessionTtlMs)
    : DEFAULT_UNKNOWN_SESSION_TTL_MS;
  const now = typeof options.now === 'function' ? options.now : () => Date.now();

  /** @type {Map<string, { userInitiated: boolean, emitted: 'success' | 'error' | null, scopeDigest: string | null, lastAccessAt: number }>} */
  const sessions = new Map();
  /** @type {Map<string, string>} */
  const digestToOperationKey = new Map();

  function resolveOperationKey(requestDigest) {
    if (!requestDigest) return null;
    return digestToOperationKey.get(requestDigest) ?? null;
  }

  function safeHaptic(fn) {
    try {
      fn();
    } catch {
      // Platform haptic failures must never affect mutation outcome ownership.
    }
  }

  function removeDigestMappingsForOperationKey(operationKey) {
    for (const [digest, key] of digestToOperationKey) {
      if (key === operationKey) digestToOperationKey.delete(digest);
    }
  }

  function endSession(operationKey) {
    sessions.delete(operationKey);
    removeDigestMappingsForOperationKey(operationKey);
  }

  function isUnknownSession(session) {
    return session.emitted === null;
  }

  function unknownSessions() {
    return [...sessions.entries()].filter(([, session]) => isUnknownSession(session));
  }

  function isExpiredUnknown(session, timestamp) {
    return timestamp - session.lastAccessAt > unknownSessionTtlMs;
  }

  function evictExpiredUnknownSessions(timestamp) {
    for (const [operationKey, session] of sessions) {
      if (isUnknownSession(session) && isExpiredUnknown(session, timestamp)) {
        endSession(operationKey);
      }
    }
  }

  function unknownAccessBounds(entries) {
    let minAccess = Infinity;
    let maxAccess = -Infinity;
    for (const [, session] of entries) {
      if (session.lastAccessAt < minAccess) minAccess = session.lastAccessAt;
      if (session.lastAccessAt > maxAccess) maxAccess = session.lastAccessAt;
    }
    return { minAccess, maxAccess };
  }

  function canEvictUnknownForCapacity(timestamp, entries = unknownSessions()) {
    if (entries.length === 0) return false;
    if (entries.some(([, session]) => isExpiredUnknown(session, timestamp))) return true;
    const { minAccess, maxAccess } = unknownAccessBounds(entries);
    return minAccess < maxAccess;
  }

  function evictOneAbandonedUnknown(timestamp) {
    const entries = unknownSessions();
    if (entries.length === 0) return false;

    const expired = entries.filter(([, session]) => isExpiredUnknown(session, timestamp));
    if (expired.length > 0) {
      expired.sort((left, right) => left[1].lastAccessAt - right[1].lastAccessAt);
      endSession(expired[0][0]);
      return true;
    }

    const { minAccess, maxAccess } = unknownAccessBounds(entries);
    if (minAccess >= maxAccess) return false;

    const abandoned = entries
      .filter(([, session]) => session.lastAccessAt === minAccess)
      .sort((left, right) => left[0].localeCompare(right[0]));
    endSession(abandoned[0][0]);
    return true;
  }

  function makeRoomForNewSession(timestamp) {
    evictExpiredUnknownSessions(timestamp);
    while (sessions.size >= maxSessions && evictOneAbandonedUnknown(timestamp)) {
      // Evict only expired or strictly least-recent abandoned unknown sessions.
    }
  }

  function assertSessionCapacity() {
    if (sessions.size > maxSessions) {
      throw new Error(`Mutation outcome haptic sessions exceeded cap (${sessions.size} > ${maxSessions})`);
    }
  }

  function getSessionForDigest(requestDigest) {
    const operationKey = resolveOperationKey(requestDigest);
    if (!operationKey) return null;
    return sessions.get(operationKey) ?? null;
  }

  return {
    reset() {
      sessions.clear();
      digestToOperationKey.clear();
    },

    purgeScope(scopeDigest) {
      if (!scopeDigest) return;
      for (const [operationKey, session] of sessions) {
        if (session.scopeDigest === scopeDigest) endSession(operationKey);
      }
    },

    /** @returns {Map<string, { userInitiated: boolean, emitted: 'success' | 'error' | null, scopeDigest: string | null, lastAccessAt: number }>} */
    sessions() {
      return sessions;
    },

    /**
     * @returns {boolean} True when the operation is tracked for outcome haptics.
     * Returns false when capacity is full and every session is a genuinely active
     * retry; in that case no digest mapping is installed.
     */
    beginUserMutation(
      requestDigest,
      { operationKey, scopeDigest, userInitiated = true } = {},
    ) {
      if (!operationKey) return false;
      const timestamp = now();
      const existing = sessions.get(operationKey);
      if (existing) {
        if (requestDigest) digestToOperationKey.set(requestDigest, operationKey);
        existing.userInitiated = existing.userInitiated || userInitiated;
        existing.lastAccessAt = timestamp;
        if (scopeDigest && !existing.scopeDigest) existing.scopeDigest = scopeDigest;
        assertSessionCapacity();
        return true;
      }

      makeRoomForNewSession(timestamp);
      if (sessions.size >= maxSessions && !canEvictUnknownForCapacity(timestamp)) {
        return false;
      }
      if (sessions.size >= maxSessions && !evictOneAbandonedUnknown(timestamp)) {
        return false;
      }
      if (sessions.size >= maxSessions) {
        return false;
      }

      sessions.set(operationKey, {
        userInitiated,
        emitted: null,
        scopeDigest: scopeDigest ?? null,
        lastAccessAt: timestamp,
      });
      if (requestDigest) digestToOperationKey.set(requestDigest, operationKey);
      assertSessionCapacity();
      return true;
    },

    shouldEmitSuccess(requestDigest) {
      if (!requestDigest) return false;
      const session = getSessionForDigest(requestDigest);
      if (!session || !session.userInitiated || session.emitted) return false;
      return true;
    },

    shouldEmitError(requestDigest, error) {
      if (!requestDigest) return false;
      if (!isTerminalMutationError(error)) return false;
      const session = getSessionForDigest(requestDigest);
      if (!session || !session.userInitiated || session.emitted) return false;
      return true;
    },

    emitSuccess(requestDigest) {
      if (!this.shouldEmitSuccess(requestDigest)) return false;
      const operationKey = resolveOperationKey(requestDigest);
      const session = operationKey ? sessions.get(operationKey) : null;
      if (!operationKey || !session) return false;
      session.emitted = 'success';
      session.lastAccessAt = now();
      safeHaptic(() => hapticsApi.success());
      endSession(operationKey);
      return true;
    },

    emitError(requestDigest, error) {
      if (!this.shouldEmitError(requestDigest, error)) return false;
      const operationKey = resolveOperationKey(requestDigest);
      const session = operationKey ? sessions.get(operationKey) : null;
      if (!operationKey || !session) return false;
      session.emitted = 'error';
      session.lastAccessAt = now();
      safeHaptic(() => hapticsApi.warning());
      endSession(operationKey);
      return true;
    },

    emitDemoSuccess() {
      safeHaptic(() => hapticsApi.success());
      return true;
    },

    emitDemoError(error) {
      if (!isTerminalMutationError(error)) return false;
      safeHaptic(() => hapticsApi.warning());
      return true;
    },

    emitClientValidationError() {
      safeHaptic(() => hapticsApi.warning());
      return true;
    },
  };
}

module.exports = {
  DEFAULT_MAX_SESSIONS,
  DEFAULT_UNKNOWN_SESSION_TTL_MS,
  NON_TERMINAL_OUTCOME_CODES,
  createMutationOutcomeHapticGate,
  isTerminalMutationError,
};
