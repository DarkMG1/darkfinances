'use strict';

const { purgeReconnectRefreshOwnerProfile } = require('./reconnect-refresh-owner-runtime');

/** @type {(() => boolean) | null} */
let retryHandler = null;
/** @type {(() => boolean) | null} */
let foregroundCoincidenceHandler = null;
/** @type {(() => boolean) | null} */
let serverRecoveryHandler = null;
/** @type {(() => string) | null} */
let connectivityPhaseHandler = null;

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

function registerReconnectServerRecovery(handler) {
  serverRecoveryHandler = handler;
  return () => {
    if (serverRecoveryHandler === handler) serverRecoveryHandler = null;
  };
}

function registerReconnectConnectivityPhase(handler) {
  connectivityPhaseHandler = handler;
  return () => {
    if (connectivityPhaseHandler === handler) connectivityPhaseHandler = null;
  };
}

function requestReconnectRefreshRetry() {
  return retryHandler?.() ?? false;
}

function noteReconnectForegroundCoincidence() {
  return foregroundCoincidenceHandler?.() ?? false;
}

function requestReconnectServerRecovery() {
  return serverRecoveryHandler?.() ?? false;
}

function getReconnectConnectivityPhase() {
  return connectivityPhaseHandler?.() ?? 'unknown';
}

function purgeReconnectRefreshProfileState(scope) {
  purgeReconnectRefreshOwnerProfile(scope);
}

function resetReconnectRefreshRegistryForTests() {
  retryHandler = null;
  foregroundCoincidenceHandler = null;
  serverRecoveryHandler = null;
  connectivityPhaseHandler = null;
}

module.exports = {
  getReconnectConnectivityPhase,
  noteReconnectForegroundCoincidence,
  purgeReconnectRefreshProfileState,
  registerReconnectConnectivityPhase,
  registerReconnectForegroundCoincidence,
  registerReconnectRefreshRetry,
  registerReconnectServerRecovery,
  requestReconnectRefreshRetry,
  requestReconnectServerRecovery,
  resetReconnectRefreshRegistryForTests,
};
