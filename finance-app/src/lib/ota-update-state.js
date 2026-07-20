'use strict';

const OTA_UPDATE_PHASES = Object.freeze({
  UNSUPPORTED: 'unsupported',
  IDLE: 'idle',
  CHECKING: 'checking',
  AVAILABLE: 'available',
  DOWNLOADING: 'downloading',
  DOWNLOADED: 'downloaded',
  PROMPTED: 'prompted',
  DEFERRED: 'deferred',
  RESTARTING: 'restarting',
  ERROR: 'error',
});

const CHECK_SOURCES = Object.freeze({
  AUTO: 'auto',
  MANUAL: 'manual',
});

const DEFAULT_DEFER_COOLDOWN_MS = 4 * 60 * 60 * 1000;
const DEFAULT_CHECK_THROTTLE_MS = 30_000;
const DEFAULT_PROMPT_SETTLE_MS = 300;

function createInitialOtaUpdateState(input = {}) {
  const supported = input.supported !== false;
  const updateId = input.updateId ?? null;
  if (!supported) {
    return {
      phase: OTA_UPDATE_PHASES.UNSUPPORTED,
      updateId: null,
      checkSource: null,
      error: null,
      manualStatus: null,
      promptedUpdateId: null,
      deferredUntil: null,
    };
  }
  if (input.nativePending && updateId) {
    return {
      phase: OTA_UPDATE_PHASES.DOWNLOADED,
      updateId,
      checkSource: null,
      error: null,
      manualStatus: null,
      promptedUpdateId: null,
      deferredUntil: readDeferredUntil(input.deferredRecord, updateId, input.now ?? Date.now()),
    };
  }
  return {
    phase: OTA_UPDATE_PHASES.IDLE,
    updateId: null,
    checkSource: null,
    error: null,
    manualStatus: null,
    promptedUpdateId: null,
    deferredUntil: null,
  };
}

function readDeferredUntil(record, updateId, now) {
  if (!record || record.updateId !== updateId) return null;
  if (typeof record.deferredUntil !== 'number' || record.deferredUntil <= now) return null;
  return record.deferredUntil;
}

function isBusyPhase(phase) {
  return phase === OTA_UPDATE_PHASES.CHECKING
    || phase === OTA_UPDATE_PHASES.AVAILABLE
    || phase === OTA_UPDATE_PHASES.DOWNLOADING
    || phase === OTA_UPDATE_PHASES.RESTARTING;
}

function canAutoCheck(state, now, throttleMs) {
  if (state.phase === OTA_UPDATE_PHASES.UNSUPPORTED) return false;
  if (isBusyPhase(state.phase)) return false;
  if (state.phase === OTA_UPDATE_PHASES.DOWNLOADED || state.phase === OTA_UPDATE_PHASES.PROMPTED) return false;
  return true;
}

function canManualCheck(state) {
  if (state.phase === OTA_UPDATE_PHASES.UNSUPPORTED) return false;
  return !isBusyPhase(state.phase);
}

function shouldPrompt(state, input) {
  if (state.phase !== OTA_UPDATE_PHASES.DOWNLOADED) return false;
  if (!state.updateId) return false;
  if (state.promptedUpdateId === state.updateId) return false;
  if (!input.appActive || !input.promptGateOpen) return false;
  if (state.deferredUntil && state.deferredUntil > input.now) return false;
  return true;
}

function getOtaUpdateStatusLabel(state) {
  switch (state.phase) {
    case OTA_UPDATE_PHASES.UNSUPPORTED:
      return 'OTA runs only in a release (sideloaded) build';
    case OTA_UPDATE_PHASES.CHECKING:
      return 'Checking…';
    case OTA_UPDATE_PHASES.AVAILABLE:
    case OTA_UPDATE_PHASES.DOWNLOADING:
      return 'Downloading update…';
    case OTA_UPDATE_PHASES.DOWNLOADED:
    case OTA_UPDATE_PHASES.PROMPTED:
    case OTA_UPDATE_PHASES.DEFERRED:
      return 'Update downloaded; restart prompt ready';
    case OTA_UPDATE_PHASES.RESTARTING:
      return 'Restarting…';
    case OTA_UPDATE_PHASES.ERROR:
      return state.error || 'Update check failed';
    case OTA_UPDATE_PHASES.IDLE:
    default:
      return null;
  }
}

