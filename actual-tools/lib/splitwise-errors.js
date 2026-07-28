'use strict';

const DEFAULT_ERROR_BODY_BYTES = 512;
const MIN_ERROR_BODY_BYTES = 64;
const MAX_ERROR_BODY_BYTES_LIMIT = 4096;
const MAX_HEADER_VALUE_LENGTH = 128;

const DEBUG_BODY = Symbol('SplitwiseRequestError.debugBody');

const ALLOWED_ERROR_CODES = new Set([
  'forbidden',
  'invalid_grant',
  'invalid_request',
  'not_found',
  'rate_limit_exceeded',
  'server_error',
  'unauthorized',
]);

function resolveMaxErrorBodyBytes(raw = process.env.SPLITWISE_ERROR_BODY_BYTES) {
  if (raw == null || raw === '') return DEFAULT_ERROR_BODY_BYTES;
  const parsed = Number(raw);
  if (!Number.isFinite(parsed)) return DEFAULT_ERROR_BODY_BYTES;
  return Math.min(MAX_ERROR_BODY_BYTES_LIMIT, Math.max(MIN_ERROR_BODY_BYTES, Math.floor(parsed)));
}

const MAX_ERROR_BODY_BYTES = resolveMaxErrorBodyBytes();

class SplitwiseRequestError extends Error {
  constructor(message, meta = {}) {
    super(message);
    this.name = 'SplitwiseRequestError';
    this.endpoint = meta.endpoint || null;
    this.method = meta.method || 'GET';
    this.status = meta.status ?? null;
    this.code = meta.code || null;
    this.retryAfter = meta.retryAfter ?? null;
    this.requestId = meta.requestId ?? null;
    if (meta.debugBody && process.env.SPLITWISE_DEBUG_RESPONSE_BODY === '1') {
      Object.defineProperty(this, DEBUG_BODY, {
        value: meta.debugBody,
        enumerable: false,
        configurable: true,
      });
    }
  }

  get debugBody() {
    if (process.env.SPLITWISE_DEBUG_RESPONSE_BODY === '1') {
      return this[DEBUG_BODY];
    }
    return undefined;
  }
}

function sanitizeHeaderValue(value) {
  if (value == null || value === '') return null;
  const stripped = String(value).replace(/[\x00-\x1f\x7f]/g, '');
  if (!stripped) return null;
  return stripped.length > MAX_HEADER_VALUE_LENGTH ? stripped.slice(0, MAX_HEADER_VALUE_LENGTH) : stripped;
}

function statusToCode(status) {
  if (status === 401) return 'unauthorized';
  if (status === 403) return 'forbidden';
  if (status === 404) return 'not_found';
  if (status === 429) return 'rate_limit_exceeded';
  if (status >= 500) return 'server_error';
  return null;
}

function extractAllowlistedCode(bodyText) {
  if (!bodyText) return null;
  try {
    const parsed = JSON.parse(bodyText);
    const errors = parsed?.errors;
    if (errors && typeof errors === 'object' && !Array.isArray(errors)) {
      for (const value of Object.values(errors)) {
        const candidate = Array.isArray(value) ? value[0] : value;
        if (typeof candidate === 'string') {
          const normalized = candidate.toLowerCase();
          if (ALLOWED_ERROR_CODES.has(normalized)) return normalized;
        }
      }
    }
    const topLevel = parsed?.error;
    if (typeof topLevel === 'string') {
      const normalized = topLevel.toLowerCase();
      if (ALLOWED_ERROR_CODES.has(normalized)) return normalized;
    }
  } catch (_) {
    return null;
  }
  return null;
}

function decodeChunks(chunks) {
  const decoder = new TextDecoder('utf-8', { fatal: false });
  let text = '';
  for (const chunk of chunks) {
    text += decoder.decode(chunk, { stream: true });
  }
  return text + decoder.decode();
}

async function cancelResponseBody(response) {
  if (!response?.body) return;
  try {
    if (typeof response.body.cancel === 'function') {
      await response.body.cancel();
      return;
    }
    const reader = response.body.getReader?.();
    if (reader) await reader.cancel();
  } catch (_) {}
}

