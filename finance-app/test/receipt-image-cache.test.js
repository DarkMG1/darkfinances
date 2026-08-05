'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const path = require('path');
const {
  RECEIPT_IMAGE_CACHE_POLICY,
  RECEIPT_IMAGE_CACHE_PURGE_FAILED,
  buildReceiptImageCacheKey,
  buildReceiptImageSource,
  purgeReceiptImageCaches,
} = require('../src/lib/receipt-image-cache');
const {
  bumpProfileGeneration,
  getProfileGeneration,
  resetNotificationReconciliationState,
} = require('../src/lib/notification-reconciliation');

const root = path.resolve(__dirname, '..');
const transactionSource = fs.readFileSync(
  path.join(root, 'src/app/transaction/[id].tsx'),
  'utf8',
);
const hooksSource = fs.readFileSync(
  path.join(root, 'src/api/hooks/finance.hooks.ts'),
  'utf8',
);
const purgeSource = fs.readFileSync(
  path.join(root, 'src/lib/profile-purge.ts'),
  'utf8',
);
const serverSource = fs.readFileSync(
  path.join(root, 'src/state/server.tsx'),
  'utf8',
);

test('receipt image cache key binds scope, profile generation, and receipt id without secrets', () => {
  resetNotificationReconciliationState();
  bumpProfileGeneration();
  const generation = getProfileGeneration();
  const scopeA = 'server-00000001';
  const scopeB = 'server-00000002';
  const receiptId = 'rcpt-42';
  const token = 'super-secret-bearer-token';

  const keyA = buildReceiptImageCacheKey(scopeA, generation, receiptId);
  const keyB = buildReceiptImageCacheKey(scopeB, generation, receiptId);
  const keyNextGen = buildReceiptImageCacheKey(scopeA, generation + 1, receiptId);

  assert.notEqual(keyA, keyB);
  assert.notEqual(keyA, keyNextGen);
  assert.match(keyA, new RegExp(`^receipt:${scopeA}:g${generation}:${receiptId}$`));
  assert.equal(keyA.includes(token), false);

  const source = buildReceiptImageSource({
    uri: `https://finance.example/api/v1/receipts/${receiptId}/image`,
    headers: { Authorization: `Bearer ${token}` },
    scope: scopeA,
    profileGeneration: generation,
    receiptId,
  });
  assert.equal(source.cacheKey, keyA);
  assert.equal(source.uri.includes(token), false);
  assert.equal(source.cacheKey.includes(token), false);
  assert.equal(source.headers['X-Demo-Mode'], undefined);
});

test('demo receipt image sources include the demo request header', () => {
  const token = 'optional-demo-token';
  const source = buildReceiptImageSource({
    uri: 'https://finance.example/api/v1/receipts/receipt-demo-1/image',
    headers: { 'X-Finance-Token': token },
    demo: true,
    scope: 'demo',
    profileGeneration: 0,
    receiptId: 'receipt-demo-1',
  });
  assert.equal(source.headers['X-Demo-Mode'], '1');
  assert.equal(source.headers['X-Finance-Token'], token);
});

test('profile generation bump isolates same-uri cache keys across profile switches', () => {
  resetNotificationReconciliationState();
  const scope = 'server-deadbeef';
  const receiptId = 'same-uri-receipt';
  const before = buildReceiptImageCacheKey(scope, getProfileGeneration(), receiptId);
  bumpProfileGeneration();
  const after = buildReceiptImageCacheKey(scope, getProfileGeneration(), receiptId);
  assert.notEqual(before, after);
});

test('purgeReceiptImageCaches clears expo-image memory and disk caches', async () => {
  const calls = [];
  const imageModule = {
    clearMemoryCache: async () => { calls.push('memory'); return true; },
    clearDiskCache: async () => { calls.push('disk'); return true; },
  };
  await purgeReceiptImageCaches(imageModule);
  assert.deepEqual(calls, ['memory', 'disk']);
});

test('purgeReceiptImageCaches throws when clearMemoryCache returns false', async () => {
  await assert.rejects(
    purgeReceiptImageCaches({
      clearMemoryCache: async () => false,
      clearDiskCache: async () => true,
    }),
    (error) => error.code === RECEIPT_IMAGE_CACHE_PURGE_FAILED,
  );
});

test('purgeReceiptImageCaches throws when clearDiskCache returns false', async () => {
  await assert.rejects(
    purgeReceiptImageCaches({
      clearMemoryCache: async () => true,
      clearDiskCache: async () => false,
    }),
    (error) => error.code === RECEIPT_IMAGE_CACHE_PURGE_FAILED,
  );
});

test('purgeReceiptImageCaches surfaces a stable non-secret error message', async () => {
  await assert.rejects(
    purgeReceiptImageCaches({
      clearMemoryCache: async () => false,
      clearDiskCache: async () => true,
    }),
    (error) => {
      assert.match(error.message, /Could not clear cached receipt images/);
      assert.equal(error.message.includes('Bearer'), false);
      assert.equal(error.message.includes('token'), false);
      return error.code === RECEIPT_IMAGE_CACHE_PURGE_FAILED;
    },
  );
});

test('profile purge awaits receipt image cache purge before generation bump', () => {
  const purgeIndex = purgeSource.indexOf('await purgeReceiptImageCaches()');
  const generationIndex = purgeSource.indexOf('purgeProfileGeneration(scope)');
  assert.ok(purgeIndex >= 0);
  assert.ok(generationIndex >= 0);
  assert.ok(purgeIndex < generationIndex);
  assert.doesNotMatch(purgeSource, /purgeReceiptImageCaches\(\)\.catch/);
});

test('server identity switch awaits profile purge before committing new identity', () => {
  const purgeCall = serverSource.indexOf('await purgeFinanceProfile(oldScope, oldOperationScope)');
  const commitToken = serverSource.indexOf('setToken(nextToken)');
  const commitUrl = serverSource.indexOf('setServerUrl(nextUrl)');
  assert.ok(purgeCall >= 0);
  assert.ok(commitToken > purgeCall);
  assert.ok(commitUrl > purgeCall);
});

test('transaction receipt render paths use memory-only cache without preload', () => {
  assert.match(transactionSource, /cachePolicy=\{RECEIPT_IMAGE_CACHE_POLICY\}/);
  assert.doesNotMatch(transactionSource, /cachePolicy="memory-disk"/);
  assert.doesNotMatch(transactionSource, /preloadReceiptImage/);
  assert.doesNotMatch(transactionSource, /Image\.loadAsync/);
  assert.match(hooksSource, /buildReceiptImageSource\(/);
  assert.match(hooksSource, /profileGeneration/);
  assert.match(hooksSource, /\bdemo,\s*\n\s*scope,/);
  assert.match(hooksSource, /receiptId:\s*id/);
  assert.match(purgeSource, /await purgeReceiptImageCaches\(\)/);
});