function getOtaUpdateDisplayStatus(state) {
  return state.manualStatus ?? getOtaUpdateStatusLabel(state);
}

function reduceOtaUpdateState(state, event, options = {}) {
  const now = options.now ?? Date.now();
  const throttleMs = options.checkThrottleMs ?? DEFAULT_CHECK_THROTTLE_MS;

  switch (event.type) {
    case 'unsupported_detected':
      return createInitialOtaUpdateState({ supported: false });

    case 'native_pending_detected': {
      if (state.phase === OTA_UPDATE_PHASES.UNSUPPORTED) return state;
      const updateId = event.updateId;
      if (!updateId) return state;
      if (state.phase === OTA_UPDATE_PHASES.DOWNLOADED && state.updateId === updateId) return state;
      if (state.phase === OTA_UPDATE_PHASES.PROMPTED && state.updateId === updateId) return state;
      return {
        ...state,
        phase: OTA_UPDATE_PHASES.DOWNLOADED,
        updateId,
        checkSource: null,
        error: null,
        manualStatus: null,
        promptedUpdateId: null,
        deferredUntil: readDeferredUntil(event.deferredRecord, updateId, now),
      };
    }

    case 'auto_check_requested': {
      if (!canAutoCheck(state, now, throttleMs)) return state;
      if (event.lastAutoCheckAt != null && now - event.lastAutoCheckAt < throttleMs) return state;
      return {
        ...state,
        phase: OTA_UPDATE_PHASES.CHECKING,
        checkSource: CHECK_SOURCES.AUTO,
        error: null,
        manualStatus: null,
      };
    }

    case 'manual_check_requested': {
      if (state.phase === OTA_UPDATE_PHASES.UNSUPPORTED) {
        return {
          ...state,
          manualStatus: 'OTA runs only in a release (sideloaded) build',
        };
      }
      if (state.phase === OTA_UPDATE_PHASES.DOWNLOADED || state.phase === OTA_UPDATE_PHASES.PROMPTED) {
        return {
          ...state,
          manualStatus: 'Update downloaded; restart prompt ready',
        };
      }
      if (!canManualCheck(state)) {
        return {
          ...state,
          manualStatus: 'Update check already in progress',
        };
      }
      return {
        ...state,
        phase: OTA_UPDATE_PHASES.CHECKING,
        checkSource: CHECK_SOURCES.MANUAL,
        error: null,
        manualStatus: 'Checking…',
      };
    }

    case 'check_succeeded': {
      if (state.phase !== OTA_UPDATE_PHASES.CHECKING) return state;
      if (!event.isAvailable) {
        return {
          ...state,
          phase: OTA_UPDATE_PHASES.IDLE,
          updateId: null,
          checkSource: null,
          error: null,
          promptedUpdateId: null,
          manualStatus: state.checkSource === CHECK_SOURCES.MANUAL ? 'Up to date' : null,
        };
      }
      const updateId = event.updateId;
      if (!updateId) {
        return {
          ...state,
          phase: OTA_UPDATE_PHASES.ERROR,
          checkSource: null,
          error: 'Update is available but missing an update ID',
          manualStatus: state.checkSource === CHECK_SOURCES.MANUAL ? 'Update check failed' : null,
        };
      }
      const deferredUntil = readDeferredUntil(event.deferredRecord, updateId, now);
      if (state.checkSource === CHECK_SOURCES.AUTO && deferredUntil) {
        return {
          ...state,
          phase: OTA_UPDATE_PHASES.DEFERRED,
          updateId,
          checkSource: null,
          promptedUpdateId: null,
          deferredUntil,
          manualStatus: null,
        };
      }
      return {
        ...state,
        phase: OTA_UPDATE_PHASES.AVAILABLE,
        updateId,
        checkSource: state.checkSource,
        error: null,
        promptedUpdateId: null,
        manualStatus: state.checkSource === CHECK_SOURCES.MANUAL ? 'Downloading update…' : null,
      };
    }

    case 'download_started': {
      if (state.phase !== OTA_UPDATE_PHASES.AVAILABLE) return state;
      return {
        ...state,
        phase: OTA_UPDATE_PHASES.DOWNLOADING,
      };
    }

    case 'download_succeeded': {
      if (state.phase !== OTA_UPDATE_PHASES.DOWNLOADING && state.phase !== OTA_UPDATE_PHASES.AVAILABLE) {
        return state;
      }
      const updateId = event.updateId ?? state.updateId;
      return {
        ...state,
        phase: OTA_UPDATE_PHASES.DOWNLOADED,
        updateId,
        checkSource: null,
        error: null,
        promptedUpdateId: null,
        manualStatus: state.checkSource === CHECK_SOURCES.MANUAL
          ? 'Update downloaded; restart prompt ready'
          : null,
        deferredUntil: readDeferredUntil(event.deferredRecord, updateId, now),
      };
    }

    case 'check_failed':
    case 'download_failed': {
      const message = event.message || 'Update check failed';
      return {
        ...state,
        phase: OTA_UPDATE_PHASES.ERROR,
        checkSource: null,
        error: message,
        manualStatus: state.checkSource === CHECK_SOURCES.MANUAL ? message : null,
      };
    }

    case 'prompt_ready': {
      if (!shouldPrompt(state, { ...event, now })) return state;
      return {
        ...state,
        phase: OTA_UPDATE_PHASES.PROMPTED,
        promptedUpdateId: state.updateId,
      };
    }

    case 'prompt_deferred': {
      if (state.phase !== OTA_UPDATE_PHASES.PROMPTED) return state;
      const deferredUntil = now + (options.deferCooldownMs ?? DEFAULT_DEFER_COOLDOWN_MS);
      return {
        ...state,
        phase: OTA_UPDATE_PHASES.DEFERRED,
        promptedUpdateId: null,
        deferredUntil,
        manualStatus: null,
      };
    }

    case 'cooldown_expired': {
      if (state.phase !== OTA_UPDATE_PHASES.DEFERRED) return state;
      if (state.deferredUntil && state.deferredUntil > now) return state;
      return {
        ...state,
        phase: OTA_UPDATE_PHASES.IDLE,
        updateId: null,
        promptedUpdateId: null,
        deferredUntil: null,
      };
    }

    case 'restart_requested': {
      if (state.phase !== OTA_UPDATE_PHASES.PROMPTED) return state;
      return {
        ...state,
        phase: OTA_UPDATE_PHASES.RESTARTING,
        promptedUpdateId: null,
        deferredUntil: null,
      };
    }

    case 'restart_failed': {
      if (state.phase !== OTA_UPDATE_PHASES.RESTARTING) return state;
      return {
        ...state,
        phase: OTA_UPDATE_PHASES.DOWNLOADED,
        promptedUpdateId: null,
        deferredUntil: null,
        error: event.message || 'Restart failed',
      };
    }

    case 'manual_status_cleared':
      return {
        ...state,
        manualStatus: null,
      };

    default:
      return state;
  }
}

function updateIdFromManifest(manifest) {
  if (!manifest || typeof manifest !== 'object') return null;
  const id = manifest.id;
  return typeof id === 'string' && id.length > 0 ? id : null;
}

module.exports = {
  CHECK_SOURCES,
  DEFAULT_CHECK_THROTTLE_MS,
  DEFAULT_DEFER_COOLDOWN_MS,
  DEFAULT_PROMPT_SETTLE_MS,
  OTA_UPDATE_PHASES,
  canAutoCheck,
  canManualCheck,
  createInitialOtaUpdateState,
  getOtaUpdateDisplayStatus,
  getOtaUpdateStatusLabel,
  reduceOtaUpdateState,
  shouldPrompt,
  updateIdFromManifest,
};