async function readBoundedResponseTextFromStream(response, maxBytes) {
  const reader = response.body.getReader();
  const chunks = [];
  let totalBytes = 0;
  const stats = { readCount: 0, cancelled: false };
  try {
    while (totalBytes < maxBytes) {
      const { done, value } = await reader.read();
      stats.readCount += 1;
      if (done) break;
      if (!value?.length) continue;
      const remaining = maxBytes - totalBytes;
      if (value.length <= remaining) {
        chunks.push(value);
        totalBytes += value.length;
        continue;
      }
      chunks.push(value.subarray(0, remaining));
      totalBytes = maxBytes;
      break;
    }
  } finally {
    stats.cancelled = true;
    try {
      await reader.cancel();
    } catch (_) {}
    try {
      await response.body.cancel?.();
    } catch (_) {}
  }
  return { text: decodeChunks(chunks), stats };
}

async function readBoundedResponseTextFallback(response, maxBytes) {
  const text = typeof response.text === 'function'
    ? await response.text()
    : String(response._bodyText ?? '');
  if (text.length > maxBytes) return { text: text.slice(0, maxBytes), stats: { readCount: 1, cancelled: false } };
  return { text, stats: { readCount: 1, cancelled: false } };
}

async function readBoundedResponseText(response, maxBytes = resolveMaxErrorBodyBytes()) {
  const bound = Math.min(MAX_ERROR_BODY_BYTES_LIMIT, Math.max(MIN_ERROR_BODY_BYTES, maxBytes));
  if (response?.body && typeof response.body.getReader === 'function') {
    return readBoundedResponseTextFromStream(response, bound);
  }
  return readBoundedResponseTextFallback(response, bound);
}

function formatSplitwiseErrorMessage({ endpoint, method, status, code, retryAfter, requestId }) {
  const parts = [`Splitwise ${endpoint} request failed`];
  const details = [];
  if (method && method !== 'GET') details.push(`method=${method}`);
  if (status != null) details.push(`status=${status}`);
  if (code) details.push(`code=${code}`);
  if (retryAfter != null) details.push(`retry-after=${retryAfter}`);
  if (requestId) details.push(`request-id=${requestId}`);
  if (details.length) parts.push(`(${details.join(', ')})`);
  return parts.join(' ');
}

async function splitwiseResponseError(response, { endpoint, method = 'GET' } = {}) {
  const { text: bodyText } = await readBoundedResponseText(response);
  const retryAfter = sanitizeHeaderValue(response.headers.get('retry-after'));
  const requestId = sanitizeHeaderValue(
    response.headers.get('x-request-id') || response.headers.get('request-id'),
  );
  const code = extractAllowlistedCode(bodyText) || statusToCode(response.status);
  const message = formatSplitwiseErrorMessage({
    endpoint,
    method,
    status: response.status,
    code,
    retryAfter,
    requestId,
  });
  const debugBody = process.env.SPLITWISE_DEBUG_RESPONSE_BODY === '1' ? bodyText : undefined;
  return new SplitwiseRequestError(message, {
    endpoint,
    method,
    status: response.status,
    code,
    retryAfter,
    requestId,
    debugBody,
  });
}

async function assertSplitwiseOk(response, meta) {
  if (response.ok) return response;
  throw await splitwiseResponseError(response, meta);
}

module.exports = {
  ALLOWED_ERROR_CODES,
  DEBUG_BODY,
  DEFAULT_ERROR_BODY_BYTES,
  MAX_ERROR_BODY_BYTES,
  MAX_ERROR_BODY_BYTES_LIMIT,
  MIN_ERROR_BODY_BYTES,
  SplitwiseRequestError,
  assertSplitwiseOk,
  cancelResponseBody,
  extractAllowlistedCode,
  formatSplitwiseErrorMessage,
  readBoundedResponseText,
  resolveMaxErrorBodyBytes,
  sanitizeHeaderValue,
  splitwiseResponseError,
  statusToCode,
};
