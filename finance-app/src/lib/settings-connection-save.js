/**
 * Synchronous admission guard for Settings connection verify/purge/setConfig saves.
 * Owner lease ids prevent stale finally handlers from clearing a newer holder's busy UI.
 */

let nextSettingsConnectionLeaseId = 1;

const CONNECTION_SAVE_ACTIONS = Object.freeze({
  TEST: 'test',
  SAVE_URL: 'save-url',
  SAVE_TOKEN: 'save-token',
  DEMO: 'demo',
  FACE_ID: 'face-id',
  DISCONNECT: 'disconnect',
});

function settingsConnectionSaveSkippedMessage(action) {
  switch (action) {
    case CONNECTION_SAVE_ACTIONS.DISCONNECT:
      return 'Could not disconnect — another connection change is in progress. Try again shortly.';
    case CONNECTION_SAVE_ACTIONS.FACE_ID:
      return 'Could not update Face ID lock — another connection change is in progress. Try again shortly.';
    case CONNECTION_SAVE_ACTIONS.SAVE_URL:
      return 'Could not save server URL — another connection change is in progress. Try again shortly.';
    case CONNECTION_SAVE_ACTIONS.SAVE_TOKEN:
      return 'Could not update token — another connection change is in progress. Try again shortly.';
    case CONNECTION_SAVE_ACTIONS.DEMO:
      return 'Could not change demo mode — another connection change is in progress. Try again shortly.';
    case CONNECTION_SAVE_ACTIONS.TEST:
      return 'Could not test connection — another connection change is in progress. Try again shortly.';
    default:
      return 'Another connection change is in progress. Try again shortly.';
  }
}

function disconnectButtonAccessibilityLabel(busyOwner) {
  if (!busyOwner) return 'Disconnect';
  if (busyOwner.action === CONNECTION_SAVE_ACTIONS.DISCONNECT) return 'Disconnecting';
  return 'Disconnect unavailable while a connection change is in progress';
}

function createSettingsConnectionSaveAdmission() {
  return { ownerLease: null };
}

function tryAcquireSettingsConnectionSave(admission) {
  if (!admission || admission.ownerLease != null) return null;
  const lease = nextSettingsConnectionLeaseId++;
  admission.ownerLease = lease;
  return lease;
}

function releaseSettingsConnectionSave(admission, lease) {
  if (!admission || lease == null) return;
  if (admission.ownerLease === lease) {
    admission.ownerLease = null;
  }
}

function isSettingsConnectionSaveBusy(admission) {
  return admission?.ownerLease != null;
}

async function runSettingsConnectionSave(admission, task, hooks = {}) {
  const lease = tryAcquireSettingsConnectionSave(admission);
  if (lease == null) return { ok: false, skipped: true, lease: null };
  hooks.onAcquired?.(lease);
  try {
    const result = await task();
    return { ok: true, skipped: false, lease, result };
  } catch (error) {
    return { ok: false, skipped: false, lease, error };
  } finally {
    releaseSettingsConnectionSave(admission, lease);
    hooks.onReleased?.(lease);
  }
}

function resetSettingsConnectionLeaseCounter() {
  nextSettingsConnectionLeaseId = 1;
}

module.exports = {
  CONNECTION_SAVE_ACTIONS,
  createSettingsConnectionSaveAdmission,
  disconnectButtonAccessibilityLabel,
  tryAcquireSettingsConnectionSave,
  releaseSettingsConnectionSave,
  isSettingsConnectionSaveBusy,
  runSettingsConnectionSave,
  resetSettingsConnectionLeaseCounter,
  settingsConnectionSaveSkippedMessage,
};
