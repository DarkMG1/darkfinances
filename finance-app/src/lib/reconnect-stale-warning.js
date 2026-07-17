'use strict';

const RECONNECT_REFRESH_STALE_CODE = 'RECONNECT_REFRESH_STALE';
const RECONNECT_REFRESH_ABORTED_CODE = 'RECONNECT_REFRESH_ABORTED';

/**
 * @typedef {{
 *   scope: string;
 *   code: string;
 *   status?: number;
 *   at: number;
 * }} ReconnectStaleWarning
 */

function numericHttpStatus(error) {
  const candidate = Number(error?.status);
  return Number.isInteger(candidate) && candidate >= 100 && candidate <= 599
    ? candidate
    : undefined;
}

function classifyReconnectRefreshError(error) {
  if (error?.code === RECONNECT_REFRESH_ABORTED_CODE) {
    return { code: RECONNECT_REFRESH_ABORTED_CODE };
  }
  if (error?.code === RECONNECT_REFRESH_STALE_CODE) {
    return { code: RECONNECT_REFRESH_STALE_CODE };
  }
  if (error?.code === 'TIMEOUT') {
    return { code: 'RECONNECT_SOURCE_TIMEOUT', status: 408 };
  }
  const status = numericHttpStatus(error);
  if (status === 401 || status === 403) {
    return { code: 'RECONNECT_SOURCE_AUTH', status };
  }
  if (error?.code === 'RECONNECT_REFETCH_FAILED') {
    return { code: 'RECONNECT_REFETCH_FAILED', status };
  }
  if (status === 503) {
    return { code: 'RECONNECT_SOURCE_NOT_READY', status };
  }
  return { code: 'RECONNECT_REFRESH_FAILED', status };
}

function createReconnectStaleWarningStore(options = {}) {
  const now = options.now ?? (() => Date.now());
  /** @type {Map<string, ReconnectStaleWarning>} */
  const warnings = new Map();
  const listeners = new Set();

  function notify() {
    for (const listener of listeners) listener();
  }

  return {
    subscribe(listener) {
      listeners.add(listener);
      return () => listeners.delete(listener);
    },
    get(scope) {
      return warnings.get(scope) ?? null;
    },
    set(scope, error) {
      if (!scope) return null;
      const classified = classifyReconnectRefreshError(error);
      if (classified.code === RECONNECT_REFRESH_ABORTED_CODE || classified.code === RECONNECT_REFRESH_STALE_CODE) {
        return null;
      }
      const warning = {
        scope,
        code: classified.code,
        ...(classified.status != null ? { status: classified.status } : {}),
        at: now(),
      };
      warnings.set(scope, warning);
      notify();
      return warning;
    },
    clear(scope) {
      if (!scope || !warnings.has(scope)) return false;
      warnings.delete(scope);
      notify();
      return true;
    },
    purge(scope) {
      if (scope) warnings.delete(scope);
      else warnings.clear();
      notify();
    },
    redactForDisplay(warning) {
      if (!warning) return null;
      return {
        code: warning.code,
        status: warning.status,
        at: warning.at,
      };
    },
  };
}

module.exports = {
  RECONNECT_REFRESH_ABORTED_CODE,
  RECONNECT_REFRESH_STALE_CODE,
  classifyReconnectRefreshError,
  createReconnectStaleWarningStore,
};
