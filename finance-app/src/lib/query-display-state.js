/**
 * Pure helpers for query loading/error gates that keep cached data visible on refetch failure.
 */

function hasQueryData(data) {
  return data != null;
}

function shouldShowInitialLoad(isLoading, data) {
  return !!isLoading && !hasQueryData(data);
}

function shouldShowFatalError(isError, data) {
  return !!isError && !hasQueryData(data);
}

function shouldShowRefetchError(isError, data) {
  return !!isError && hasQueryData(data);
}

/** Pure gate for when QueryScreenBody may invoke renderContent (tested without React). */
function shouldInvokeQueryScreenContent(display, hasContent) {
  if (display.initialLoad || display.fatalError) return false;
  if (!hasContent || display.data == null) return false;
  return true;
}

function isSearchQuerySettled(inputQuery, activeQuery) {
  const trimmed = String(inputQuery ?? '').trim();
  if (trimmed.length < 2) return true;
  return activeQuery === trimmed;
}

function queryErrorMessage(error) {
  if (error == null || typeof error !== 'object') return undefined;
  return /** @type {{ error?: string }} */ (error).error;
}

/**
 * @param {Array<
 *   | { isError?: boolean; data?: unknown; refetch?: () => unknown }
 *   | { query: { isError?: boolean; data?: unknown; refetch?: () => unknown }; enabled?: boolean }
 * >} entries
 */
function isRefetchEntryEnabled(entry) {
  return entry?.enabled ?? true;
}

/**
 * @param {Array<
 *   | { isError?: boolean; data?: unknown; refetch?: () => unknown }
 *   | { query: { isError?: boolean; data?: unknown; refetch?: () => unknown }; enabled?: boolean }
 * >} entry
 */
function unwrapRefetchQuery(entry) {
  return entry?.query ?? entry;
}

/**
 * @param {Array<
 *   | { isError?: boolean; data?: unknown; refetch?: () => unknown }
 *   | { query: { isError?: boolean; data?: unknown; refetch?: () => unknown }; enabled?: boolean }
 * >} entries
 */
function collectEnabledRefetchQueries(entries) {
  return entries
    .filter(isRefetchEntryEnabled)
    .map(unwrapRefetchQuery);
}

/**
 * @param {Array<
 *   | { isError?: boolean; data?: unknown; refetch?: () => unknown }
 *   | { query: { isError?: boolean; data?: unknown; refetch?: () => unknown }; enabled?: boolean }
 * >} queries
 */
function collectRefetchErrorQueries(queries) {
  return queries
    .filter((entry) => {
      if (!isRefetchEntryEnabled(entry)) return false;
      const query = unwrapRefetchQuery(entry);
      return shouldShowRefetchError(!!query.isError, query.data);
    })
    .map(unwrapRefetchQuery);
}

module.exports = {
  hasQueryData,
  shouldShowInitialLoad,
  shouldShowFatalError,
  shouldShowRefetchError,
  shouldInvokeQueryScreenContent,
  isSearchQuerySettled,
  queryErrorMessage,
  isRefetchEntryEnabled,
  unwrapRefetchQuery,
  collectEnabledRefetchQueries,
  collectRefetchErrorQueries,
};
