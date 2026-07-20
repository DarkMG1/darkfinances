'use strict';

const fs = require('fs');
const path = require('path');

const CONTROL_DIR_NAME = '.darkfinances-restore';
const JOURNAL_FILENAME = 'journal.json';
const WORK_SUBDIR = 'work';
const SNAPSHOT_SUBDIR = 'snapshot';
const SNAPSHOT_MANIFEST = 'snapshot-manifest.json';

function assertNotSymlink(lstatTarget, label) {
  if (lstatTarget.isSymbolicLink()) {
    throw new Error(`${label} must not be a symbolic link`);
  }
}

function assertSafeDirectory(dirPath, label = 'directory') {
  if (!fs.existsSync(dirPath)) return null;
  const stat = fs.lstatSync(dirPath);
  assertNotSymlink(stat, label);
  if (!stat.isDirectory()) throw new Error(`${label} must be a directory`);
  return stat;
}

function assertSafeRegularFile(filePath, label = 'file') {
  if (!fs.existsSync(filePath)) return null;
  const stat = fs.lstatSync(filePath);
  assertNotSymlink(stat, label);
  if (!stat.isFile()) throw new Error(`${label} must be a regular file`);
  return stat;
}

function resolveCanonicalDestination(destinationRoot) {
  if (!destinationRoot || typeof destinationRoot !== 'string') {
    throw new Error('destinationRoot is required');
  }
  const resolved = path.resolve(destinationRoot);
  const parent = path.dirname(resolved);
  if (!fs.existsSync(parent)) {
    throw new Error(`destination parent does not exist: ${parent}`);
  }
  assertSafeDirectory(parent, 'destination parent');
  if (fs.existsSync(resolved)) {
    assertSafeDirectory(resolved, 'destination root');
    return fs.realpathSync(resolved);
  }
  return resolved;
}

function controlLayoutForDestination(destinationRoot) {
  const canonicalDestination = resolveCanonicalDestination(destinationRoot);
  const controlRoot = path.join(canonicalDestination, CONTROL_DIR_NAME);
  return {
    canonicalDestination,
    controlRoot,
    journalPath: path.join(controlRoot, JOURNAL_FILENAME),
    workRoot: path.join(controlRoot, WORK_SUBDIR),
    snapshotRoot: path.join(controlRoot, SNAPSHOT_SUBDIR),
    snapshotManifestPath: path.join(controlRoot, SNAPSHOT_SUBDIR, SNAPSHOT_MANIFEST),
  };
}

function ensureControlRoot(layout, { create = true } = {}) {
  assertSafeDirectory(layout.canonicalDestination, 'destination root');
  if (!create) {
    assertSafeDirectory(layout.controlRoot, 'restore control root');
    return layout.controlRoot;
  }
  if (fs.existsSync(layout.controlRoot)) {
    assertSafeDirectory(layout.controlRoot, 'restore control root');
  } else {
    fs.mkdirSync(layout.controlRoot, { recursive: true, mode: 0o700 });
  }
  const stat = fs.lstatSync(layout.controlRoot);
  if ((stat.mode & 0o777) !== 0o700) fs.chmodSync(layout.controlRoot, 0o700);
  return layout.controlRoot;
}

function ensurePrivateSubdir(parent, name) {
  const target = path.join(parent, name);
  if (fs.existsSync(target)) {
    assertSafeDirectory(target, name);
  } else {
    fs.mkdirSync(target, { recursive: true, mode: 0o700 });
  }
  return target;
}

function assertControlPathsSafe(layout) {
  for (const [label, target] of [
    ['restore control root', layout.controlRoot],
    ['restore work root', layout.workRoot],
    ['restore snapshot root', layout.snapshotRoot],
    ['restore journal', layout.journalPath],
  ]) {
    if (!fs.existsSync(target)) continue;
    if (target.endsWith('.json')) assertSafeRegularFile(target, label);
    else assertSafeDirectory(target, label);
  }
}

function destinationExists(destinationRoot) {
  const resolved = path.resolve(destinationRoot);
  return fs.existsSync(resolved) && fs.lstatSync(resolved).isDirectory() && !fs.lstatSync(resolved).isSymbolicLink();
}

module.exports = {
  CONTROL_DIR_NAME,
  JOURNAL_FILENAME,
  WORK_SUBDIR,
  SNAPSHOT_SUBDIR,
  SNAPSHOT_MANIFEST,
  resolveCanonicalDestination,
  controlLayoutForDestination,
  ensureControlRoot,
  ensurePrivateSubdir,
  assertControlPathsSafe,
  assertSafeDirectory,
  assertSafeRegularFile,
  assertNotSymlink,
  destinationExists,
};
