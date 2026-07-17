'use strict';

const crypto = require('crypto');
const fs = require('fs');
const path = require('path');
const { RUNTIME_STATE_SCHEMAS, cloneJson } = require('./runtime-state-schemas');
const {
  assertWritable,
  readRuntimeState,
  resetWriteGuards,
  RuntimeStateError,
} = require('./runtime-state-store');

function loadPasskeyCredentials(file) {
  if (!file || typeof file !== 'string') {
    throw new RuntimeStateError('passkey credentials file path is required', {
      code: 'RUNTIME_STATE_READ_FAILED',
    });
  }
  return readRuntimeState('passkeyCredentials', { file, semantic: false }).value;
}

function validatePasskeyCredentialsForExternalWrite(credentials) {
  try {
    return RUNTIME_STATE_SCHEMAS.passkeyCredentials.assertWritable(cloneJson(credentials));
  } catch (cause) {
    throw cause instanceof RuntimeStateError ? cause : new RuntimeStateError(cause.message, {
      code: cause.code || 'RUNTIME_STATE_WRITE_INVALID',
      cause,
    });
  }
}

function savePasskeyCredentials(credentials, file) {
  if (!file || typeof file !== 'string') {
    throw new RuntimeStateError('passkey credentials file path is required', {
      code: 'RUNTIME_STATE_WRITE_INVALID',
    });
  }
  assertWritable(file);
  const normalized = validatePasskeyCredentialsForExternalWrite(credentials);
  const tmp = `${file}.${process.pid}.${crypto.randomBytes(6).toString('hex')}.tmp`;
  try {
    fs.writeFileSync(tmp, `${JSON.stringify(normalized, null, 2)}\n`, { mode: 0o600 });
    fs.chmodSync(tmp, 0o600);
    fs.renameSync(tmp, file);
  } catch (cause) {
    throw new RuntimeStateError(`Could not write ${path.basename(file)}`, {
      code: 'RUNTIME_STATE_WRITE_INVALID',
      file,
      cause,
    });
  }
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
  const schema = RUNTIME_STATE_SCHEMAS.passkeyCredentials;
  let migrated;
  try {
    migrated = schema.migrate(raw);
  } catch (cause) {
    throw new RuntimeStateError(cause.message, {
      code: cause.code || 'RUNTIME_STATE_MIGRATION_FAILED',
      file,
      cause,
    });
  }
  if (!schema.validateCurrent(migrated.value)) {
    throw new RuntimeStateError('Passkey credential store failed schema validation', {
      code: 'RUNTIME_STATE_INVALID_SHAPE',
      file,
    });
  }
  return migrated.value;
}

module.exports = {
  loadPasskeyCredentials,
  normalizePasskeyCredentialsFromText,
  resetWriteGuards,
  savePasskeyCredentials,
  validatePasskeyCredentialsForExternalWrite,
};
