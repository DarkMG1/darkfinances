'use strict';

const DEFER_STORAGE_KEY = 'ota-update-deferred-v1';

function createOtaUpdatePersistence(store) {
  function readDeferred(now = Date.now()) {
    const raw = store.getString(DEFER_STORAGE_KEY);
    if (!raw) return null;
    try {
      const parsed = JSON.parse(raw);
      if (!parsed || typeof parsed !== 'object') return null;
      const updateId = typeof parsed.updateId === 'string' ? parsed.updateId : null;
      const deferredUntil = Number(parsed.deferredUntil);
      if (!updateId || !Number.isFinite(deferredUntil)) return null;
      if (deferredUntil <= now) {
        store.setString(DEFER_STORAGE_KEY, null);
        return null;
      }
      return { updateId, deferredUntil };
    } catch {
      store.setString(DEFER_STORAGE_KEY, null);
      return null;
    }
  }

  function writeDeferred(record) {
    if (!record?.updateId || !Number.isFinite(record.deferredUntil)) {
      store.setString(DEFER_STORAGE_KEY, null);
      return;
    }
    store.setString(DEFER_STORAGE_KEY, JSON.stringify({
      updateId: record.updateId,
      deferredUntil: record.deferredUntil,
    }));
  }

  function clearDeferred() {
    store.setString(DEFER_STORAGE_KEY, null);
  }

  return {
    clearDeferred,
    readDeferred,
    writeDeferred,
  };
}

module.exports = {
  DEFER_STORAGE_KEY,
  createOtaUpdatePersistence,
};
