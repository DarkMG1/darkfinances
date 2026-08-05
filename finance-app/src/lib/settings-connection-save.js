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

const CONNECTION_CONTROL_SPECS = Object.freeze({
  [CONNECTION_SAVE_ACTIONS.TEST]: {
    idleLabel: 'Test Connection',
    inProgressLabel: 'Testing connection',
    progressPhrase: 'testing connection',
  },
  [CONNECTION_SAVE_ACTIONS.SAVE_URL]: {
    idleLabel: 'Save URL',
    inProgressLabel: 'Saving server URL',
    progressPhrase: 'saving server URL',
  },
  [CONNECTION_SAVE_ACTIONS.SAVE_TOKEN]: {
    idleLabel: 'Update Token',
    inProgressLabel: 'Updating token',
    progressPhrase: 'updating token',
  },
  [CONNECTION_SAVE_ACTIONS.DEMO]: {
    idleLabel: 'Demo mode',
    inProgressLabel: 'Changing demo mode',
    progressPhrase: 'changing demo mode',
  },
  [CONNECTION_SAVE_ACTIONS.FACE_ID]: {
    idleLabel: 'Biometric lock',
    inProgressLabel: 'Updating biometric lock',
    progressPhrase: 'updating biometric lock',
  },
  [CONNECTION_SAVE_ACTIONS.DISCONNECT]: {
    idleLabel: 'Disconnect',
    inProgressLabel: 'Disconnecting',
    progressPhrase: 'disconnecting',
  },
});

function settingsConnectionProgressPhrase(action) {
  return CONNECTION_CONTROL_SPECS[action]?.progressPhrase ?? 'a connection change';
}

function connectionControlAccessibilityLabel(controlAction, busyOwner, overrides = {}) {
  const spec = CONNECTION_CONTROL_SPECS[controlAction];
  const idle = overrides.idleLabel ?? spec?.idleLabel ?? 'Control';
  const inProgress = overrides.inProgressLabel ?? spec?.inProgressLabel ?? idle;
  if (!busyOwner) return idle;
  if (busyOwner.action === controlAction) return inProgress;
  return `${idle} unavailable while ${settingsConnectionProgressPhrase(busyOwner.action)}`;
}

function connectionButtonControlState(controlAction, busyOwner) {
  const spec = CONNECTION_CONTROL_SPECS[controlAction];
  const owns = busyOwner?.action === controlAction;
  return {
    disabled: busyOwner != null,
    busy: owns,
    showSpinner: owns,
    visibleLabel: spec?.idleLabel ?? 'Control',
    accessibilityLabel: connectionControlAccessibilityLabel(controlAction, busyOwner),
  };
}

function connectionSwitchAccessibilityLabel(controlAction, busyOwner, overrides = {}) {
  return connectionControlAccessibilityLabel(controlAction, busyOwner, overrides);
}

function disconnectButtonAccessibilityLabel(busyOwner) {
  return connectionControlAccessibilityLabel(CONNECTION_SAVE_ACTIONS.DISCONNECT, busyOwner);
}

function disconnectButtonVisibleLabel(busyOwner) {
  return busyOwner?.action === CONNECTION_SAVE_ACTIONS.DISCONNECT ? 'Disconnecting…' : 'Disconnect';
}

function settingsConnectionSaveSkippedMessage(action, biometricLabel = 'Biometric') {
  switch (action) {
    case CONNECTION_SAVE_ACTIONS.DISCONNECT:
      return 'Could not disconnect — another connection change is in progress. Try again shortly.';
    case CONNECTION_SAVE_ACTIONS.FACE_ID:
      return `Could not update ${biometricLabel} lock — another connection change is in progress. Try again shortly.`;
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
  CONNECTION_CONTROL_SPECS,
  connectionButtonControlState,
  connectionControlAccessibilityLabel,
  connectionSwitchAccessibilityLabel,
  createSettingsConnectionSaveAdmission,
  disconnectButtonAccessibilityLabel,
  disconnectButtonVisibleLabel,
  tryAcquireSettingsConnectionSave,
  releaseSettingsConnectionSave,
  isSettingsConnectionSaveBusy,
  runSettingsConnectionSave,
  resetSettingsConnectionLeaseCounter,
  settingsConnectionProgressPhrase,
  settingsConnectionSaveSkippedMessage,
};
