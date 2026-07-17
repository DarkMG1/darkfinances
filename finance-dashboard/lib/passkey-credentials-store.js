'use strict';

const crypto = require('crypto');
const fs = require('fs');
const { RUNTIME_STATE_SCHEMAS } = require('./runtime-state-schemas');
const { RuntimeStateError } = require('./runtime-state-store');

function passkeySchema() {
  return RUNTIME_STATE_SCHEMAS.passkeyCredentials;
}

function migratePasskeyCredentialsRaw(raw) {
  try {
    return passkeySchema().migrate(raw);
  } catch (cause) {
    if (cause?.code === 'RUNTIME_STATE_FUTURE_SCHEMA') {
      throw new RuntimeStateError(cause.message, { code: cause.code, cause });
    }
    throw new RuntimeStateError(cause.message, {
      code: cause.code || 'RUNTIME_STATE_MIGRATION_FAILED',
      cause,
    });
  }
}

function assertPasskeyCredentialEntry(entry, index) {
  if (!entry || typeof entry !== 'object' || Array.isArray(entry)) {
    throw new RuntimeStateError(`passkey credential ${index} must be an object`, {
      code: 'RUNTIME_STATE_WRITE_INVALID',
    });
  }
  if (typeof entry.credentialID !== 'string' || !entry.credentialID) {
    throw new RuntimeStateError(`passkey credential ${index} requires credentialID`, {
      code: 'RUNTIME_STATE_WRITE_INVALID',
    });
  }
  if (typeof entry.credentialPublicKey !== 'string' || !entry.credentialPublicKey) {
    throw new RuntimeStateError(`passkey credential ${index} requires credentialPublicKey`, {
      code: 'RUNTIME_STATE_WRITE_INVALID',
    });
  }
  if (!Number.isInteger(entry.counter) || entry.counter < 0) {
    throw new RuntimeStateError(`passkey credential ${index} requires non-negative integer counter`, {
      code: 'RUNTIME_STATE_WRITE_INVALID',
    });
  }
}

function validatePasskeyCredentialsForExternalWrite(credentials) {
  if (!Array.isArray(credentials)) {
    throw new RuntimeStateError('passkey credentials must be an array', {
      code: 'RUNTIME_STATE_WRITE_INVALID',
    });
  }
  passkeySchema().assertWritable(credentials);
  credentials.forEach((entry, index) => assertPasskeyCredentialEntry(entry, index));
  return credentials;
}

function loadPasskeyCredentials(file) {
  if (!file || typeof file !== 'string') {
    throw new RuntimeStateError('passkey credentials file path is required', {
      code: 'RUNTIME_STATE_READ_FAILED',
    });
  }
  if (!fs.existsSync(file)) return [];

  let raw;
  try {
    raw = JSON.parse(fs.readFileSync(file, 'utf8'));
  } catch (cause) {
    throw new RuntimeStateError('Passkey credential store is corrupt', {
      code: 'RUNTIME_STATE_CORRUPT',
      file,
      cause,
    });
  }

  const migrated = migratePasskeyCredentialsRaw(raw);
  if (!Array.isArray(migrated.value)) {
    throw new RuntimeStateError('Passkey credential store must normalize to an array', {
      code: 'RUNTIME_STATE_INVALID_SHAPE',
      file,
    });
  }
  return migrated.value;
}

function savePasskeyCredentials(credentials, file) {
  if (!file || typeof file !== 'string') {
    throw new RuntimeStateError('passkey credentials file path is required', {
      code: 'RUNTIME_STATE_WRITE_INVALID',
    });
  }
  const normalized = validatePasskeyCredentialsForExternalWrite(credentials);
  const tmp = `${file}.${process.pid}.${crypto.randomBytes(6).toString('hex')}.tmp`;
  fs.writeFileSync(tmp, `${JSON.stringify(normalized, null, 2)}\n`, { mode: 0o600 });
  fs.chmodSync(tmp, 0o600);
  fs.renameSync(tmp, file);
  return normalized;
}

function normalizePasskeyCredentialsFromText(text, { file } = {}) {
  let raw;
  try {
    raw = JSON.parse(text);
  } catch (cause) {
    throw new RuntimeStateError('Passkey credential store is corrupt', {
      code: 'RUNTIME_STATE_CORRUPT',
      file,
      cause,
    });
  }
  const migrated = migratePasskeyCredentialsRaw(raw);
  if (!Array.isArray(migrated.value)) {
    throw new RuntimeStateError('Passkey credential store must normalize to an array', {
      code: 'RUNTIME_STATE_INVALID_SHAPE',
      file,
    });
  }
  return migrated.value;
}

module.exports = {
  loadPasskeyCredentials,
  migratePasskeyCredentialsRaw,
  normalizePasskeyCredentialsFromText,
  savePasskeyCredentials,
  validatePasskeyCredentialsForExternalWrite,
};
