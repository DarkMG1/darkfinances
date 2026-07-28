'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const os = require('os');
const path = require('path');
const {
  acquireBootstrapLock,
  canReclaimLock,
  isProcessAlive,
  readLockEntry,
  unlinkIfUnchanged,
} = require('../../scripts/toolchain-bootstrap-lock');

function sleepMs(ms) {
  const start = Date.now();
  while (Date.now() - start < ms) {
    // bounded spin for lock contention tests
  }
}

test('acquireBootstrapLock serializes concurrent bootstrap attempts', async (t) => {
  const installRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'bootstrap-lock-concurrent-'));
  t.after(() => fs.rmSync(installRoot, { recursive: true, force: true }));

  const first = acquireBootstrapLock(installRoot, { timeoutMs: 2_000 });
  let secondError;
  try {
    acquireBootstrapLock(installRoot, {
      timeoutMs: 250,
      sleep: sleepMs,
    });
  } catch (error) {
    secondError = error;
  }
  assert.match(String(secondError), /timed out waiting for bootstrap lock/);
  first.release();
  const second = acquireBootstrapLock(installRoot, { timeoutMs: 2_000 });
  second.release();
});

test('acquireBootstrapLock reclaims a fresh dead owner immediately', () => {
  const installRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'bootstrap-lock-dead-'));
  const lockPath = path.join(installRoot, '.bootstrap.lock');
  const stalePayload = {
    pid: 9_999_999,
    token: 'dead-token',
    startedAt: new Date().toISOString(),
    hostname: 'dead-owner',
  };
  fs.writeFileSync(lockPath, `${JSON.stringify(stalePayload)}\n`);
  assert.equal(isProcessAlive(stalePayload.pid), false);

  const started = Date.now();
  const lock = acquireBootstrapLock(installRoot, { timeoutMs: 2_000, sleep: sleepMs });
  assert.ok(Date.now() - started < 500, 'expected immediate reclaim without stale wait');
  lock.release();
  fs.rmSync(installRoot, { recursive: true, force: true });
});

test('acquireBootstrapLock does not steal a live owner lock based on age alone', () => {
  const installRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'bootstrap-lock-live-'));
  const lockPath = path.join(installRoot, '.bootstrap.lock');
  fs.mkdirSync(installRoot, { recursive: true });
  fs.writeFileSync(lockPath, `${JSON.stringify({
    pid: process.pid,
    token: 'live-token',
    startedAt: new Date(Date.now() - 3_600_000).toISOString(),
    hostname: os.hostname(),
  })}\n`);

  let blockedError;
  try {
    acquireBootstrapLock(installRoot, { timeoutMs: 250, sleep: sleepMs });
  } catch (error) {
    blockedError = error;
  }
  assert.match(String(blockedError), /timed out waiting for bootstrap lock/);
  fs.rmSync(installRoot, { recursive: true, force: true });
});

test('acquireBootstrapLock reclaims malformed lock files with bounded handling', () => {
  const installRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'bootstrap-lock-malformed-'));
  const lockPath = path.join(installRoot, '.bootstrap.lock');
  fs.writeFileSync(lockPath, 'not-json\n');
  assert.equal(canReclaimLock(readLockEntry(lockPath)), true);
  const lock = acquireBootstrapLock(installRoot, { timeoutMs: 2_000, sleep: sleepMs });
  lock.release();
  fs.rmSync(installRoot, { recursive: true, force: true });
});

test('unlinkIfUnchanged avoids deleting a replaced active lock', () => {
  const installRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'bootstrap-lock-race-'));
  const lockPath = path.join(installRoot, '.bootstrap.lock');
  const first = acquireBootstrapLock(installRoot, { timeoutMs: 2_000 });
  const snapshot = readLockEntry(lockPath);
  fs.writeFileSync(lockPath, `${JSON.stringify({
    pid: process.pid,
    token: 'replacement-token',
    startedAt: new Date().toISOString(),
    hostname: os.hostname(),
  })}\n`);
  assert.equal(unlinkIfUnchanged(lockPath, snapshot), false);
  assert.ok(fs.existsSync(lockPath));
  first.release();
  assert.ok(fs.existsSync(lockPath));
  fs.rmSync(installRoot, { recursive: true, force: true });
});

test('release only removes lock owned by matching token', () => {
  const installRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'bootstrap-lock-token-'));
  const lockPath = path.join(installRoot, '.bootstrap.lock');
  const lock = acquireBootstrapLock(installRoot, { timeoutMs: 2_000 });
  fs.writeFileSync(lockPath, `${JSON.stringify({
    pid: process.pid,
    token: 'foreign-token',
    startedAt: new Date().toISOString(),
    hostname: os.hostname(),
  })}\n`);
  lock.release();
  assert.ok(fs.existsSync(lockPath));
  fs.rmSync(installRoot, { recursive: true, force: true });
});

test('acquireBootstrapLock allows a second worker after the first releases', () => {
  const installRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'bootstrap-lock-second-'));
  const first = acquireBootstrapLock(installRoot, { timeoutMs: 2_000 });
  first.release();
  const second = acquireBootstrapLock(installRoot, { timeoutMs: 2_000 });
  second.release();
  fs.rmSync(installRoot, { recursive: true, force: true });
});

test('acquireBootstrapLock always releases lock in finally path', () => {
  const installRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'bootstrap-lock-finally-'));
  const lockPath = path.join(installRoot, '.bootstrap.lock');
  const lock = acquireBootstrapLock(installRoot, { timeoutMs: 2_000 });
  assert.equal(fs.existsSync(lockPath), true);
  try {
    throw new Error('simulated bootstrap failure');
  } catch {
    lock.release();
  }
  assert.equal(fs.existsSync(lockPath), false);
  fs.rmSync(installRoot, { recursive: true, force: true });
});
