'use strict';

const fs = require('fs');
const path = require('path');
const {
  assertNotSymlink,
  assertSafeDirectory,
  assertSafeRegularFile,
} = require('./restore-control-layout');

const CONTROL_DIR_NAME = '.darkfinances-coordinated';
const LOCK_FILENAME = 'coordinated.lock';
const JOURNAL_FILENAME = 'run-journal.json';
const WORK_SUBDIR = 'work';

function resolveSafeRoot(rootPath, label = 'coordinated root') {
  if (!rootPath || typeof rootPath !== 'string') {
    throw new Error(`${label} is required`);
  }
  const resolved = path.resolve(rootPath);
  const parent = path.dirname(resolved);
  if (!fs.existsSync(parent)) {
    throw new Error(`${label} parent does not exist: ${parent}`);
  }
  assertSafeDirectory(parent, `${label} parent`);
  if (fs.existsSync(resolved)) {
    assertSafeDirectory(resolved, label);
    return fs.realpathSync(resolved);
  }
  return resolved;
}

function coordinatedLayoutForRoot(rootPath) {
  const canonicalRoot = resolveSafeRoot(rootPath, 'backup destination');
  const controlRoot = path.join(canonicalRoot, CONTROL_DIR_NAME);
  return {
    canonicalRoot,
    controlRoot,
    lockPath: path.join(controlRoot, LOCK_FILENAME),
    journalPath: path.join(controlRoot, JOURNAL_FILENAME),
    workRoot: path.join(controlRoot, WORK_SUBDIR),
  };
}

function ensureCoordinatedControlRoot(layout, { create = true } = {}) {
  assertSafeDirectory(layout.canonicalRoot, 'backup destination');
  if (!create) {
    assertSafeDirectory(layout.controlRoot, 'coordinated control root');
    return layout.controlRoot;
  }
  if (fs.existsSync(layout.controlRoot)) {
    assertSafeDirectory(layout.controlRoot, 'coordinated control root');
  } else {
    fs.mkdirSync(layout.controlRoot, { recursive: true, mode: 0o700 });
  }
  const stat = fs.lstatSync(layout.controlRoot);
  if ((stat.mode & 0o777) !== 0o700) fs.chmodSync(layout.controlRoot, 0o700);
  return layout.controlRoot;
}

function assertCoordinatedPathsSafe(layout) {
  for (const [label, target] of [
    ['coordinated control root', layout.controlRoot],
    ['coordinated work root', layout.workRoot],
    ['coordinated journal', layout.journalPath],
    ['coordinated lock', layout.lockPath],
  ]) {
    if (!fs.existsSync(target)) continue;
    if (target.endsWith('.json') || target.endsWith('.lock')) {
      assertSafeRegularFile(target, label);
    } else {
      assertSafeDirectory(target, label);
    }
  }
}

module.exports = {
  CONTROL_DIR_NAME,
  LOCK_FILENAME,
  JOURNAL_FILENAME,
  WORK_SUBDIR,
  resolveSafeRoot,
  coordinatedLayoutForRoot,
  ensureCoordinatedControlRoot,
  assertCoordinatedPathsSafe,
  assertNotSymlink,
};
