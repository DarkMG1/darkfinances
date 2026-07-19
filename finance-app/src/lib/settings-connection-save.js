/**
 * Synchronous admission guard for Settings connection verify/purge/setConfig saves.
 * Owner lease ids prevent stale finally handlers from clearing a newer holder's busy UI.
 */

let nextSettingsConnectionLeaseId = 1;

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
  createSettingsConnectionSaveAdmission,
  tryAcquireSettingsConnectionSave,
  releaseSettingsConnectionSave,
  isSettingsConnectionSaveBusy,
  runSettingsConnectionSave,
  resetSettingsConnectionLeaseCounter,
};
