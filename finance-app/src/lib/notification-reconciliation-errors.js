'use strict';

const { isExpectedReconciliationError } = require('./notification-reconciliation');

const NOTIFICATION_RECONCILE_FAILED_CODE = 'NOTIFICATION_RECONCILE_FAILED';

function createRedactedNotificationReconciliationError(error) {
  const candidate = error && typeof error === 'object' ? error : {};
  const code = typeof candidate.code === 'string' && candidate.code.length > 0
    ? candidate.code
    : NOTIFICATION_RECONCILE_FAILED_CODE;
  if (code === 'NOTIFICATION_RECONCILIATION_STALE') {
    return null;
  }
  const status = Number.isInteger(candidate.status) ? candidate.status : 0;
  return {
    code: code.slice(0, 64),
    status,
    timestamp: Date.now(),
  };
}

function reportUnexpectedReconciliationError(error, recordDiagnostic) {
  if (isExpectedReconciliationError(error)) return;
  const redacted = createRedactedNotificationReconciliationError(error);
  if (!redacted) return;
  if (typeof recordDiagnostic === 'function') {
    recordDiagnostic(redacted);
  }
  if (typeof __DEV__ !== 'undefined' && __DEV__) {
    console.warn('[notifications] reconciliation failed', redacted.code);
  }
}

module.exports = {
  NOTIFICATION_RECONCILE_FAILED_CODE,
  createRedactedNotificationReconciliationError,
  reportUnexpectedReconciliationError,
};
