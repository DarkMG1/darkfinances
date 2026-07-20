/**
 * Marks matching queries stale and starts active refetches without making a
 * successful mutation wait for every observer to settle.
 */
function scheduleQueryInvalidation(queryClient, keys) {
  const filters = keys == null
    ? [{}]
    : keys.map((key) => ({ queryKey: [key] }));

  for (const filter of filters) {
    const pending = queryClient.invalidateQueries({ ...filter, refetchType: 'none' });
    if (pending && typeof pending.catch === 'function') {
      pending.catch(() => undefined);
    }
  }

  setTimeout(() => {
    for (const filter of filters) {
      const pending = queryClient.refetchQueries({ ...filter, type: 'active' });
      if (pending && typeof pending.catch === 'function') {
        pending.catch(() => undefined);
      }
    }
  }, 0);
}

module.exports = { scheduleQueryInvalidation };
