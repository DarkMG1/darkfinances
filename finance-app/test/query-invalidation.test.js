const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');

const { scheduleQueryInvalidation } = require('../src/lib/query-invalidation');

test('query invalidation marks keys stale before scheduling active refetches', async () => {
  const invalidations = [];
  const refetches = [];
  const neverSettles = new Promise(() => {});
  const queryClient = {
    invalidateQueries(filters) {
      invalidations.push(filters);
      return neverSettles;
    },
    refetchQueries(filters) {
      refetches.push(filters);
      return neverSettles;
    },
  };

  const result = scheduleQueryInvalidation(queryClient, ['today', 'transactions']);

  assert.equal(result, undefined);
  assert.deepEqual(invalidations, [
    { queryKey: ['today'], refetchType: 'none' },
    { queryKey: ['transactions'], refetchType: 'none' },
  ]);
  assert.deepEqual(refetches, []);

  await new Promise((resolve) => setTimeout(resolve, 0));
  assert.deepEqual(refetches, [
    { queryKey: ['today'], type: 'active' },
    { queryKey: ['transactions'], type: 'active' },
  ]);
});

test('query invalidation supports full-cache refresh and absorbs scheduler rejection', async () => {
  const invalidations = [];
  const refetches = [];
  const queryClient = {
    invalidateQueries(filters) {
      invalidations.push(filters);
      return Promise.reject(new Error('stale marking failed'));
    },
    refetchQueries(filters) {
      refetches.push(filters);
      return Promise.reject(new Error('background refetch failed'));
    },
  };

  assert.equal(scheduleQueryInvalidation(queryClient), undefined);
  assert.deepEqual(invalidations, [{ refetchType: 'none' }]);
  await new Promise((resolve) => setTimeout(resolve, 0));
  assert.deepEqual(refetches, [{ type: 'active' }]);
});

test('finance mutation success handlers do not await cache refetch completion', () => {
  const source = fs.readFileSync(
    path.join(__dirname, '../src/api/hooks/finance.hooks.ts'),
    'utf8',
  );

  assert.match(source, /scheduleQueryInvalidation/);
  assert.doesNotMatch(source, /qc\.invalidateQueries/);
  assert.doesNotMatch(source, /onSuccess:\s*async/);
  assert.match(
    source,
    /useCreateTransaction[\s\S]*onSuccess:\s*\(\)\s*=>\s*\{\s*invalidateTransactionDerivedData\(qc\)/,
  );
});
