'use strict';

const {
  CHECK_SOURCES,
  DEFAULT_CHECK_THROTTLE_MS,
  DEFAULT_DEFER_COOLDOWN_MS,
  DEFAULT_PROMPT_SETTLE_MS,
  OTA_UPDATE_PHASES,
  createInitialOtaUpdateState,
  reduceOtaUpdateState,
  shouldPrompt,
  updateIdFromManifest,
} = require('./ota-update-state');

function cloneState(state) {
  return JSON.parse(JSON.stringify(state));
}

/**
 * Single OTA update owner. All automatic, manual, and native-pending paths funnel
 * through this controller so only one check/download/prompt runs at a time.
 */
function createOtaUpdateOwner(deps) {
  const now = deps.now ?? (() => Date.now());
  const schedule = deps.schedule ?? ((fn, delayMs) => setTimeout(fn, delayMs));
  const cancelSchedule = deps.cancelSchedule ?? ((handle) => clearTimeout(handle));
  const checkThrottleMs = deps.checkThrottleMs ?? DEFAULT_CHECK_THROTTLE_MS;
  const deferCooldownMs = deps.deferCooldownMs ?? DEFAULT_DEFER_COOLDOWN_MS;
  const promptSettleMs = deps.promptSettleMs ?? DEFAULT_PROMPT_SETTLE_MS;
  const getNativePending = deps.getNativePending ?? (() => ({ pending: false, updateId: null }));

  let state = createInitialOtaUpdateState({ supported: deps.isSupported() });
  const listeners = new Set();
  let lastAutoCheckAt = 0;
  let appActive = true;
  let promptGateOpen = false;
  let promptTimer = null;
  let cooldownTimer = null;
  let inFlightKind = null;
  let inFlightToken = 0;
  let checkGeneration = 0;
  let activeCheckGeneration = 0;
  let queuedNativePending = null;
  let initialized = false;
  const idleWaiters = [];

  function notifyIdleIfReady() {
    if (inFlightKind != null) return;
    const waiters = idleWaiters.splice(0);
    for (const resolve of waiters) resolve();
  }

  function whenIdle() {
    if (inFlightKind == null) return Promise.resolve();
    return new Promise((resolve) => idleWaiters.push(resolve));
  }

  function releaseInFlightWork() {
    inFlightKind = null;
    inFlightToken += 1;
    notifyIdleIfReady();
  }

  function emit() {
    for (const listener of listeners) listener();
  }

  function dispatch(event) {
    const deferredRecord = deps.persistence.readDeferred(now());
    const next = reduceOtaUpdateState(state, event, {
      now: now(),
      checkThrottleMs,
      deferCooldownMs,
    });
    if (next !== state) {
      state = next;
      emit();
    }
    return deferredRecord;
  }

  function setState(next) {
    state = next;
    emit();
  }

  function getSnapshot() {
    return cloneState(state);
  }

  function subscribe(listener) {
    listeners.add(listener);
    return () => listeners.delete(listener);
  }

  function clearScheduledWork() {
    if (promptTimer != null) {
      cancelSchedule(promptTimer);
      promptTimer = null;
    }
    if (cooldownTimer != null) {
      cancelSchedule(cooldownTimer);
      cooldownTimer = null;
    }
  }

  function invalidateInFlightWork() {
    activeCheckGeneration = ++checkGeneration;
    queuedNativePending = null;
    releaseInFlightWork();
  }

  function applyNativePending(native) {
    const deferredRecord = deps.persistence.readDeferred(now());
    dispatch({
      type: 'native_pending_detected',
      updateId: native.updateId,
      deferredRecord,
    });
    schedulePromptIfReady();
  }

  function flushQueuedNativePending() {
    if (!queuedNativePending) return;
    const native = queuedNativePending;
    queuedNativePending = null;
    applyNativePending(native);
  }

  function schedulePromptIfReady() {
    if (promptTimer != null) {
      cancelSchedule(promptTimer);
      promptTimer = null;
    }
    if (!shouldPrompt(state, {
      appActive,
      promptGateOpen,
      now: now(),
    })) return;

    promptTimer = schedule(() => {
      promptTimer = null;
      if (!shouldPrompt(state, {
        appActive,
        promptGateOpen,
        now: now(),
      })) return;
      dispatch({ type: 'prompt_ready', appActive, promptGateOpen });
      deps.showPrompt({
        onRestart: () => {
          void requestRestart();
        },
        onLater: () => {
          const deferredUntil = now() + deferCooldownMs;
          dispatch({ type: 'prompt_deferred' });
          deps.persistence.writeDeferred({
            updateId: state.updateId,
            deferredUntil,
          });
          scheduleCooldownExpiry(deferredUntil);
        },
      });
    }, promptSettleMs);
  }

  function scheduleCooldownExpiry(deferredUntil) {
    if (cooldownTimer != null) {
      cancelSchedule(cooldownTimer);
      cooldownTimer = null;
    }
    const delay = Math.max(0, deferredUntil - now());
    cooldownTimer = schedule(() => {
      cooldownTimer = null;
      dispatch({ type: 'cooldown_expired' });
      deps.persistence.clearDeferred();
      syncNativePending();
      if (state.phase === OTA_UPDATE_PHASES.IDLE) maybeAutoCheck();
      else schedulePromptIfReady();
    }, delay);
  }

  function restoreDeferredCooldown() {
    const record = deps.persistence.readDeferred(now());
    if (!record) return;
    if (state.updateId && state.updateId !== record.updateId) return;
    if (state.phase === OTA_UPDATE_PHASES.DEFERRED) {
      scheduleCooldownExpiry(record.deferredUntil);
      return;
    }
    if (state.phase === OTA_UPDATE_PHASES.DOWNLOADED) {
      setState({
        ...state,
        deferredUntil: record.deferredUntil,
      });
      scheduleCooldownExpiry(record.deferredUntil);
    }
  }

  async function runCheck(source) {
    if (inFlightKind != null) return;
    const generation = ++checkGeneration;
    activeCheckGeneration = generation;
    const pipelineToken = ++inFlightToken;
    inFlightKind = 'check-pipeline';
    try {
      const result = await deps.checkForUpdate();
      if (generation !== activeCheckGeneration) return;

      const updateId = updateIdFromManifest(result.manifest);
      const deferredRecord = deps.persistence.readDeferred(now());
      dispatch({
        type: 'check_succeeded',
        isAvailable: !!result.isAvailable,
        updateId,
        deferredRecord,
      });

      if (generation !== activeCheckGeneration) return;

      if (state.phase === OTA_UPDATE_PHASES.AVAILABLE) {
        await runDownload(generation, pipelineToken);
      } else if (state.phase === OTA_UPDATE_PHASES.DOWNLOADED) {
        schedulePromptIfReady();
      }
    } catch (error) {
      if (generation !== activeCheckGeneration) return;
      dispatch({
        type: 'check_failed',
        message: error?.message || 'Update check failed',
      });
    } finally {
      if (inFlightToken === pipelineToken) {
        inFlightKind = null;
        if (activeCheckGeneration === generation) {
          activeCheckGeneration = 0;
          if (source === CHECK_SOURCES.AUTO) lastAutoCheckAt = now();
          flushQueuedNativePending();
        }
        notifyIdleIfReady();
      }
    }
  }

  async function runDownload(expectedGeneration = activeCheckGeneration, pipelineToken = null) {
    const standalone = pipelineToken == null;
    if (standalone) {
      if (inFlightKind != null) return;
      pipelineToken = ++inFlightToken;
      inFlightKind = 'download';
    } else if (inFlightToken !== pipelineToken) {
      return;
    }
    if (state.phase !== OTA_UPDATE_PHASES.AVAILABLE && state.phase !== OTA_UPDATE_PHASES.DOWNLOADING) {
      if (standalone && inFlightToken === pipelineToken) {
        inFlightKind = null;
        notifyIdleIfReady();
      }
      return;
    }
    dispatch({ type: 'download_started' });
    try {
      const result = await deps.fetchUpdate();
      if (expectedGeneration !== activeCheckGeneration && expectedGeneration !== 0) return;

      const updateId = updateIdFromManifest(result.manifest) ?? state.updateId;
      const deferredRecord = deps.persistence.readDeferred(now());
      dispatch({
        type: 'download_succeeded',
        updateId,
        deferredRecord,
      });
      schedulePromptIfReady();
    } catch (error) {
      if (expectedGeneration !== activeCheckGeneration && expectedGeneration !== 0) return;
      dispatch({
        type: 'download_failed',
        message: error?.message || 'Update download failed',
      });
    } finally {
      if (standalone && inFlightToken === pipelineToken) {
        inFlightKind = null;
        notifyIdleIfReady();
      }
    }
  }

  async function requestRestart() {
    if (state.phase !== OTA_UPDATE_PHASES.PROMPTED) return;
    dispatch({ type: 'restart_requested' });
    deps.persistence.clearDeferred();
    try {
      await deps.reload();
    } catch (error) {
      dispatch({
        type: 'restart_failed',
        message: error?.message || 'Restart failed',
      });
      schedulePromptIfReady();
    }
  }

  function maybeAutoCheck() {
    if (!deps.isSupported()) {
      dispatch({ type: 'unsupported_detected' });
      return;
    }
    dispatch({
      type: 'auto_check_requested',
      lastAutoCheckAt,
    });
    if (state.phase === OTA_UPDATE_PHASES.CHECKING && state.checkSource === CHECK_SOURCES.AUTO) {
      void runCheck(CHECK_SOURCES.AUTO);
    }
  }

  function syncNativePending() {
    if (!deps.isSupported()) return;
    const native = getNativePending();
    if (!native.pending || !native.updateId) return;

    if (inFlightKind != null) {
      queuedNativePending = native;
      return;
    }

    if (
      state.phase === OTA_UPDATE_PHASES.DOWNLOADED
      && state.updateId === native.updateId
    ) {
      return;
    }

    applyNativePending(native);
  }

  function initialize() {
    if (initialized) return;
    initialized = true;

    clearScheduledWork();
    invalidateInFlightWork();

    if (!deps.isSupported()) {
      dispatch({ type: 'unsupported_detected' });
      return;
    }

    const native = getNativePending();
    const deferredRecord = deps.persistence.readDeferred(now());
    state = createInitialOtaUpdateState({
      supported: true,
      nativePending: native.pending,
      updateId: native.updateId,
      deferredRecord,
      now: now(),
    });
    emit();
    restoreDeferredCooldown();
    schedulePromptIfReady();
  }

  function setAppActive(active) {
    appActive = active;
    if (active) {
      syncNativePending();
      maybeAutoCheck();
      schedulePromptIfReady();
    } else if (promptTimer != null) {
      cancelSchedule(promptTimer);
      promptTimer = null;
    }
  }

  function setPromptGateOpen(open) {
    promptGateOpen = open;
    if (open) schedulePromptIfReady();
    else if (promptTimer != null) {
      cancelSchedule(promptTimer);
      promptTimer = null;
    }
  }

  async function requestManualCheck() {
    if (!deps.isSupported()) {
      dispatch({ type: 'manual_check_requested' });
      return getSnapshot();
    }
    dispatch({ type: 'manual_check_requested' });
    if (state.phase === OTA_UPDATE_PHASES.CHECKING && state.checkSource === CHECK_SOURCES.MANUAL) {
      await runCheck(CHECK_SOURCES.MANUAL);
    }
    return getSnapshot();
  }

  function dispose() {
    initialized = false;
    clearScheduledWork();
    invalidateInFlightWork();
    listeners.clear();
    lastAutoCheckAt = 0;
    appActive = true;
    promptGateOpen = false;
    state = createInitialOtaUpdateState({ supported: deps.isSupported() });
  }

  return {
    CHECK_SOURCES,
    OTA_UPDATE_PHASES,
    dispose,
    getSnapshot,
    initialize,
    maybeAutoCheck,
    requestManualCheck,
    requestRestart,
    runCheck,
    runDownload,
    schedulePromptIfReady,
    setAppActive,
    setPromptGateOpen,
    subscribe,
    syncNativePending,
    whenIdle,
  };
}

module.exports = {
  createOtaUpdateOwner,
};
