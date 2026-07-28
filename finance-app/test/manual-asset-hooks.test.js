'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const path = require('path');
const { QueryClient, QueryObserver } = require('@tanstack/react-query');
const {
  MANUAL_ASSET_DERIVED_QUERY_KEYS,
  invalidateManualAssetDerivedQueries,
} = require('../src/lib/manual-asset-query-invalidation');

const root = path.resolve(__dirname, '..');

test('invalidateManualAssetDerivedQueries marks manualAssets and today stale then refetches active queries', async () => {
  const invalidations = [];
  const refetches = [];
  const queryClient = {
    invalidateQueries(filters) {
      invalidations.push(filters);
      return Promise.resolve();
    },
    refetchQueries(filters) {
      refetches.push(filters);
      return Promise.resolve();
    },
  };

  invalidateManualAssetDerivedQueries(queryClient);
  assert.deepEqual(invalidations, [
    { queryKey: ['manualAssets'], refetchType: 'none' },
    { queryKey: ['today'], refetchType: 'none' },
  ]);
  assert.deepEqual(refetches, []);
  await new Promise((resolve) => setTimeout(resolve, 0));
  assert.deepEqual(refetches, [
    { queryKey: ['manualAssets'], type: 'active' },
    { queryKey: ['today'], type: 'active' },
  ]);
  assert.deepEqual([...MANUAL_ASSET_DERIVED_QUERY_KEYS], ['manualAssets', 'today']);
});

test('invalidateManualAssetDerivedQueries triggers refetch on cached Today and manualAssets observers', async () => {
  const queryClient = new QueryClient({ defaultOptions: { queries: { retry: false, staleTime: Infinity } } });
  let manualCalls = 0;
  let todayCalls = 0;
  queryClient.setQueryData(['manualAssets'], { items: [], complete: true });
  queryClient.setQueryData(['today'], { revision: 'r1' });

  const manualObserver = new QueryObserver(queryClient, {
    queryKey: ['manualAssets'],
    queryFn: async () => {
      manualCalls += 1;
      return { items: manualCalls === 1 ? [] : [{ id: 'm1', name: 'Boat', value: 250, kind: 'asset' }], complete: true };
    },
    retry: false,
    staleTime: Infinity,
  });
  const todayObserver = new QueryObserver(queryClient, {
    queryKey: ['today'],
    queryFn: async () => {
      todayCalls += 1;
      return { revision: todayCalls === 1 ? 'r1' : 'r2' };
    },
    retry: false,
    staleTime: Infinity,
  });

  const waitFor = (observer, predicate) => new Promise((resolve, reject) => {
    const timer = setTimeout(() => reject(new Error('observer did not settle')), 1000);
    const check = (result) => {
      if (predicate(result)) {
        clearTimeout(timer);
        unsubscribe();
        resolve(result);
      }
    };
    const unsubscribe = observer.subscribe(check);
    check(observer.getCurrentResult());
  });

  await Promise.all([
    waitFor(manualObserver, (result) => result.isSuccess && !result.isFetching),
    waitFor(todayObserver, (result) => result.isSuccess && !result.isFetching),
  ]);

  invalidateManualAssetDerivedQueries(queryClient);
  assert.equal(queryClient.getQueryState(['manualAssets']).isInvalidated, true);
  assert.equal(queryClient.getQueryState(['today']).isInvalidated, true);

  const [manualResult, todayResult] = await Promise.all([
    waitFor(manualObserver, (result) => result.isSuccess && !result.isFetching && manualCalls >= 2),
    waitFor(todayObserver, (result) => result.isSuccess && !result.isFetching && todayCalls >= 2),
  ]);

  assert.equal(manualResult.data.items.length, 1);
  assert.equal(todayResult.data.revision, 'r2');
  manualObserver.destroy();
  todayObserver.destroy();
  queryClient.clear();
});

test('mobile net worth surfaces visible and accessibility synced accounts only labels', () => {
  const home = fs.readFileSync(path.join(root, 'src/app/(tabs)/index.tsx'), 'utf8');
  const networth = fs.readFileSync(path.join(root, 'src/app/networth.tsx'), 'utf8');
  const widget = fs.readFileSync(path.join(root, 'src/components/widget-sync.tsx'), 'utf8');
  for (const source of [home, networth]) {
    assert.match(source, /synced accounts only/i);
    assert.match(source, /Net worth trend chart, synced accounts only/);
    assert.match(source, /this month · synced accounts only/);
  }
  assert.match(widget, /synced accts/);
});

test('home net worth delta prefers Today accounts with accounts-query fallback', () => {
  const home = fs.readFileSync(path.join(root, 'src/app/(tabs)/index.tsx'), 'utf8');
  assert.match(home, /resolveNetWorthAccountSnapshot\(\s*today\.data\?\.accounts/);
  assert.match(home, /accounts\.data/);
});

test('home spending delta requires comparisonCompleteness while totals use primary completeness', () => {
  const home = fs.readFileSync(path.join(root, 'src/app/(tabs)/index.tsx'), 'utf8');
  assert.match(home, /comparisonComplete = today\.data\?\.spending\?\.comparisonCompleteness\?\.complete === true/);
  assert.match(home, /spendingComplete && comparisonComplete && cur && prev/);
});
