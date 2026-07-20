/** Shared receipt upload limits — encoded, decoded, and JSON envelope. */
const RECEIPT_MAX_DECODED_BYTES = 25 * 1024 * 1024;
const RECEIPT_MAX_BASE64_CHARS = Math.ceil(RECEIPT_MAX_DECODED_BYTES / 3) * 4;
const RECEIPT_MAX_JSON_BYTES = RECEIPT_MAX_BASE64_CHARS + 8192;

const DEFAULT_MAX_JSON_BYTES = 1024 * 1024;

const DATA_URI_PREFIX = /^data:([^;]+);base64,/i;

function stripBase64Envelope(value) {
  return String(value || '').replace(DATA_URI_PREFIX, '').replace(/\s+/g, '');
}

function hasDataUriPrefix(value) {
  return DATA_URI_PREFIX.test(String(value || ''));
}

function isStrictBase64(value) {
  if (!value || value.length % 4 === 1) return false;
  return /^[A-Za-z0-9+/]*={0,2}$/.test(value);
}

function exactBase64DecodedBytes(clean) {
  const encoded = stripBase64Envelope(clean);
  if (!encoded) return 0;
  let padding = 0;
  if (encoded.endsWith('==')) padding = 2;
  else if (encoded.endsWith('=')) padding = 1;
  return Math.floor((encoded.length * 3) / 4) - padding;
}

function estimatedBase64DecodedBytes(value) {
  return exactBase64DecodedBytes(value);
}

function assertReceiptEncodedWithinLimits(imageBase64) {
  const { PayloadTooLargeError } = require('./bounded-json');
  const { RequestValidationError } = require('./errors');
  const encoded = stripBase64Envelope(imageBase64);
  if (!encoded) {
    throw new RequestValidationError('Invalid receipt: imageBase64 is required', [{
      path: 'body',
      message: 'imageBase64 is required',
    }]);
  }
  if (encoded.length > RECEIPT_MAX_BASE64_CHARS) {
    throw new PayloadTooLargeError('Receipt image exceeds the maximum encoded size');
  }
  if (!isStrictBase64(encoded)) {
    throw new RequestValidationError('Invalid receipt: invalid receipt image encoding', [{
      path: 'body',
      message: 'invalid receipt image encoding',
    }]);
  }
  const decoded = exactBase64DecodedBytes(encoded);
  if (decoded > RECEIPT_MAX_DECODED_BYTES) {
    throw new PayloadTooLargeError('Receipt image exceeds the maximum decoded size');
  }
}

module.exports = {
  DEFAULT_MAX_JSON_BYTES,
  RECEIPT_MAX_BASE64_CHARS,
  RECEIPT_MAX_DECODED_BYTES,
  RECEIPT_MAX_JSON_BYTES,
  assertReceiptEncodedWithinLimits,
  exactBase64DecodedBytes,
  estimatedBase64DecodedBytes,
  hasDataUriPrefix,
  isStrictBase64,
  stripBase64Envelope,
};
