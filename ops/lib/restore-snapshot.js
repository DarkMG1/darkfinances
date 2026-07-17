'use strict';

const fs = require('fs');
const path = require('path');
const crypto = require('crypto');
const { sha256File } = require('./backup-verify');
const { writeFileAtomic, fsyncFile, fsyncPath } = require('./restore-durable-io');
const { assertSafeRegularFile, assertSafeDirectory } = require('./restore-control-layout');
const { listDestinationRuntimeFiles } = require('./restore-generation-binding');
const { SNAPSHOT_MANIFEST } = require('./restore-control-layout');

const SNAPSHOT_KIND = 'darkfinances-restore-snapshot';
const SNAPSHOT_SCHEMA_VERSION = 1;

function canonicalEntry(entry) {
  return JSON.stringify({
    path: entry.path,
    present: entry.present === true,
    sha256: entry.sha256 ?? null,
    bytes: entry.bytes ?? null,
    mode: entry.mode ?? null,
  });
}

function snapshotDigest(entries) {
  const hash = crypto.createHash('sha256');
  for (const entry of [...entries].sort((a, b) => a.path.localeCompare(b.path))) {
    hash.update(`${canonicalEntry(entry)}\n`);
  }
  return hash.digest('hex');
}

function buildSnapshotManifest(destinationRoot, inventory) {
  const relativeFiles = listDestinationRuntimeFiles(destinationRoot, inventory);
  const entries = relativeFiles.map((relativePath) => {
    const absolute = path.join(destinationRoot, relativePath);
    const stat = fs.lstatSync(absolute);
    return {
      path: relativePath,
      present: true,
      sha256: sha256File(absolute),
      bytes: stat.size,
      mode: stat.mode & 0o777,
    };
  }).sort((a, b) => a.path.localeCompare(b.path));
  const digest = snapshotDigest(entries);
  return {
    kind: SNAPSHOT_KIND,
    schemaVersion: SNAPSHOT_SCHEMA_VERSION,
    destinationRoot,
    capturedAt: new Date().toISOString(),
    entries,
    digest,
  };
}

function captureSnapshotToDisk({ destinationRoot, snapshotRoot, inventory }) {
  assertSafeDirectory(snapshotRoot, 'snapshot root');
  for (const name of fs.readdirSync(snapshotRoot)) {
    if (name === SNAPSHOT_MANIFEST) continue;
    fs.rmSync(path.join(snapshotRoot, name), { recursive: true, force: true });
  }
  const manifest = buildSnapshotManifest(destinationRoot, inventory);
  for (const entry of manifest.entries) {
    const source = path.join(destinationRoot, entry.path);
    const target = path.join(snapshotRoot, entry.path);
    fs.mkdirSync(path.dirname(target), { recursive: true, mode: 0o700 });
    fs.copyFileSync(source, target);
    fs.chmodSync(target, entry.mode & 0o777);
    fsyncFile(target);
  }
  const manifestPath = path.join(snapshotRoot, SNAPSHOT_MANIFEST);
  writeFileAtomic(manifestPath, `${JSON.stringify(manifest, null, 2)}\n`, 0o600);
  fsyncPath(snapshotRoot, true);
  return manifest;
}

function readSnapshotManifest(snapshotRoot) {
  const manifestPath = path.join(snapshotRoot, SNAPSHOT_MANIFEST);
  assertSafeRegularFile(manifestPath, 'snapshot manifest');
  const manifest = JSON.parse(fs.readFileSync(manifestPath, 'utf8'));
  if (manifest.kind !== SNAPSHOT_KIND) throw new Error('snapshot manifest kind mismatch');
  if (manifest.schemaVersion !== SNAPSHOT_SCHEMA_VERSION) {
    throw new Error(`unsupported snapshot schemaVersion ${manifest.schemaVersion}`);
  }
  if (manifest.digest !== snapshotDigest(manifest.entries)) {
    throw new Error('snapshot manifest digest mismatch');
  }
  return manifest;
}

function verifyDestinationMatchesSnapshot(destinationRoot, manifest, inventory) {
  const live = buildSnapshotManifest(destinationRoot, inventory);
  if (live.digest !== manifest.digest) {
    throw new Error('destination does not match pre-restore snapshot digest');
  }
  return live;
}

function copyFilePrivate(source, destination, mode) {
  fs.mkdirSync(path.dirname(destination), { recursive: true, mode: 0o700 });
  fs.copyFileSync(source, destination);
  fs.chmodSync(destination, mode & 0o777);
  fsyncFile(destination);
}

function removePathIfExists(target) {
  if (!fs.existsSync(target)) return;
  const stat = fs.lstatSync(target);
  if (stat.isSymbolicLink()) throw new Error(`refusing to remove symbolic link: ${target}`);
  if (stat.isDirectory()) fs.rmSync(target, { recursive: true, force: true });
  else fs.rmSync(target, { force: true });
}

function applySnapshotRollback({
  destinationRoot,
  snapshotRoot,
  snapshotManifest,
  inventory,
  injectFault,
  onPhase,
}) {
  if (!snapshotManifest || !fs.existsSync(snapshotRoot)) {
    throw new Error('pre-restore snapshot missing; destination may be mixed-generation');
  }
  readSnapshotManifest(snapshotRoot);
  const snapshotPaths = new Set(snapshotManifest.entries.filter((e) => e.present).map((e) => e.path));
  const liveFiles = listDestinationRuntimeFiles(destinationRoot, inventory);

  onPhase?.('rollback:start');
  injectFault?.('before:rollback');

  for (const relative of liveFiles) {
    if (snapshotPaths.has(relative)) continue;
    injectFault?.('before:rollback-delete-introduced', relative);
    onPhase?.('rollback:delete-introduced', relative);
    removePathIfExists(path.join(destinationRoot, relative));
    injectFault?.('after:rollback-delete-introduced', relative);
  }

  for (const entry of snapshotManifest.entries) {
    if (!entry.present) continue;
    injectFault?.('before:rollback-restore', entry.path);
    onPhase?.('rollback:restore', entry.path);
    const source = path.join(snapshotRoot, entry.path);
    const destination = path.join(destinationRoot, entry.path);
    if (!fs.existsSync(source)) throw new Error(`snapshot missing ${entry.path}`);
    copyFilePrivate(source, destination, entry.mode);
    injectFault?.('after:rollback-restore', entry.path);
  }

  verifyDestinationMatchesSnapshot(destinationRoot, snapshotManifest, inventory);
  onPhase?.('rollback:complete');
  injectFault?.('after:rollback');
}

function stagingTreeDigest(stagingRoot, relativeFiles) {
  const hash = crypto.createHash('sha256');
  for (const relative of [...relativeFiles].sort()) {
    const absolute = path.join(stagingRoot, relative);
    hash.update(relative);
    hash.update(sha256File(absolute));
    hash.update(String(fs.statSync(absolute).size));
    hash.update(String(fs.statSync(absolute).mode & 0o777));
  }
  return hash.digest('hex');
}

module.exports = {
  SNAPSHOT_KIND,
  SNAPSHOT_SCHEMA_VERSION,
  snapshotDigest,
  buildSnapshotManifest,
  captureSnapshotToDisk,
  readSnapshotManifest,
  verifyDestinationMatchesSnapshot,
  applySnapshotRollback,
  stagingTreeDigest,
};
