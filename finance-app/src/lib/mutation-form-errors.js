const { firstInvalidField, mapContractIssuesToFieldErrors } = require('./mutation-form-field-paths');
const { OUTCOME_UNKNOWN_MESSAGE } = require('./request-operation-state');

const STALE_CODE_RE = /^(STALE_|VERSION_|.*_STALE$|.*_VERSION_CONFLICT$)/;
const SAGA_IN_PROGRESS_RE = /_(IN_PROGRESS|OUTCOME_UNKNOWN)$|^BULK_OPERATION_/;

function isOfflineError(error) {
  const message = String(error?.message || error?.error || '');
  if (error?.name === 'TypeError' && /network|fetch|failed/i.test(message)) return true;
  if (error?.code === 'NETWORK_ERROR') return true;
  return false;
}

function normalizeApiError(error) {
  const status = Number(error?.status);
  const code = typeof error?.code === 'string' ? error.code : '';
  const message = typeof error?.error === 'string'
    ? error.error
    : typeof error?.message === 'string'
      ? error.message
      : 'Something went wrong.';
  const issues = Array.isArray(error?.issues) ? error.issues : [];
  const requiresIdempotencyKeyReuse = error?.requiresIdempotencyKeyReuse === true;
  return {
    status: Number.isInteger(status) ? status : undefined,
    code,
    message,
    issues,
    requiresIdempotencyKeyReuse,
  };
}

