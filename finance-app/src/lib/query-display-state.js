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
 * >} queries
 */
function collectRefetchErrorQueries(queries) {
  return queries
    .filter((entry) => {
      const query = entry?.query ?? entry;
      const enabled = entry?.enabled ?? true;
      if (!enabled) return false;
      return shouldShowRefetchError(!!query.isError, query.data);
    })
    .map((entry) => entry?.query ?? entry);
}

module.exports = {
  hasQueryData,
  shouldShowInitialLoad,
  shouldShowFatalError,
  shouldShowRefetchError,
  isSearchQuerySettled,
  queryErrorMessage,
  collectRefetchErrorQueries,
};
