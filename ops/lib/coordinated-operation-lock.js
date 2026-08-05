'use strict';

const fs = require('fs');
const path = require('path');
const { fsyncPath } = require('./restore-durable-io');
const { assertNotSymlink } = require('./coordinated-operation-layout');
const { isProcessAlive } = require('./restore-instance-lock');

const LOCK_KIND = 'darkfinances-coordinated-lock';
const LOCK_SCHEMA_VERSION = 1;

function createCoordinatedLockPayload({ operation, canonicalRoot }) {
  return {
    kind: LOCK_KIND,
    schemaVersion: LOCK_SCHEMA_VERSION,
    pid: process.pid,
    operation,
    canonicalRoot,
    createdAt: new Date().toISOString(),
  };
}

function parseCoordinatedLockPayload(text, label = 'coordinated lock') {
  let parsed;
  try {
    parsed = JSON.parse(text);
  } catch (error) {
    throw new Error(`${label} is not valid JSON: ${error.message}`);
  }
  if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) {
    throw new Error(`${label} must be a JSON object`);
  }
  if (parsed.kind !== LOCK_KIND) throw new Error(`${label} kind mismatch`);
  if (parsed.schemaVersion !== LOCK_SCHEMA_VERSION) {
    throw new Error(`${label} schemaVersion ${parsed.schemaVersion} is unsupported`);
  }
  if (typeof parsed.pid !== 'number' || !Number.isInteger(parsed.pid) || parsed.pid <= 0) {
    throw new Error(`${label} requires a positive integer pid`);
  }
  if (typeof parsed.operation !== 'string' || !parsed.operation) {
    throw new Error(`${label} requires operation`);
  }
  if (typeof parsed.canonicalRoot !== 'string' || !parsed.canonicalRoot) {
    throw new Error(`${label} requires canonicalRoot`);
  }
  if (typeof parsed.createdAt !== 'string' || !parsed.createdAt) {
    throw new Error(`${label} requires createdAt`);
  }
  return parsed;
}

function canonicalLockRoot(rootPath) {
  const resolved = path.resolve(rootPath);
  if (fs.existsSync(resolved)) {
    return fs.realpathSync(resolved);
  }
  return resolved;
}

function validateCoordinatedLockOwnership(lockPath, expectedRoot) {
  const stat = fs.lstatSync(lockPath);
  assertNotSymlink(stat, 'coordinated lock');
  if (!stat.isFile()) throw new Error('coordinated lock must be a regular file');
  if (process.platform !== 'win32' && typeof process.getuid === 'function' && stat.uid !== process.getuid()) {
    throw new Error('coordinated lock ownership mismatch');
  }
  if ((stat.mode & 0o777) !== 0o600) {
    throw new Error('coordinated lock mode must be 0600');
  }
  const payload = parseCoordinatedLockPayload(fs.readFileSync(lockPath, 'utf8'));
  if (canonicalLockRoot(payload.canonicalRoot) !== canonicalLockRoot(expectedRoot)) {
    throw new Error('coordinated lock root binding mismatch');
  }
  return payload;
}

function createCoordinatedLockFile(lockPath, payload) {
  const fd = fs.openSync(lockPath, 'wx', 0o600);
  try {
    fs.writeFileSync(fd, `${JSON.stringify(payload, null, 2)}\n`, { encoding: 'utf8' });
    fs.fsyncSync(fd);
  } finally {
    fs.closeSync(fd);
  }
  fsyncPath(path.dirname(lockPath), true);
  return payload;
}

function acquireCoordinatedLock({
  layout,
  operation,
  dryRun = false,
  env = process.env,
}) {
  if (dryRun) {
    return {
      lockPath: null,
      temporary: true,
      release() {},
    };
  }

  if (env.COORDINATED_TEST_SKIP_LOCK === '1') {
    return { lockPath: null, temporary: true, release() {} };
  }

  const lockPath = layout.lockPath;
  if (fs.existsSync(lockPath)) {
    const stat = fs.lstatSync(lockPath);
    if (stat.isSymbolicLink()) throw new Error('coordinated lock must not be a symbolic link');
    let payload;
    try {
      payload = validateCoordinatedLockOwnership(lockPath, layout.canonicalRoot);
    } catch {
      throw new Error('coordinated lock unavailable');
    }
    if (isProcessAlive(payload.pid)) {
      throw new Error(`coordinated ${payload.operation} already in progress`);
    }
    fs.unlinkSync(lockPath);
    fsyncPath(path.dirname(lockPath), true);
  }

  try {
    createCoordinatedLockFile(lockPath, createCoordinatedLockPayload({
      operation,
      canonicalRoot: layout.canonicalRoot,
    }));
  } catch (error) {
    if (error.code === 'EEXIST') {
      throw new Error(`coordinated ${operation} already in progress`);
    }
    throw error;
  }

  return {
    lockPath,
    temporary: false,
    release() {
      if (!lockPath || !fs.existsSync(lockPath)) return;
      const stat = fs.lstatSync(lockPath);
      if (stat.isSymbolicLink() || !stat.isFile()) return;
      try {
        const payload = parseCoordinatedLockPayload(fs.readFileSync(lockPath, 'utf8'));
        if (payload.pid !== process.pid) return;
      } catch {
        return;
      }
      fs.unlinkSync(lockPath);
      fsyncPath(path.dirname(lockPath), true);
    },
  };
}

function assertCoordinatedLockHeld({
  layout,
  operation,
  env = process.env,
}) {
  if (env.COORDINATED_TEST_SKIP_LOCK === '1') {
    return { skipped: true };
  }
  if (!layout?.lockPath || !fs.existsSync(layout.lockPath)) {
    throw new Error('live restore requires a held coordinated operation gate');
  }
  const payload = validateCoordinatedLockOwnership(layout.lockPath, layout.canonicalRoot);
  if (payload.operation !== operation) {
    throw new Error(`coordinated operation gate is held for ${payload.operation}, not ${operation}`);
  }
  if (payload.pid !== process.pid || !isProcessAlive(payload.pid)) {
    throw new Error('live restore requires the current coordinator to hold the operation gate');
  }
  return payload;
}

module.exports = {
  LOCK_KIND,
  LOCK_SCHEMA_VERSION,
  acquireCoordinatedLock,
  assertCoordinatedLockHeld,
  createCoordinatedLockPayload,
  parseCoordinatedLockPayload,
  validateCoordinatedLockOwnership,
};
