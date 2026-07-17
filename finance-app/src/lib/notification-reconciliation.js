'use strict';

const {
  activateNotificationScope,
  assertScopeReconciliationAdmitted,
  bindNotificationScopeSuspensionPersistence,
  bindProfileGenerationReader,
  hasPersistedSuspensionEvidence,
  isNotificationScopeAdmissionAllowed,
  isNotificationScopeSuspended,
  NOTIFICATION_SCOPE_SUSPENSION_PERSISTENCE_REQUIRED,
  readPersistedSuspensionGeneration,
  resetNotificationScopeSuspensions,
  simulateNotificationScopeSuspensionModuleReset,
  suspendNotificationScope,
} = require('./notification-scope-suspension');

const NOTIFICATION_RECONCILIATION_STALE_CODE = 'NOTIFICATION_RECONCILIATION_STALE';

/** @typedef {'scheduled' | 'event'} ReconciliationLane */

const RECONCILIATION_LANES = ['scheduled', 'event'];

let profileGeneration = 0;
/** @type {Record<ReconciliationLane, number>} */
const laneSessionIds = {
  scheduled: 0,
  event: 0,
};
/** @type {Record<ReconciliationLane, { generation: number, sessionId: number, cancelled: boolean } | null>} */
const activeSessions = {
  scheduled: null,
  event: null,
};
const generationListeners = new Set();

bindProfileGenerationReader(() => profileGeneration);

function subscribeProfileGeneration(listener) {
  generationListeners.add(listener);
  return () => generationListeners.delete(listener);
}

function notifyProfileGenerationChanged() {
  generationListeners.forEach((listener) => listener());
}

function getProfileGeneration() {
  return profileGeneration;
}

function getReconciliationSessionId(lane = 'scheduled') {
  return laneSessionIds[lane];
}

/**
 * @param {ReconciliationLane} lane
 * @param {number} [generation]
 * @param {number} [sessionId]
 * @param {string} [scope]
 */
function createReconciliationToken(lane, generation = profileGeneration, sessionId = laneSessionIds[lane], scope = 'default') {
  return { lane, generation, sessionId, scope };
}

function bumpProfileGeneration() {
  profileGeneration += 1;
  notifyProfileGenerationChanged();
  return profileGeneration;
}

function cancelReconciliationLane(lane) {
  if (activeSessions[lane]) {
    activeSessions[lane].cancelled = true;
  }
}

function cancelReconciliation(token) {
  if (!token?.lane) return;
  cancelReconciliationLane(token.lane);
}

function cancelAllReconciliationLanes() {
  for (const lane of RECONCILIATION_LANES) {
    cancelReconciliationLane(lane);
  }
}

function isReconciliationCurrent(token) {
  if (
    token == null
    || typeof token.generation !== 'number'
    || typeof token.sessionId !== 'number'
    || typeof token.lane !== 'string'
  ) {
    return false;
  }
  if (isNotificationScopeSuspended(token.scope)) return false;
  const active = activeSessions[token.lane];
  return (
    token.generation === profileGeneration
    && active != null
    && active.sessionId === token.sessionId
    && !active.cancelled
  );
}

function assertReconciliationCurrent(token) {
  if (!isReconciliationCurrent(token)) {
    const error = new Error(NOTIFICATION_RECONCILIATION_STALE_CODE);
    error.code = NOTIFICATION_RECONCILIATION_STALE_CODE;
    throw error;
  }
}

/**
 * @param {ReconciliationLane} lane
 * @param {number} [generation]
 * @param {string} [scope]
 */
function beginReconciliation(lane, generation = profileGeneration, scope = 'default') {
  assertScopeReconciliationAdmitted(scope);
  cancelReconciliationLane(lane);
  laneSessionIds[lane] += 1;
  activeSessions[lane] = {
    generation,
    sessionId: laneSessionIds[lane],
    cancelled: false,
  };
  return createReconciliationToken(lane, generation, laneSessionIds[lane], scope);
}

function endReconciliation(token) {
  if (!token?.lane) return;
  const active = activeSessions[token.lane];
  if (active && active.sessionId === token.sessionId) {
    activeSessions[token.lane] = null;
  }
}

async function withReconciliationGuard(token, fn) {
  assertReconciliationCurrent(token);
  const value = await fn();
  assertReconciliationCurrent(token);
  return value;
}

/**
 * Suspend scope synchronously, cancel lanes, then bump generation before any purge awaits.
 * @param {string} [scope]
 */
function purgeProfileGeneration(scope) {
  suspendNotificationScope(scope);
  cancelAllReconciliationLanes();
  return bumpProfileGeneration();
}

function isStaleGeneration(generation) {
  return generation !== profileGeneration;
}

function isExpectedReconciliationError(error) {
  return error?.code === NOTIFICATION_RECONCILIATION_STALE_CODE;
}

function resetNotificationReconciliationState() {
  profileGeneration = 0;
  for (const lane of RECONCILIATION_LANES) {
    laneSessionIds[lane] = 0;
    activeSessions[lane] = null;
  }
  generationListeners.clear();
  resetNotificationScopeSuspensions();
}

/** @deprecated use cancelReconciliation(token) or cancelReconciliationLane(lane) */
function cancelActiveReconciliation() {
  cancelAllReconciliationLanes();
}

module.exports = {
  NOTIFICATION_RECONCILIATION_STALE_CODE,
  NOTIFICATION_SCOPE_SUSPENSION_PERSISTENCE_REQUIRED,
  RECONCILIATION_LANES,
  activateNotificationScope,
  assertReconciliationCurrent,
  beginReconciliation,
  bindNotificationScopeSuspensionPersistence,
  bumpProfileGeneration,
  cancelActiveReconciliation,
  cancelAllReconciliationLanes,
  cancelReconciliation,
  cancelReconciliationLane,
  createReconciliationToken,
  endReconciliation,
  getProfileGeneration,
  getReconciliationSessionId,
  hasPersistedSuspensionEvidence,
  isExpectedReconciliationError,
  isNotificationScopeAdmissionAllowed,
  isNotificationScopeSuspended,
  isReconciliationCurrent,
  isStaleGeneration,
  purgeProfileGeneration,
  readPersistedSuspensionGeneration,
  resetNotificationReconciliationState,
  simulateNotificationScopeSuspensionModuleReset,
  subscribeProfileGeneration,
  suspendNotificationScope,
  withReconciliationGuard,
};
