'use strict';

const SUSPENSION_KEY_PREFIX = 'notif.purgeSuspension.v1.';
const NOTIFICATION_SCOPE_SUSPENSION_PERSISTENCE_REQUIRED = 'NOTIFICATION_SCOPE_SUSPENSION_PERSISTENCE_REQUIRED';

/** @type {() => number} */
let readProfileGeneration = () => 0;

/** @type {Set<string>} */
const suspendedScopes = new Set();

/** @type {{ kv: { getString: (key: string) => string | null, setString: (key: string, value: string | null) => void }, storage: { getAllKeys: () => string[], remove: (key: string) => void } } | null} */
let persistence = null;

function bindProfileGenerationReader(reader) {
  readProfileGeneration = reader;
}

function bindNotificationScopeSuspensionPersistence(next) {
  persistence = next;
}

function suspensionKey(scope) {
  return `${SUSPENSION_KEY_PREFIX}${scope}`;
}

function hasPersistedSuspensionEvidence(scope) {
  if (!persistence?.kv || !scope) return false;
  return persistence.kv.getString(suspensionKey(scope)) != null;
}

function readPersistedSuspensionGeneration(scope) {
  if (!persistence?.kv || !scope) return null;
  const raw = persistence.kv.getString(suspensionKey(scope));
  if (raw == null) return null;
  const generation = Number(raw);
  return Number.isFinite(generation) ? generation : null;
}

function writePersistedSuspension(scope, generation) {
  if (!scope) return;
  if (!persistence?.kv) {
    const error = new Error(NOTIFICATION_SCOPE_SUSPENSION_PERSISTENCE_REQUIRED);
    error.code = NOTIFICATION_SCOPE_SUSPENSION_PERSISTENCE_REQUIRED;
    throw error;
  }
  persistence.kv.setString(suspensionKey(scope), String(generation));
}

function clearPersistedSuspension(scope) {
  if (!persistence?.kv || !scope) return;
  persistence.kv.setString(suspensionKey(scope), null);
}

function resetNotificationScopeSuspensions() {
  if (persistence?.storage) {
    for (const key of persistence.storage.getAllKeys()) {
      if (key.startsWith(SUSPENSION_KEY_PREFIX)) {
        persistence.storage.remove(key);
      }
    }
  }
  suspendedScopes.clear();
}

/** Clears in-memory cache only; persisted tombstones survive process restart. */
function simulateNotificationScopeSuspensionModuleReset() {
  suspendedScopes.clear();
}

function suspendNotificationScope(scope) {
  if (!scope) return;
  const generation = readProfileGeneration();
  writePersistedSuspension(scope, generation);
  suspendedScopes.add(scope);
}

function isNotificationScopeSuspended(scope) {
  if (!scope) return false;
  if (suspendedScopes.has(scope)) return true;
  return hasPersistedSuspensionEvidence(scope);
}

function isNotificationScopeAdmissionAllowed(scope) {
  return !isNotificationScopeSuspended(scope);
}

/** Clears a purge tombstone after deliberate profile activation at the current generation. */
function activateNotificationScope(scope, generation) {
  if (!scope) return;
  if (!isNotificationScopeSuspended(scope)) return;
  if (generation !== readProfileGeneration()) return;
  suspendedScopes.delete(scope);
  clearPersistedSuspension(scope);
}

function assertScopeReconciliationAdmitted(scope) {
  if (!isNotificationScopeAdmissionAllowed(scope)) {
    const error = new Error('NOTIFICATION_RECONCILIATION_STALE');
    error.code = 'NOTIFICATION_RECONCILIATION_STALE';
    throw error;
  }
}

module.exports = {
  NOTIFICATION_SCOPE_SUSPENSION_PERSISTENCE_REQUIRED,
  SUSPENSION_KEY_PREFIX,
  activateNotificationScope,
  assertScopeReconciliationAdmitted,
  bindNotificationScopeSuspensionPersistence,
  bindProfileGenerationReader,
  hasPersistedSuspensionEvidence,
  isNotificationScopeAdmissionAllowed,
  isNotificationScopeSuspended,
  readPersistedSuspensionGeneration,
  resetNotificationScopeSuspensions,
  simulateNotificationScopeSuspensionModuleReset,
  suspendNotificationScope,
};
