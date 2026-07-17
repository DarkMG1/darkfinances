'use strict';

/** @type {(() => boolean) | null} */
let retryHandler = null;
/** @type {(() => boolean) | null} */
let foregroundCoincidenceHandler = null;

function registerReconnectRefreshRetry(handler) {
  retryHandler = handler;
  return () => {
    if (retryHandler === handler) retryHandler = null;
  };
}

function registerReconnectForegroundCoincidence(handler) {
  foregroundCoincidenceHandler = handler;
  return () => {
    if (foregroundCoincidenceHandler === handler) foregroundCoincidenceHandler = null;
  };
}

function requestReconnectRefreshRetry() {
  return retryHandler?.() ?? false;
}

function noteReconnectForegroundCoincidence() {
  return foregroundCoincidenceHandler?.() ?? false;
}

function resetReconnectRefreshRegistryForTests() {
  retryHandler = null;
  foregroundCoincidenceHandler = null;
}

module.exports = {
  noteReconnectForegroundCoincidence,
  registerReconnectForegroundCoincidence,
  registerReconnectRefreshRetry,
  requestReconnectRefreshRetry,
  resetReconnectRefreshRegistryForTests,
};
