const {
  shouldShowFatalError,
  shouldShowInitialLoad,
  shouldShowRefetchError,
} = require('./query-display-state.js');

/**
 * Reconcile-enabled toggle reads server state via useReconcilePending.
 * Fatal failure must not default the switch to "off".
 *
 * @param {{ isLoading?: boolean; isError?: boolean; error?: unknown; data?: { enabled?: boolean } | null; refetch?: () => unknown }} reconPending
 * @param {boolean | null} localOverride optimistic/local override while mutating
 */
function resolveReconcileEnabledSetting(reconPending, localOverride) {
  const data = reconPending.data;
  return {
    initialLoad: shouldShowInitialLoad(!!reconPending.isLoading, data),
    fatalError: shouldShowFatalError(!!reconPending.isError, data),
    refetchError: shouldShowRefetchError(!!reconPending.isError, data),
    enabled: localOverride ?? !!reconPending.data?.enabled,
    switchDisabled: shouldShowInitialLoad(!!reconPending.isLoading, data)
      || shouldShowFatalError(!!reconPending.isError, data),
    misrepresentsWhenFatal: shouldShowFatalError(!!reconPending.isError, data),
  };
}

const SETTINGS_QUERY_EXCLUSION = {
  file: 'src/app/(tabs)/settings.tsx',
  reason: 'Primarily local config and diagnostics; reconcile-enabled reads useReconcilePending with fatal/refetch gates in settings-query-display.js',
};

module.exports = {
  resolveReconcileEnabledSetting,
  SETTINGS_QUERY_EXCLUSION,
};