function mapMutationApiError(error, options = {}) {
  const {
    fieldPathOverrides = {},
    fieldOrder = [],
    mutationLabel = 'Save',
  } = options;
  const api = normalizeApiError(error);
  const fieldErrors = mapContractIssuesToFieldErrors(api.issues, fieldPathOverrides);
  const firstField = firstInvalidField(fieldErrors, fieldOrder);

  if (isOfflineError(error)) {
    return {
      kind: 'offline',
      recoverable: true,
      retryable: true,
      requiresRefetch: false,
      closeOnSuccess: false,
      summary: 'You appear to be offline. Check your connection and try again.',
      fieldErrors,
      firstField,
      action: { label: 'Retry', kind: 'retry_same_key' },
      announce: 'Offline. Check your connection and try again.',
    };
  }

  if (api.code === 'TIMEOUT' || api.status === 408) {
    return {
      kind: 'timeout',
      recoverable: true,
      retryable: true,
      requiresRefetch: false,
      closeOnSuccess: false,
      summary: 'The request timed out. Your entries are still here — try again when the connection is stable.',
      fieldErrors,
      firstField,
      action: { label: 'Retry', kind: 'retry_same_key' },
      announce: 'Request timed out. Try again.',
    };
  }

  if (api.code === 'OUTCOME_UNKNOWN' || api.message === OUTCOME_UNKNOWN_MESSAGE) {
    return {
      kind: 'sync_unknown',
      recoverable: true,
      retryable: true,
      requiresRefetch: false,
      closeOnSuccess: false,
      summary: 'The server has not confirmed this change yet. Wait a moment, then retry to check status.',
      fieldErrors,
      firstField,
      action: { label: 'Check status and retry', kind: 'retry_same_key' },
      announce: 'Outcome unknown. Retry to check status.',
    };
  }

  if (api.code === 'OPERATION_NOT_FOUND') {
    return {
      kind: 'sync_unknown',
      recoverable: true,
      retryable: true,
      requiresRefetch: false,
      closeOnSuccess: false,
      summary: 'The server has no record of this request yet. Retry to check whether it completed.',
      fieldErrors,
      firstField,
      action: { label: 'Retry', kind: 'retry_same_key' },
      announce: 'Operation status unknown. Retry to check.',
    };
  }

  if (api.status === 401 || api.code === 'UNAUTHENTICATED') {
    return {
      kind: 'auth',
      recoverable: true,
      retryable: false,
      requiresRefetch: false,
      closeOnSuccess: false,
      summary: 'Your session expired. Reconnect in Settings, then try again.',
      fieldErrors,
      firstField,
      action: null,
      announce: 'Session expired. Reconnect in Settings.',
    };
  }

  if (api.status === 503 || api.code === 'ADMISSION_UNAVAILABLE') {
    return {
      kind: 'server_unavailable',
      recoverable: true,
      retryable: true,
      requiresRefetch: false,
      closeOnSuccess: false,
      summary: 'The server is temporarily unavailable. Try again in a moment.',
      fieldErrors,
      firstField,
      action: { label: 'Retry', kind: 'retry_same_key' },
      announce: 'Server unavailable. Try again shortly.',
    };
  }

  if (api.status === 429 || api.code === 'ADMISSION_OVERLOADED') {
    return {
      kind: 'admission_retry',
      recoverable: true,
      retryable: true,
      requiresRefetch: false,
      closeOnSuccess: false,
      summary: api.requiresIdempotencyKeyReuse
        ? 'The server is busy. Wait a moment, then tap Retry — your change is still saved here.'
        : 'The server is busy. Wait a moment, then try again.',
      fieldErrors,
      firstField,
      action: { label: 'Retry', kind: 'retry_same_key' },
      announce: 'Server busy. Retry shortly.',
    };
  }

  if (api.code === 'UNRESOLVED_OPERATION_PROFILE_LOCK') {
    return {
      kind: 'sync_unknown',
      recoverable: true,
      retryable: true,
      requiresRefetch: false,
      closeOnSuccess: false,
      summary: 'A previous change may still be finishing. Wait for it to complete, then retry.',
      fieldErrors,
      firstField,
      action: { label: 'Retry', kind: 'retry_same_key' },
      announce: 'Previous operation still finishing.',
    };
  }

  if (api.status === 409) {
    if (STALE_CODE_RE.test(api.code) || /stale|version/i.test(api.message)) {
      return {
        kind: 'conflict_stale',
        recoverable: true,
        retryable: false,
        requiresRefetch: true,
        closeOnSuccess: false,
        summary: 'This record changed on the server. Refreshing latest data — review your entries and try again.',
        fieldErrors,
        firstField,
        action: { label: 'Refresh', kind: 'refetch' },
        announce: 'Record changed on server. Data refreshed.',
      };
    }
    if (SAGA_IN_PROGRESS_RE.test(api.code) || /in progress/i.test(api.message)) {
      return {
        kind: 'conflict_saga',
        recoverable: true,
        retryable: true,
        requiresRefetch: true,
        closeOnSuccess: false,
        summary: 'Another update is still running for this item. Wait, then retry.',
        fieldErrors,
        firstField,
        action: { label: 'Retry', kind: 'retry_same_key' },
        announce: 'Update in progress. Retry shortly.',
      };
    }
    if (/ownership|not allowed|forbidden/i.test(api.message) || api.code === 'NOT_ALLOWED') {
      return {
        kind: 'conflict_ownership',
        recoverable: false,
        retryable: false,
        requiresRefetch: true,
        closeOnSuccess: false,
        summary: api.message || 'You cannot change this item.',
        fieldErrors,
        firstField,
        action: { label: 'Refresh', kind: 'refetch' },
        announce: 'Change not allowed.',
      };
    }
    return {
      kind: 'conflict_stale',
      recoverable: true,
      retryable: false,
      requiresRefetch: true,
      closeOnSuccess: false,
      summary: api.message || 'This changed on the server. Refresh and try again.',
      fieldErrors,
      firstField,
      action: { label: 'Refresh', kind: 'refetch' },
      announce: 'Conflict. Refresh and try again.',
    };
  }

  if (api.code === 'INVALID_REQUEST' || (api.status === 400 && Object.keys(fieldErrors).length)) {
    const summary = Object.keys(fieldErrors).length
      ? `Fix the highlighted fields and ${mutationLabel.toLowerCase()} again.`
      : api.message || 'Check your entries and try again.';
    return {
      kind: 'validation',
      recoverable: true,
      retryable: false,
      requiresRefetch: false,
      closeOnSuccess: false,
      summary,
      fieldErrors,
      firstField,
      action: null,
      announce: summary,
    };
  }

  if (api.status === 400) {
    return {
      kind: 'validation',
      recoverable: true,
      retryable: false,
      requiresRefetch: false,
      closeOnSuccess: false,
      summary: api.message || 'Check your entries and try again.',
      fieldErrors,
      firstField,
      action: null,
      announce: api.message || 'Validation failed.',
    };
  }

  if (api.status != null && api.status >= 400 && api.status <= 499) {
    return {
      kind: 'terminal',
      recoverable: false,
      retryable: false,
      requiresRefetch: false,
      closeOnSuccess: false,
      summary: api.message || `${mutationLabel} failed.`,
      fieldErrors,
      firstField,
      action: null,
      announce: api.message || `${mutationLabel} failed.`,
    };
  }

  return {
    kind: 'server_unavailable',
    recoverable: true,
    retryable: true,
    requiresRefetch: false,
    closeOnSuccess: false,
    summary: 'Something went wrong. Try again when the connection is stable.',
    fieldErrors,
    firstField,
    action: { label: 'Retry', kind: 'retry_same_key' },
    announce: 'Something went wrong. Try again.',
  };
}

function mapClientValidationOutcome(fieldErrors, fieldOrder = []) {
  const firstField = firstInvalidField(fieldErrors, fieldOrder);
  const count = Object.keys(fieldErrors).length;
  const summary = count === 1
    ? Object.values(fieldErrors)[0]
    : `Fix ${count} fields before saving.`;
  return {
    kind: 'client_validation',
    recoverable: true,
    retryable: false,
    requiresRefetch: false,
    closeOnSuccess: false,
    summary,
    fieldErrors,
    firstField,
    action: null,
    announce: summary,
  };
}

module.exports = {
  isOfflineError,
  mapClientValidationOutcome,
  mapMutationApiError,
  normalizeApiError,
};
