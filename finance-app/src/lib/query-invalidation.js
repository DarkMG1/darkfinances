/**
 * Marks matching queries stale and starts active refetches without making a
 * successful mutation wait for every observer to settle.
 */
function scheduleQueryInvalidation(queryClient, keys) {
  if (typeof __DEV__ !== 'undefined' && __DEV__ && keys?.includes?.('transactions')) {
    console.log('[mutation-debug] invalidation mark start');
  }
  const filters = keys == null
    ? [{}]
    : keys.map((key) => ({ queryKey: [key] }));

  for (const filter of filters) {
    const pending = queryClient.invalidateQueries({ ...filter, refetchType: 'none' });
    if (pending && typeof pending.catch === 'function') {
      pending.catch(() => undefined);
    }
  }
  if (typeof __DEV__ !== 'undefined' && __DEV__ && keys?.includes?.('transactions')) {
    console.log('[mutation-debug] invalidation mark end');
  }

  setTimeout(() => {
    if (typeof __DEV__ !== 'undefined' && __DEV__ && keys?.includes?.('transactions')) {
      console.log('[mutation-debug] invalidation refetch timer start');
    }
    for (const filter of filters) {
      const pending = queryClient.refetchQueries({ ...filter, type: 'active' });
      if (pending && typeof pending.catch === 'function') {
        pending.catch(() => undefined);
      }
    }
    if (typeof __DEV__ !== 'undefined' && __DEV__ && keys?.includes?.('transactions')) {
      console.log('[mutation-debug] invalidation refetch timer end');
    }
  }, 0);
}

module.exports = { scheduleQueryInvalidation };
