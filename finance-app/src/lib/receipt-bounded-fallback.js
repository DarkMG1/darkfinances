'use strict';

const DEFAULT_MAX_SOURCE_BYTES = 8 * 1024 * 1024;
const DEFAULT_MAX_ENCODED_BYTES = 12 * 1024 * 1024;

/** Local schemes expo-file-system/legacy can stat/read for on-device picker assets. */
const LOCAL_RECEIPT_URI_SCHEMES = ['file:'];

function estimateDecodedBase64Bytes(base64) {
  return Math.floor((base64.length * 3) / 4);
}

function assertWithinByteCap(size, cap, label) {
  if (size > cap) {
    const error = new Error(`${label} exceeds the ${cap}-byte limit.`);
    error.code = 'RECEIPT_IMAGE_TOO_LARGE';
    throw error;
  }
}

function assertLocalReceiptUri(uri) {
  if (typeof uri !== 'string' || !uri.length) {
    const error = new Error('Receipt image URI is invalid.');
    error.code = 'RECEIPT_IMAGE_URI_INVALID';
    throw error;
  }
  let parsed;
  try {
    parsed = new URL(uri);
  } catch {
    const error = new Error('Receipt image URI is invalid.');
    error.code = 'RECEIPT_IMAGE_URI_INVALID';
    throw error;
  }
  if (!LOCAL_RECEIPT_URI_SCHEMES.includes(parsed.protocol)) {
    const error = new Error('Receipt fallback requires a local file URI.');
    error.code = 'RECEIPT_IMAGE_URI_NOT_LOCAL';
    throw error;
  }
}

async function statRegularFileSize(uri, fileSystem) {
  assertLocalReceiptUri(uri);
  const info = await fileSystem.getInfoAsync(uri);
  if (!info || !info.exists) {
    const error = new Error('Receipt image file is missing.');
    error.code = 'RECEIPT_IMAGE_MISSING';
    throw error;
  }
  if (info.isDirectory) {
    const error = new Error('Receipt image path is not a regular file.');
    error.code = 'RECEIPT_IMAGE_NOT_REGULAR';
    throw error;
  }
  if (typeof info.size !== 'number' || !Number.isFinite(info.size) || info.size < 0) {
    const error = new Error('Receipt image size is unavailable.');
    error.code = 'RECEIPT_IMAGE_SIZE_UNKNOWN';
    throw error;
  }
  return info.size;
}

async function readBoundedFileBase64(uri, fileSystem, options = {}) {
  const maxSourceBytes = options.maxSourceBytes ?? DEFAULT_MAX_SOURCE_BYTES;
  const maxEncodedBytes = options.maxEncodedBytes ?? DEFAULT_MAX_ENCODED_BYTES;
  const size = await statRegularFileSize(uri, fileSystem);
  assertWithinByteCap(size, maxSourceBytes, 'Receipt image');
  const base64 = await fileSystem.readAsStringAsync(uri, {
    encoding: fileSystem.EncodingType.Base64,
  });
  assertWithinByteCap(estimateDecodedBase64Bytes(base64), maxEncodedBytes, 'Receipt payload');
  return base64;
}

function assertBoundedBase64Payload(base64, maxEncodedBytes = DEFAULT_MAX_ENCODED_BYTES) {
  assertWithinByteCap(estimateDecodedBase64Bytes(base64), maxEncodedBytes, 'Receipt payload');
}

module.exports = {
  DEFAULT_MAX_ENCODED_BYTES,
  DEFAULT_MAX_SOURCE_BYTES,
  LOCAL_RECEIPT_URI_SCHEMES,
  assertBoundedBase64Payload,
  assertLocalReceiptUri,
  estimateDecodedBase64Bytes,
  readBoundedFileBase64,
  statRegularFileSize,
};
