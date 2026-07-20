const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');

const { scheduleQueryInvalidation } = require('../src/lib/query-invalidation');

test('query invalidation schedules each key without awaiting active refetches', () => {
  const calls = [];
  const neverSettles = new Promise(() => {});
  const queryClient = {
    invalidateQueries(filters) {
      calls.push(filters);
      return neverSettles;
    },
  };

  const result = scheduleQueryInvalidation(queryClient, ['today', 'transactions']);

  assert.equal(result, undefined);
  assert.deepEqual(calls, [
    { queryKey: ['today'] },
    { queryKey: ['transactions'] },
  ]);
});

test('query invalidation supports full-cache refresh and absorbs scheduler rejection', async () => {
  let calls = 0;
  const queryClient = {
    invalidateQueries(filters) {
      calls += 1;
      assert.equal(filters, undefined);
      return Promise.reject(new Error('background refetch failed'));
    },
  };

  assert.equal(scheduleQueryInvalidation(queryClient), undefined);
  await new Promise((resolve) => setImmediate(resolve));
  assert.equal(calls, 1);
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
