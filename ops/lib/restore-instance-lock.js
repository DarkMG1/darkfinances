'use strict';

const fs = require('fs');
const os = require('os');
const path = require('path');
const { assertSafeRegularFile, assertNotSymlink } = require('./restore-control-layout');
const { writeFileAtomic, fsyncPath } = require('./restore-durable-io');

const LOCK_FILENAME = 'restore.lock';
const LOCK_KIND = 'darkfinances-restore-lock';
const LOCK_SCHEMA_VERSION = 1;

function lockPathForLayout(layout) {
  return path.join(layout.controlRoot, LOCK_FILENAME);
}

function isProcessAlive(pid) {
  if (!Number.isInteger(pid) || pid <= 0) return false;
  try {
    process.kill(pid, 0);
    return true;
  } catch (error) {
    return error.code === 'EPERM';
  }
}

function parseLockPayload(text, label = 'restore lock') {
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
  if (typeof parsed.destinationRoot !== 'string' || !parsed.destinationRoot) {
    throw new Error(`${label} requires destinationRoot`);
  }
  if (typeof parsed.createdAt !== 'string' || !parsed.createdAt) {
    throw new Error(`${label} requires createdAt`);
  }
  return parsed;
}

function validateLockOwnership(lockPath, expectedDestination) {
  const stat = fs.lstatSync(lockPath);
  assertNotSymlink(stat, 'restore lock');
  if (!stat.isFile()) throw new Error('restore lock must be a regular file');
  if (process.platform !== 'win32' && stat.uid !== process.getuid?.()) {
    throw new Error('restore lock ownership mismatch');
  }
  if ((stat.mode & 0o777) !== 0o600) {
    throw new Error('restore lock mode must be 0600');
  }
  const payload = parseLockPayload(fs.readFileSync(lockPath, 'utf8'));
  if (payload.destinationRoot !== expectedDestination) {
    throw new Error('restore lock destination binding mismatch');
  }
  return payload;
}

function removeStaleLockIfDead(lockPath, expectedDestination) {
  if (!fs.existsSync(lockPath)) return false;
  let payload;
  try {
    payload = validateLockOwnership(lockPath, expectedDestination);
  } catch {
    throw new Error('restore lock unavailable');
  }
  if (isProcessAlive(payload.pid)) return false;
  fs.unlinkSync(lockPath);
  return true;
}

function createLockFile(lockPath, destinationRoot) {
  const payload = {
    kind: LOCK_KIND,
    schemaVersion: LOCK_SCHEMA_VERSION,
    pid: process.pid,
    destinationRoot,
    createdAt: new Date().toISOString(),
  };
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

function acquireRestoreLock({ layout, canonicalDestination, dryRun = false, env = process.env }) {
  if (dryRun) {
    const tempLock = path.join(
      fs.mkdtempSync(path.join(os.tmpdir(), 'darkfinances-restore-lock-dry-')),
      LOCK_FILENAME,
    );
    createLockFile(tempLock, canonicalDestination);
    return {
      lockPath: tempLock,
      temporary: true,
      release() {
        try {
          if (fs.existsSync(tempLock)) fs.unlinkSync(tempLock);
          const parent = path.dirname(tempLock);
          if (fs.existsSync(parent)) fs.rmdirSync(parent);
        } catch {
          // best-effort dry-run cleanup
        }
      },
    };
  }

  if (env.RESTORE_TEST_SKIP_LOCK === '1') {
    return { lockPath: null, temporary: true, release() {} };
  }

  const lockPath = lockPathForLayout(layout);
  if (fs.existsSync(lockPath)) {
    const stat = fs.lstatSync(lockPath);
    if (stat.isSymbolicLink()) throw new Error('restore lock must not be a symbolic link');
    let payload;
    try {
      payload = validateLockOwnership(lockPath, canonicalDestination);
    } catch {
      throw new Error('restore lock unavailable');
    }
    if (isProcessAlive(payload.pid)) {
      throw new Error('restore already in progress');
    }
    removeStaleLockIfDead(lockPath, canonicalDestination);
  }

  try {
    createLockFile(lockPath, canonicalDestination);
  } catch (error) {
    if (error.code === 'EEXIST') {
      throw new Error('restore already in progress');
    }
    throw error;
  }

  return {
    lockPath,
    temporary: false,
    release() {
      if (!lockPath || !fs.existsSync(lockPath)) return;
      const stat = fs.lstatSync(lockPath);
      if (stat.isSymbolicLink()) return;
      if (!stat.isFile()) return;
      try {
        const payload = parseLockPayload(fs.readFileSync(lockPath, 'utf8'));
        if (payload.pid !== process.pid) return;
      } catch {
        return;
      }
      fs.unlinkSync(lockPath);
      fsyncPath(path.dirname(lockPath), true);
    },
  };
}

module.exports = {
  LOCK_FILENAME,
  LOCK_KIND,
  LOCK_SCHEMA_VERSION,
  lockPathForLayout,
  acquireRestoreLock,
  isProcessAlive,
  parseLockPayload,
  validateLockOwnership,
  removeStaleLockIfDead,
};
