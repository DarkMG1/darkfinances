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
 * @param {Array<{ isError?: boolean; data?: unknown; refetch?: () => unknown }>} queries
 */
function collectRefetchErrorQueries(queries) {
  return queries.filter((query) => shouldShowRefetchError(!!query.isError, query.data));
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
