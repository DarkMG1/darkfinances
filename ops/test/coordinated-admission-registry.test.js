'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const os = require('os');
const path = require('path');
const { spawnSync } = require('child_process');
const {
  registerAdmission,
  consumeAdmission,
  revokeAdmission,
  assertAdmissionConsumable,
  registryRootForLayout,
} = require('../lib/coordinated-admission-registry');
const { coordinatedLayoutForRoot } = require('../lib/coordinated-operation-layout');

const registryHelper = path.join(__dirname, '..', 'lib', 'coordinated-admission-registry.js');

function mkRoot(t, prefix) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), prefix));
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  return root;
}

function sampleEntry(nonce = 'nonce-1') {
  const now = new Date().toISOString();
  return {
    nonce,
    runId: 'run-1',
    journalId: 'journal-1',
    issuedAt: now,
    expiresAt: new Date(Date.now() + 60_000).toISOString(),
  };
}

test('register rejects duplicate nonce', (t) => {
  const root = mkRoot(t, 'df-registry-dup-');
  const layout = coordinatedLayoutForRoot(path.join(root, 'backups'));
  fs.mkdirSync(layout.controlRoot, { recursive: true, mode: 0o700 });
  registerAdmission(layout, sampleEntry('dup'));
  assert.throws(() => registerAdmission(layout, sampleEntry('dup')), /already registered/);
});

test('consume is idempotent under races and rejects second use', (t) => {
  const root = mkRoot(t, 'df-registry-consume-');
  const layout = coordinatedLayoutForRoot(path.join(root, 'backups'));
  fs.mkdirSync(layout.controlRoot, { recursive: true, mode: 0o700 });
  registerAdmission(layout, sampleEntry('race-nonce'));
  consumeAdmission(layout, 'race-nonce');
  assert.throws(() => consumeAdmission(layout, 'race-nonce'), /already consumed/);
  assert.throws(
    () => assertAdmissionConsumable(layout, 'race-nonce'),
    /consumed/,
  );
});

test('revoke is idempotent and blocks consume', (t) => {
  const root = mkRoot(t, 'df-registry-revoke-');
  const layout = coordinatedLayoutForRoot(path.join(root, 'backups'));
  fs.mkdirSync(layout.controlRoot, { recursive: true, mode: 0o700 });
  registerAdmission(layout, sampleEntry('revoke-nonce'));
  revokeAdmission(layout, 'revoke-nonce', 'restore_failed');
  revokeAdmission(layout, 'revoke-nonce', 'restore_failed');
  assert.throws(() => consumeAdmission(layout, 'revoke-nonce'), /revoked/);
});

test('concurrent consume from separate processes allows one winner', (t) => {
  const root = mkRoot(t, 'df-registry-concurrent-');
  const layout = coordinatedLayoutForRoot(path.join(root, 'backups'));
  fs.mkdirSync(layout.controlRoot, { recursive: true, mode: 0o700 });
  registerAdmission(layout, sampleEntry('parallel-nonce'));
  const worker = `
    const { coordinatedLayoutForRoot } = require(${JSON.stringify(path.join(__dirname, '..', 'lib', 'coordinated-operation-layout.js'))});
    const { consumeAdmission } = require(${JSON.stringify(registryHelper)});
    const layout = coordinatedLayoutForRoot(${JSON.stringify(path.join(root, 'backups'))});
    try {
      consumeAdmission(layout, 'parallel-nonce');
      process.stdout.write('consumed');
      process.exit(0);
    } catch (error) {
      process.stdout.write(String(error.message));
      process.exit(2);
    }
  `;
  const first = spawnSync(process.execPath, ['-e', worker], { encoding: 'utf8' });
  const second = spawnSync(process.execPath, ['-e', worker], { encoding: 'utf8' });
  const statuses = [first.status, second.status].sort();
  assert.deepEqual(statuses, [0, 2]);
  const outputs = `${first.stdout}${second.stdout}`;
  assert.match(outputs, /consumed/);
  assert.match(outputs, /already consumed/);
});

test('concurrent register of different nonces both succeed', (t) => {
  const root = mkRoot(t, 'df-registry-multi-');
  const layout = coordinatedLayoutForRoot(path.join(root, 'backups'));
  fs.mkdirSync(layout.controlRoot, { recursive: true, mode: 0o700 });
  registerAdmission(layout, sampleEntry('nonce-a'));
  registerAdmission(layout, sampleEntry('nonce-b'));
  assert.doesNotThrow(() => assertAdmissionConsumable(layout, 'nonce-a'));
  assert.doesNotThrow(() => assertAdmissionConsumable(layout, 'nonce-b'));
  assert.ok(fs.existsSync(path.join(registryRootForLayout(layout), 'registered/nonce-a.json')));
  assert.ok(fs.existsSync(path.join(registryRootForLayout(layout), 'registered/nonce-b.json')));
});
