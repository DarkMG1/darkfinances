/**
 * Synchronous admission guard for Settings connection verify/purge/setConfig saves.
 */

function createSettingsConnectionSaveAdmission() {
  let busy = false;
  return {
    tryAcquire() {
      if (busy) return false;
      busy = true;
      return true;
    },
    release() {
      busy = false;
    },
    isBusy() {
      return busy;
    },
  };
}

async function runSettingsConnectionSave(admission, task) {
  if (!admission.tryAcquire()) return { ok: false, skipped: true };
  try {
    const result = await task();
    return { ok: true, skipped: false, result };
  } finally {
    admission.release();
  }
}

module.exports = {
  createSettingsConnectionSaveAdmission,
  runSettingsConnectionSave,
};
