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
  demo = false,
  scope,
  profileGeneration,
  receiptId,
}) {
  return {
    uri,
    headers: {
      ...headers,
      ...(demo ? { 'X-Demo-Mode': '1' } : {}),
    },
    cacheKey: buildReceiptImageCacheKey(scope, profileGeneration, receiptId),
  };
}

async function purgeReceiptImageCaches(imageModule, { allowUnsupported = false } = {}) {
  const Image = imageModule ?? require('expo-image').Image;
  const failures = [];

  if (typeof Image.clearMemoryCache === 'function') {
    try {
      const memoryOk = await Image.clearMemoryCache();
      if (memoryOk === false && !allowUnsupported) failures.push('memory');
    } catch (error) {
      if (!allowUnsupported) throw error;
    }
  }
  if (typeof Image.clearDiskCache === 'function') {
    try {
      const diskOk = await Image.clearDiskCache();
      if (diskOk === false && !allowUnsupported) failures.push('disk');
    } catch (error) {
      if (!allowUnsupported) throw error;
    }
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
