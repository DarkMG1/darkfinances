'use strict';

/** @type {() => number} */
let readProfileGeneration = () => 0;

/** @type {Set<string>} */
const suspendedScopes = new Set();

function bindProfileGenerationReader(reader) {
  readProfileGeneration = reader;
}

function resetNotificationScopeSuspensions() {
  suspendedScopes.clear();
}

function suspendNotificationScope(scope) {
  if (scope) suspendedScopes.add(scope);
}

function isNotificationScopeSuspended(scope) {
  return scope ? suspendedScopes.has(scope) : false;
}

function isNotificationScopeAdmissionAllowed(scope) {
  return !isNotificationScopeSuspended(scope);
}

/** Clears a purge tombstone after deliberate profile activation at the current generation. */
function activateNotificationScope(scope, generation) {
  if (!scope) return;
  if (!suspendedScopes.has(scope)) return;
  if (generation !== readProfileGeneration()) return;
  suspendedScopes.delete(scope);
}

function assertScopeReconciliationAdmitted(scope) {
  if (!isNotificationScopeAdmissionAllowed(scope)) {
    const error = new Error('NOTIFICATION_RECONCILIATION_STALE');
    error.code = 'NOTIFICATION_RECONCILIATION_STALE';
    throw error;
  }
}

module.exports = {
  activateNotificationScope,
  assertScopeReconciliationAdmitted,
  bindProfileGenerationReader,
  isNotificationScopeAdmissionAllowed,
  isNotificationScopeSuspended,
  resetNotificationScopeSuspensions,
  suspendNotificationScope,
};
