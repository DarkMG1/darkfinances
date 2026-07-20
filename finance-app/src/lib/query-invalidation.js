/**
 * Marks matching queries stale and starts active refetches without making a
 * successful mutation wait for every observer to settle.
 */
function scheduleQueryInvalidation(queryClient, keys) {
  const filters = keys == null
    ? [undefined]
    : keys.map((key) => ({ queryKey: [key] }));

  for (const filter of filters) {
    const pending = filter == null
      ? queryClient.invalidateQueries()
      : queryClient.invalidateQueries(filter);
    if (pending && typeof pending.catch === 'function') {
      pending.catch(() => undefined);
    }
  }
}

module.exports = { scheduleQueryInvalidation };
