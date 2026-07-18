'use strict';

const fs = require('fs');
const os = require('os');
const path = require('path');
const { ExportSourceChangedError, digestStableJson } = require('./reimbursement-export-common');
const { assertNotSymlink } = require('./private-durable-io');

const LOCK_KIND = 'darkfinances-reimb-export-lock';
const LOCK_SCHEMA_VERSION = 1;
const DEFAULT_LOCK_WAIT_MS = 250;
const DEFAULT_LOCK_TIMEOUT_MS = 5000;

function lockPathForLinksFile(linksPath) {
  return path.join(path.dirname(linksPath), 'reimb-export.lock');
}

function isProcessAlive(pid) {
  if (!Number.isSafeInteger(pid) || pid <= 0) return false;
  try {
    process.kill(pid, 0);
    return true;
  } catch (error) {
    return error.code === 'EPERM';
  }
}

function parseLockPayload(text) {
  let parsed;
  try {
    parsed = JSON.parse(text);
  } catch (error) {
    throw new Error(`reimb-export lock is not valid JSON: ${error.message}`);
  }
  if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) {
    throw new Error('reimb-export lock must be a JSON object');
  }
  if (parsed.kind !== LOCK_KIND) throw new Error('reimb-export lock kind mismatch');
  if (parsed.schemaVersion !== LOCK_SCHEMA_VERSION) {
    throw new Error(`unsupported reimb-export lock schemaVersion ${parsed.schemaVersion}`);
  }
  if (!Number.isSafeInteger(parsed.pid) || parsed.pid <= 0) {
    throw new Error('reimb-export lock requires a positive integer pid');
  }
  if (typeof parsed.linksRevision !== 'number' || !Number.isSafeInteger(parsed.linksRevision) || parsed.linksRevision < 0) {
    throw new Error('reimb-export lock requires linksRevision');
  }
  if (typeof parsed.createdAt !== 'string' || !parsed.createdAt) {
    throw new Error('reimb-export lock requires createdAt');
  }
  return parsed;
}

function validateLockOwnership(lockPath, expectedRevision) {
  assertNotSymlink(lockPath, 'reimb-export lock');
  const stat = fs.lstatSync(lockPath);
  if (!stat.isFile()) throw new Error('reimb-export lock must be a regular file');
  if (process.platform !== 'win32' && stat.uid !== process.getuid?.()) {
    throw new Error('reimb-export lock ownership mismatch');
  }
  if ((stat.mode & 0o777) !== 0o600) throw new Error('reimb-export lock mode must be 0600');
  const payload = parseLockPayload(fs.readFileSync(lockPath, 'utf8'));
  if (payload.linksRevision !== expectedRevision) {
    throw new ExportSourceChangedError('reimb-export lock revision binding mismatch');
  }
  return payload;
}

function removeStaleLockIfDead(lockPath) {
  if (!fs.existsSync(lockPath)) return false;
  try {
    const payload = parseLockPayload(fs.readFileSync(lockPath, 'utf8'));
    if (isProcessAlive(payload.pid)) return false;
  } catch {
    fs.unlinkSync(lockPath);
    return true;
  }
  fs.unlinkSync(lockPath);
  return true;
}

function createLockFile(lockPath, linksRevision) {
  const payload = {
    kind: LOCK_KIND,
    schemaVersion: LOCK_SCHEMA_VERSION,
    pid: process.pid,
    linksRevision,
    createdAt: new Date().toISOString(),
  };
  assertNotSymlink(lockPath, 'reimb-export lock');
  if (fs.existsSync(lockPath)) {
    const error = new Error(`reimb-export lock already exists: ${lockPath}`);
    error.code = 'EEXIST';
    throw error;
  }
  const contents = `${JSON.stringify(payload, null, 2)}\n`;
  let fd;
  try {
    fd = fs.openSync(lockPath, 'wx', 0o600);
    fs.writeFileSync(fd, contents, 'utf8');
    fs.fsyncSync(fd);
    fs.closeSync(fd);
  } catch (cause) {
    if (fd !== undefined) {
      try { fs.closeSync(fd); } catch (_) {}
    }
    try { fs.unlinkSync(lockPath); } catch (_) {}
    throw cause;
  }
  return payload;
}

function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

function assertExportLockAvailable(linksPath) {
  const lockPath = lockPathForLinksFile(linksPath);
  if (!fs.existsSync(lockPath)) return;
  let payload;
  try {
    payload = validateLockOwnership(lockPath, parseLockPayload(fs.readFileSync(lockPath, 'utf8')).linksRevision);
  } catch {
    throw new ExportSourceChangedError('reimbursement links sidecar is locked for export');
  }
  if (isProcessAlive(payload.pid)) {
    throw new ExportSourceChangedError('reimbursement links sidecar is locked for export');
  }
  fs.unlinkSync(lockPath);
}

function acquireExportSnapshotLock(linksPath, linksRevision, { timeoutMs = DEFAULT_LOCK_TIMEOUT_MS } = {}) {
  const lockPath = lockPathForLinksFile(linksPath);
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    removeStaleLockIfDead(lockPath);
    try {
      createLockFile(lockPath, linksRevision);
      return {
        lockPath,
        release() {
          try {
            if (fs.existsSync(lockPath)) {
              validateLockOwnership(lockPath, linksRevision);
              fs.unlinkSync(lockPath);
            }
          } catch (_) {
            // best-effort release
          }
        },
      };
    } catch (cause) {
      if (cause?.code !== 'EEXIST') throw cause;
    }
    // spin-wait briefly; bounded by timeoutMs
    const deadlineSlice = Date.now() + DEFAULT_LOCK_WAIT_MS;
    while (Date.now() < deadlineSlice) {
      // bounded spin-wait
    }
  }
  throw new ExportSourceChangedError('timed out waiting for reimb-export lock');
}

function sidecarSnapshotDigest({ linksRevision, links, activeSagas }) {
  return digestStableJson({
    linksRevision,
    links,
    activeSagas: (activeSagas || []).map((saga) => ({
      id: saga.id,
      phase: saga.phase,
      action: saga.action,
      inflowId: saga.inflowId || null,
      expenseId: saga.expenseId || null,
    })).sort((a, b) => String(a.id).localeCompare(String(b.id))),
  });
}

function assertSnapshotUnchanged(beforeDigest, afterDigest) {
  if (beforeDigest !== afterDigest) {
    throw new ExportSourceChangedError();
  }
}

module.exports = {
  DEFAULT_LOCK_TIMEOUT_MS,
  acquireExportSnapshotLock,
  assertExportLockAvailable,
  assertSnapshotUnchanged,
  lockPathForLinksFile,
  sidecarSnapshotDigest,
};
