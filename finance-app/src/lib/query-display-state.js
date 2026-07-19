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

function transactionsWindowKey({ start, accountId, collapse }) {
  return `${start ?? ''}|${accountId ?? ''}|${collapse ? 'c' : 'x'}`;
}

function isQueryWindowCurrent(expectedKey, observedKey) {
  return expectedKey === observedKey;
}

module.exports = {
  hasQueryData,
  shouldShowInitialLoad,
  shouldShowFatalError,
  shouldShowRefetchError,
  isSearchQuerySettled,
  transactionsWindowKey,
  isQueryWindowCurrent,
};
