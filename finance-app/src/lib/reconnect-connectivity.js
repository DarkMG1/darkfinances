'use strict';

const RECONNECT_CONNECTIVITY_PHASES = ['unknown', 'offline', 'online'];

/**
 * Reachability snapshot from NetInfo (or test doubles).
 * @typedef {{ isConnected: boolean | null, isInternetReachable: boolean | null }} ConnectivitySnapshot
 */

/**
 * Positive online requires connected plus confirmed internet reachability.
 * @param {ConnectivitySnapshot} snapshot
 */
function classifyConnectivityPhase(snapshot) {
  if (snapshot?.isConnected === false) return 'offline';
  if (snapshot?.isConnected === true && snapshot?.isInternetReachable === false) return 'offline';
  if (snapshot?.isConnected === true && snapshot?.isInternetReachable === true) return 'online';
  return 'unknown';
}

/**
 * Tracks confirmed offline→online transitions without reacting to initial unknown or
 * ambiguous reachability.
 */
function createConnectivityTracker(options = {}) {
  let phase = options.initialPhase ?? 'unknown';
  /** @type {ConnectivitySnapshot | null} */
  let lastSnapshot = options.initialSnapshot ?? null;

  function applySnapshot(snapshot) {
    const previousPhase = phase;
    const nextPhase = classifyConnectivityPhase(snapshot);
    phase = nextPhase;
    lastSnapshot = snapshot;
    return {
      previousPhase,
      phase: nextPhase,
      confirmedOfflineToOnline: previousPhase === 'offline' && nextPhase === 'online',
      snapshot,
    };
  }

  return {
    getPhase: () => phase,
    getSnapshot: () => lastSnapshot,
    applySnapshot,
    classifyConnectivityPhase,
  };
}

module.exports = {
  RECONNECT_CONNECTIVITY_PHASES,
  classifyConnectivityPhase,
  createConnectivityTracker,
};
