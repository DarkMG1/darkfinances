'use strict';

const { createConnectivityTracker } = require('./reconnect-connectivity');
const {
  extractSourceIdentity,
  identitiesEqual,
} = require('./reconnect-source-identity');
const {
  RECONNECT_REFRESH_ABORTED_CODE,
  RECONNECT_REFRESH_STALE_CODE,
  createReconnectStaleWarningStore,
} = require('./reconnect-stale-warning');

const DEFAULT_ONLINE_SETTLE_MS = 500;
const DEFAULT_DEBOUNCE_MS = 750;
const DEFAULT_BACKOFF_BASE_MS = 2_000;
const DEFAULT_BACKOFF_MAX_MS = 60_000;

/**
 * @typedef {{
 *   scope: string;
 *   profileGeneration: number;
 *   reason: string;
 *   id: number;
 * }} ReconnectRefreshRunToken
 */

function createReconnectRefreshOwner(deps) {
  const now = deps.now ?? (() => Date.now());
  const schedule = deps.schedule ?? ((fn, delayMs) => setTimeout(fn, delayMs));
  const cancelSchedule = deps.cancelSchedule ?? ((handle) => clearTimeout(handle));
  const onlineSettleMs = deps.onlineSettleMs ?? DEFAULT_ONLINE_SETTLE_MS;
  const debounceMs = deps.debounceMs ?? DEFAULT_DEBOUNCE_MS;
  const backoffBaseMs = deps.backoffBaseMs ?? DEFAULT_BACKOFF_BASE_MS;
  const backoffMaxMs = deps.backoffMaxMs ?? DEFAULT_BACKOFF_MAX_MS;

  const connectivity = createConnectivityTracker({
    initialPhase: deps.initialConnectivityPhase,
    initialSnapshot: deps.initialConnectivitySnapshot,
  });
  const staleWarning = deps.staleWarning ?? createReconnectStaleWarningStore({ now });

  /** @type {Map<string, import('./reconnect-source-identity').SourceIdentity>} */
  const confirmedIdentityByScope = new Map();

  let active = deps.initialActive ?? true;
  let scope = deps.scope ?? '';
  let profileGeneration = deps.profileGeneration ?? 0;
  let runSerial = 0;
  /** @type {ReconnectRefreshRunToken | null} */
  let inFlight = null;
  let pendingReason = null;
  let debounceTimer = null;
  let settleTimer = null;
  let backoffMs = 0;
  let backoffTimer = null;
  let lastFailedAt = 0;

  function emit(event) {
    deps.onEvent?.(event);
  }

  function assertRunCurrent(token) {
    if (
      !token
      || token.id !== inFlight?.id
      || token.scope !== scope
      || token.profileGeneration !== profileGeneration
      || !active
    ) {
      const error = new Error(RECONNECT_REFRESH_STALE_CODE);
      error.code = RECONNECT_REFRESH_STALE_CODE;
      throw error;
    }
  }

  function clearDebounceTimer() {
    if (debounceTimer != null) {
      cancelSchedule(debounceTimer);
      debounceTimer = null;
    }
  }

  function clearSettleTimer() {
    if (settleTimer != null) {
      cancelSchedule(settleTimer);
      settleTimer = null;
    }
  }

  function clearBackoffTimer() {
    if (backoffTimer != null) {
      cancelSchedule(backoffTimer);
      backoffTimer = null;
    }
  }

  function clearScheduledWork() {
    clearDebounceTimer();
    clearSettleTimer();
    clearBackoffTimer();
  }

  function abortInFlight() {
    if (!inFlight) return;
    inFlight = null;
  }

  function createRunToken(reason) {
    return {
      scope,
      profileGeneration,
      reason,
      id: ++runSerial,
    };
  }

  async function executeRefresh(token) {
    inFlight = token;
    emit({ type: 'refresh_started', token });
    try {
      assertRunCurrent(token);
      const payload = await deps.fetchSourceFreshness(token);
      assertRunCurrent(token);

      const identity = extractSourceIdentity(payload);
      if (!identity) {
        const error = new Error('Source freshness contract missing');
        error.code = 'RECONNECT_SOURCE_CONTRACT';
        error.status = 502;
        throw error;
      }

      const previousIdentity = confirmedIdentityByScope.get(token.scope) ?? null;
      emit({
        type: 'source_identity_confirmed',
        token,
        identity,
        previousIdentity,
        changed: !identitiesEqual(previousIdentity, identity),
      });

      assertRunCurrent(token);
      const reconcileSummary = await deps.reconcileOperations(token);
      assertRunCurrent(token);

      await deps.refreshActiveQueries(token);

      assertRunCurrent(token);
      confirmedIdentityByScope.set(token.scope, identity);
      staleWarning.clear(token.scope);
      backoffMs = 0;
      emit({
        type: 'refresh_succeeded',
        token,
        identity,
        reconcileSummary,
      });
      return {
        identity,
        previousIdentity,
        reconcileSummary,
      };
    } catch (error) {
      if (error?.code === RECONNECT_REFRESH_STALE_CODE || error?.code === RECONNECT_REFRESH_ABORTED_CODE) {
        emit({ type: 'refresh_aborted', token, error });
        return null;
      }
      staleWarning.set(token.scope, error);
      lastFailedAt = now();
      backoffMs = Math.min(
        backoffMs > 0 ? backoffMs * 2 : backoffBaseMs,
        backoffMaxMs,
      );
      emit({ type: 'refresh_failed', token, error, backoffMs });
      scheduleBackoffRetry();
      return null;
    } finally {
      if (inFlight?.id === token.id) inFlight = null;
      if (pendingReason && !inFlight) {
        const reason = pendingReason;
        pendingReason = null;
        queueRefresh(reason);
      }
    }
  }

  function scheduleBackoffRetry() {
    clearBackoffTimer();
    if (!active || !scope || backoffMs <= 0) return;
    backoffTimer = schedule(() => {
      backoffTimer = null;
      queueRefresh('backoff');
    }, backoffMs);
  }

  function startRefresh(reason) {
    if (!active || !scope || deps.isEnabled?.() === false) return false;
    if (inFlight) {
      pendingReason = reason;
      return false;
    }
    if (backoffMs > 0 && now() - lastFailedAt < backoffMs) {
      pendingReason = reason;
      return false;
    }
    const token = createRunToken(reason);
    void executeRefresh(token);
    return true;
  }

  function queueRefresh(reason) {
    clearDebounceTimer();
    debounceTimer = schedule(() => {
      debounceTimer = null;
      startRefresh(reason);
    }, debounceMs);
  }

  function handleConfirmedOfflineToOnline(reason = 'connectivity') {
    clearSettleTimer();
    settleTimer = schedule(() => {
      settleTimer = null;
      if (connectivity.getPhase() !== 'online') return;
      queueRefresh(reason);
    }, onlineSettleMs);
  }

  function handleConnectivitySnapshot(snapshot) {
    const transition = connectivity.applySnapshot(snapshot);
    emit({ type: 'connectivity', ...transition });
    if (transition.confirmedOfflineToOnline) {
      handleConfirmedOfflineToOnline('connectivity');
      return;
    }
    if (transition.phase === 'offline') {
      clearSettleTimer();
    }
  }

  function noteForegroundCoincidence() {
    if (!inFlight && !pendingReason && !debounceTimer && !settleTimer) return false;
    pendingReason = pendingReason ?? 'foreground';
    if (inFlight) return true;
    queueRefresh('foreground');
    return true;
  }

  function setActive(nextActive) {
    active = !!nextActive;
    if (!active) {
      clearScheduledWork();
      abortInFlight();
      pendingReason = null;
    }
  }

  function setScope(nextScope) {
    if (nextScope === scope) return;
    scope = nextScope ?? '';
    clearScheduledWork();
    abortInFlight();
    pendingReason = null;
    backoffMs = 0;
  }

  function setProfileGeneration(nextGeneration) {
    if (nextGeneration === profileGeneration) return;
    profileGeneration = nextGeneration;
    clearScheduledWork();
    abortInFlight();
    pendingReason = null;
    backoffMs = 0;
  }

  function purgeProfile(nextScope) {
    if (nextScope) {
      confirmedIdentityByScope.delete(nextScope);
      staleWarning.purge(nextScope);
    } else {
      confirmedIdentityByScope.clear();
      staleWarning.purge();
    }
    clearScheduledWork();
    abortInFlight();
    pendingReason = null;
    backoffMs = 0;
  }

  function getConfirmedIdentity(forScope = scope) {
    return confirmedIdentityByScope.get(forScope) ?? null;
  }

  function dispose() {
    clearScheduledWork();
    abortInFlight();
    pendingReason = null;
  }

  return {
    connectivity,
    staleWarning,
    handleConnectivitySnapshot,
    noteForegroundCoincidence,
    queueRefresh,
    startRefresh,
    setActive,
    setScope,
    setProfileGeneration,
    purgeProfile,
    getConfirmedIdentity,
    getInFlight: () => inFlight,
    isInFlight: () => inFlight != null,
    dispose,
  };
}

let defaultStaleWarningStore = createReconnectStaleWarningStore();

function getReconnectStaleWarningStore() {
  return defaultStaleWarningStore;
}

function resetReconnectRefreshStateForTests() {
  defaultStaleWarningStore = createReconnectStaleWarningStore();
}

function purgeReconnectRefreshProfileState(scope) {
  defaultStaleWarningStore.purge(scope);
}

module.exports = {
  DEFAULT_BACKOFF_BASE_MS,
  DEFAULT_BACKOFF_MAX_MS,
  DEFAULT_DEBOUNCE_MS,
  DEFAULT_ONLINE_SETTLE_MS,
  createReconnectRefreshOwner,
  getReconnectStaleWarningStore,
  purgeReconnectRefreshProfileState,
  resetReconnectRefreshStateForTests,
};
