'use strict';

const crypto = require('crypto');
const fs = require('fs');
const path = require('path');
const { SerialQueue } = require('./serial-queue');
const { RUNTIME_STATE_SCHEMAS, cloneJson } = require('./runtime-state-schemas');
const {
  assertWritable,
  readRuntimeState,
  resetWriteGuards,
  RuntimeStateError,
} = require('./runtime-state-store');

/** In-process transaction queues keyed by credentials file path. */
const transactionQueues = new Map();

/**
 * Operator-enforced deployment contract: exactly one finance-dashboard process
 * may write PASSKEY_CREDENTIALS_FILE. Credential mutations serialize in-process
 * only; systemd/process managers must not run multiple writers against one file.
 * No runtime cross-process lock or detection is provided.
 */
const PASSKEY_CREDENTIALS_DEPLOYMENT_CONTRACT = Object.freeze({
  id: 'single-process-writer',
  requirement: 'One finance-dashboard process owns passkey credential writes.',
});

function getPasskeyTransactionQueue(file) {
  let queue = transactionQueues.get(file);
  if (!queue) {
    queue = new SerialQueue(`passkey-credentials:${file}`);
    transactionQueues.set(file, queue);
  }
  return queue;
}

function resetPasskeyTransactionQueues() {
  transactionQueues.clear();
}

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

function fsyncDirectoryBestEffort(dir) {
  try {
    const dirFd = fs.openSync(dir, 'r');
    try {
      fs.fsyncSync(dirFd);
    } finally {
      fs.closeSync(dirFd);
    }
  } catch (_) {
    // Some filesystems do not support directory fsync.
  }
}

function savePasskeyCredentials(credentials, file, dependencies = {}) {
  if (!file || typeof file !== 'string') {
    throw new RuntimeStateError('passkey credentials file path is required', {
      code: 'RUNTIME_STATE_WRITE_INVALID',
    });
  }
  assertWritable(file);
  const normalized = validatePasskeyCredentialsForExternalWrite(credentials);
  const writeFileSync = dependencies.writeFileSync || fs.writeFileSync;
  const openSync = dependencies.openSync || fs.openSync;
  const fsyncSync = dependencies.fsyncSync || fs.fsyncSync;
  const closeSync = dependencies.closeSync || fs.closeSync;
  const chmodSync = dependencies.chmodSync || fs.chmodSync;
  const renameSync = dependencies.renameSync || fs.renameSync;
  const unlinkSync = dependencies.unlinkSync || fs.unlinkSync;
  const dir = path.dirname(file);
  const tmp = `${file}.${process.pid}.${crypto.randomBytes(6).toString('hex')}.tmp`;
  let fd;
  try {
    fd = openSync(tmp, 'w', 0o600);
    writeFileSync(fd, `${JSON.stringify(normalized, null, 2)}\n`, 'utf8');
    fsyncSync(fd);
    closeSync(fd);
    fd = undefined;
    chmodSync(tmp, 0o600);
    renameSync(tmp, file);
    chmodSync(file, 0o600);
    fsyncDirectoryBestEffort(dir);
  } catch (cause) {
    if (fd !== undefined) {
      try { closeSync(fd); } catch (_) {}
    }
    try { unlinkSync(tmp); } catch (_) {}
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

function mergeRegistrationCredential(credentials, entry) {
  if (credentials.some((candidate) => candidate.credentialID === entry.credentialID)) {
    const error = new Error('Credential already registered');
    error.code = 'PASSKEY_CREDENTIAL_EXISTS';
    throw error;
  }
  credentials.push(entry);
  return credentials;
}

function applyAuthenticationCounterUpdate(credentials, credentialId, newCounter) {
  const cred = credentials.find((candidate) => candidate.credentialID === credentialId);
  if (!cred) {
    const error = new Error('Credential not found');
    error.code = 'PASSKEY_CREDENTIAL_NOT_FOUND';
    throw error;
  }
  if (!Number.isInteger(newCounter) || newCounter < 0) {
    const error = new Error('Invalid authentication counter');
    error.code = 'PASSKEY_COUNTER_INVALID';
    throw error;
  }
  if (cred.counter === 0 && newCounter === 0) {
    cred.lastUsedAt = new Date().toISOString();
    return credentials;
  }
  if (newCounter <= cred.counter) {
    const error = new Error('Authentication counter replay detected');
    error.code = 'PASSKEY_COUNTER_REPLAY';
    throw error;
  }
  cred.counter = newCounter;
  cred.lastUsedAt = new Date().toISOString();
  return credentials;
}

function isPasskeyRuntimeStoreError(error) {
  if (!error) return false;
  if (error instanceof RuntimeStateError) return true;
  return String(error.code || '').startsWith('RUNTIME_STATE_');
}

/**
 * Runs load → async verify/merge → atomic save under one in-process exclusive
 * lock. Distinct credential registrations serialize but both are retained.
 * Authentication counter updates reject replays and never regress (except 0→0).
 */
async function withPasskeyCredentialsTransaction(file, fn) {
  if (!file || typeof file !== 'string') {
    throw new RuntimeStateError('passkey credentials file path is required', {
      code: 'RUNTIME_STATE_WRITE_INVALID',
    });
  }
  if (typeof fn !== 'function') throw new TypeError('passkey transaction callback must be a function');
  return getPasskeyTransactionQueue(file).run(async () => {
    const credentials = cloneJson(loadPasskeyCredentials(file));
    const outcome = await fn(credentials);
    if (outcome && typeof outcome === 'object' && !Array.isArray(outcome) && outcome.save === false) {
      return outcome.result;
    }
    const nextCredentials = (outcome && typeof outcome === 'object' && !Array.isArray(outcome) && outcome.credentials)
      ? outcome.credentials
      : (Array.isArray(outcome) ? outcome : credentials);
    savePasskeyCredentials(nextCredentials, file);
    return (outcome && typeof outcome === 'object' && !Array.isArray(outcome) && Object.hasOwn(outcome, 'result'))
      ? outcome.result
      : nextCredentials;
  });
}

module.exports = {
  PASSKEY_CREDENTIALS_DEPLOYMENT_CONTRACT,
  applyAuthenticationCounterUpdate,
  isPasskeyRuntimeStoreError,
  loadPasskeyCredentials,
  mergeRegistrationCredential,
  normalizePasskeyCredentialsFromText,
  resetPasskeyTransactionQueues,
  resetWriteGuards,
  savePasskeyCredentials,
  validatePasskeyCredentialsForExternalWrite,
  withPasskeyCredentialsTransaction,
};
