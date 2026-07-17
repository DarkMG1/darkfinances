'use strict';

const { createOtaUpdateOwner } = require('./ota-update-owner');
const { createOtaUpdatePersistence } = require('./ota-update-persistence');
const { updateIdFromManifest } = require('./ota-update-state');

/**
 * Test-only runner that mirrors the React owner wiring without React so integration
 * tests can simulate startup, foreground, privacy-gate, and manual flows.
 */
function createOtaUpdateOwnerRunner(deps) {
  const persistence = createOtaUpdatePersistence(deps.store);
  const scheduled = [];
  let promptCount = 0;
  let lastPrompt = null;

  const owner = createOtaUpdateOwner({
    ...deps,
    persistence,
    schedule: (fn, delayMs) => {
      const handle = { fn, delayMs, cancelled: false };
      scheduled.push(handle);
      return handle;
    },
    cancelSchedule: (handle) => {
      handle.cancelled = true;
    },
    showPrompt: (handlers) => {
      promptCount += 1;
      lastPrompt = handlers;
      deps.onPrompt?.(handlers);
    },
  });

  function flushSchedules(maxDelay = Infinity) {
    while (scheduled.some((item) => !item.cancelled && item.delayMs <= maxDelay)) {
      const nextIndex = scheduled.findIndex((item) => !item.cancelled && item.delayMs <= maxDelay);
      if (nextIndex < 0) break;
      const [item] = scheduled.splice(nextIndex, 1);
      if (!item.cancelled) item.fn();
    }
  }

  return {
    owner,
    persistence,
    flushSchedules,
    promptCount: () => promptCount,
    lastPrompt: () => lastPrompt,
    scheduledCount: () => scheduled.filter((item) => !item.cancelled).length,
  };
}

function nativePendingFromUpdates(updates) {
  const updateId = updateIdFromManifest(updates.downloadedUpdate?.manifest)
    ?? updates.downloadedUpdate?.updateId
    ?? (updates.isUpdatePending ? updateIdFromManifest(updates.availableUpdate?.manifest) : null)
    ?? null;
  return {
    pending: !!updates.isUpdatePending || !!updates.downloadedUpdate,
    updateId,
  };
}

module.exports = {
  createOtaUpdateOwnerRunner,
  nativePendingFromUpdates,
};
