'use strict';

/** Memory-only caching for authenticated receipt bytes; never URI-only disk keys. */
const RECEIPT_IMAGE_CACHE_POLICY = 'memory';
const RECEIPT_IMAGE_CACHE_PURGE_FAILED = 'RECEIPT_IMAGE_CACHE_PURGE_FAILED';

function buildReceiptImageCacheKey(scope, profileGeneration, receiptId) {
  return `receipt:${scope}:g${profileGeneration}:${receiptId}`;
}

function buildReceiptImageSource({
  uri,
  headers,
  scope,
  profileGeneration,
  receiptId,
}) {
  return {
    uri,
    headers,
    cacheKey: buildReceiptImageCacheKey(scope, profileGeneration, receiptId),
  };
}

async function purgeReceiptImageCaches(imageModule) {
  const Image = imageModule ?? require('expo-image').Image;
  const failures = [];

  if (typeof Image.clearMemoryCache === 'function') {
    const memoryOk = await Image.clearMemoryCache();
    if (memoryOk === false) failures.push('memory');
  }
  if (typeof Image.clearDiskCache === 'function') {
    const diskOk = await Image.clearDiskCache();
    if (diskOk === false) failures.push('disk');
  }

  if (failures.length) {
    const error = new Error('Could not clear cached receipt images. Try again before switching profiles.');
    error.code = RECEIPT_IMAGE_CACHE_PURGE_FAILED;
    throw error;
  }
}

module.exports = {
  RECEIPT_IMAGE_CACHE_POLICY,
  RECEIPT_IMAGE_CACHE_PURGE_FAILED,
  buildReceiptImageCacheKey,
  buildReceiptImageSource,
  purgeReceiptImageCaches,
};
