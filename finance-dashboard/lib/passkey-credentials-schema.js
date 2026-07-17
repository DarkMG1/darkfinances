'use strict';

const CREDENTIAL_ENTRY_KEYS = new Set([
  'credentialID',
  'credentialPublicKey',
  'counter',
  'transports',
  'createdAt',
  'lastUsedAt',
]);

function isPlainObject(value) {
  return !!value && typeof value === 'object' && !Array.isArray(value);
}

function isIsoTimestamp(value) {
  return typeof value === 'string' && value.length > 0 && !Number.isNaN(Date.parse(value));
}

function validatePasskeyCredentialEntry(entry) {
  if (!isPlainObject(entry)) return false;
  if (!Object.keys(entry).every((key) => CREDENTIAL_ENTRY_KEYS.has(key))) return false;
  if (typeof entry.credentialID !== 'string' || !entry.credentialID.trim()) return false;
  if (typeof entry.credentialPublicKey !== 'string' || !entry.credentialPublicKey) return false;
  if (!Number.isInteger(entry.counter) || entry.counter < 0) return false;
  if (entry.transports != null) {
    if (!Array.isArray(entry.transports)) return false;
    if (!entry.transports.every((transport) => typeof transport === 'string' && transport.length > 0)) {
      return false;
    }
  }
  if (entry.createdAt != null && !isIsoTimestamp(entry.createdAt)) return false;
  if (entry.lastUsedAt != null && entry.lastUsedAt !== null && !isIsoTimestamp(entry.lastUsedAt)) {
    return false;
  }
  return true;
}

function validatePasskeyCredentials(value) {
  return Array.isArray(value) && value.every((entry) => validatePasskeyCredentialEntry(entry));
}

function shapeError(message, code = 'RUNTIME_STATE_INVALID_SHAPE') {
  const error = new Error(message);
  error.code = code;
  return error;
}

function assertPasskeyCredentialEntry(entry, label = 'passkey credential') {
  if (!validatePasskeyCredentialEntry(entry)) {
    throw shapeError(`${label} is invalid`);
  }
}

function assertPasskeyCredentials(value) {
  if (!Array.isArray(value)) {
    throw shapeError('passkey credentials must be an array');
  }
  value.forEach((entry, index) => assertPasskeyCredentialEntry(entry, `passkey credential ${index}`));
  return value;
}

module.exports = {
  CREDENTIAL_ENTRY_KEYS,
  assertPasskeyCredentialEntry,
  assertPasskeyCredentials,
  validatePasskeyCredentialEntry,
  validatePasskeyCredentials,
};
