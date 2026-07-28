'use strict';

const crypto = require('crypto');
const fs = require('fs');
const os = require('os');
const path = require('path');

const DEFAULT_TIMEOUT_MS = 60_000;

function fail(message) {
  throw new Error(message);
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

function readLockEntry(lockPath) {
  try {
    const raw = fs.readFileSync(lockPath, 'utf8');
    const payload = JSON.parse(raw);
    return { payload, raw };
  } catch {
    return null;
  }
}

function lockIdentity(entry) {
  if (!entry?.payload || typeof entry.payload !== 'object') return null;
  const { pid, token, startedAt } = entry.payload;
  if (!Number.isInteger(pid) || typeof token !== 'string' || typeof startedAt !== 'string') {
    return null;
  }
  return `${pid}\0${token}\0${startedAt}`;
}

function writeLockPayload(lockPath, payload) {
  fs.writeFileSync(lockPath, `${JSON.stringify(payload)}\n`, { flag: 'wx' });
}

function defaultSleep(ms) {
  const start = Date.now();
  while (Date.now() - start < ms) {
    // bounded spin while waiting for bootstrap lock
  }
}

function unlinkIfUnchanged(lockPath, expectedEntry) {
  try {
    if (!fs.existsSync(lockPath)) return true;
    if (expectedEntry) {
      const current = readLockEntry(lockPath);
      if (!current || current.raw !== expectedEntry.raw) return false;
    }
    fs.rmSync(lockPath, { force: true });
    return true;
  } catch {
    return false;
  }
}

function canReclaimLock(existing) {
  if (!existing) return true;
  const identity = lockIdentity(existing);
  if (!identity) return true;
  const ownerAlive = isProcessAlive(existing.payload.pid);
  return !ownerAlive;
}

function acquireBootstrapLock(installRoot, {
  timeoutMs = DEFAULT_TIMEOUT_MS,
  now = Date.now,
  sleep = defaultSleep,
  randomUuid = crypto.randomUUID,
} = {}) {
  if (fs.existsSync(installRoot) && fs.lstatSync(installRoot).isSymbolicLink()) {
    fail(`install root must not be a symlink: ${installRoot}`);
  }
  fs.mkdirSync(installRoot, { recursive: true });
  const lockPath = path.join(installRoot, '.bootstrap.lock');
  const deadline = now() + timeoutMs;
  const token = randomUuid();
  while (now() < deadline) {
    const payload = {
      pid: process.pid,
      token,
      startedAt: new Date().toISOString(),
      hostname: os.hostname(),
    };
    try {
      writeLockPayload(lockPath, payload);
      return {
        lockPath,
        token,
        release() {
          try {
            const current = readLockEntry(lockPath);
            if (current?.payload?.pid === process.pid && current?.payload?.token === token) {
              unlinkIfUnchanged(lockPath, current);
            }
          } catch {
            // ignore release races
          }
        },
      };
    } catch (error) {
      if (error.code !== 'EEXIST') throw error;
      const existing = readLockEntry(lockPath);
      if (canReclaimLock(existing)) {
        unlinkIfUnchanged(lockPath, existing);
        continue;
      }
      sleep(Math.min(250, Math.max(0, deadline - now())));
    }
  }
  fail(`timed out waiting for bootstrap lock at ${lockPath}`);
}

module.exports = {
  acquireBootstrapLock,
  canReclaimLock,
  isProcessAlive,
  lockIdentity,
  readLockEntry,
  unlinkIfUnchanged,
};
