'use strict';

const fs = require('fs');
const path = require('path');

const MAX_MANIFEST_BYTES = 4 * 1024 * 1024;
const MAX_JSON_EVIDENCE_BYTES = MAX_MANIFEST_BYTES;
const MAX_OTA_RESULT_BYTES = 256 * 1024;
const MAX_ACTUAL_GENERATION_EVIDENCE_BYTES = 256;

function requireNonEmptyString(value, label) {
  if (typeof value !== 'string' || !value) {
    throw new Error(`${label} is required`);
  }
  return value;
}

function assertPositiveSafeInteger(value, label) {
  if (!Number.isSafeInteger(value) || value <= 0) {
    throw new Error(`${label} must be a positive safe integer`);
  }
  return value;
}

function validateAllowedModes(allowedModes) {
  if (!Array.isArray(allowedModes) || allowedModes.length === 0) {
    throw new Error('allowedModes must be a non-empty array');
  }
  for (const mode of allowedModes) {
    if (!Number.isSafeInteger(mode) || mode < 0 || mode > 0o777) {
      throw new Error('allowedModes entries must be safe octal file modes');
    }
  }
  return allowedModes;
}

function resolveTrustedOpenFlags() {
  const noFollow = fs.constants.O_NOFOLLOW;
  if (!noFollow) {
    throw new Error('trusted regular-file reads require O_NOFOLLOW support on this platform');
  }
  return fs.constants.O_RDONLY | noFollow | (fs.constants.O_NONBLOCK || 0);
}

function assertTrustedRegularFileStat(stat, resolved, {
  label = 'file',
  maxBytes,
  allowedModes = [0o600],
} = {}) {
  assertPositiveSafeInteger(maxBytes, `${label} maxBytes`);
  validateAllowedModes(allowedModes);
  if (stat.isSymbolicLink()) {
    throw new Error(`${label} must not be a symbolic link: ${resolved}`);
  }
  if (!stat.isFile()) {
    throw new Error(`${label} must be a regular file: ${resolved}`);
  }
  if (stat.nlink !== 1) {
    throw new Error(`${label} must not be hard-linked: ${resolved}`);
  }
  if (typeof process.getuid === 'function' && stat.uid !== process.getuid()) {
    throw new Error(`${label} must be owned by the current user: ${resolved}`);
  }
  const mode = stat.mode & 0o777;
  if (!allowedModes.includes(mode)) {
    throw new Error(
      `${label} permissions must be ${allowedModes.map((entry) => entry.toString(8)).join(' or ')}: ${resolved}`,
    );
  }
  if (stat.size <= 0 || stat.size > maxBytes) {
    throw new Error(`${label} size is out of bounds: ${resolved}`);
  }
}

function assertDescriptorIdentity(left, right, label, resolved) {
  if (
    left.dev !== right.dev
    || left.ino !== right.ino
    || left.size !== right.size
  ) {
    throw new Error(`${label} changed before it could be read`);
  }
}

function assertDescriptorMetadataStable(before, after, label) {
  if (before.mtimeMs !== after.mtimeMs || before.ctimeMs !== after.ctimeMs) {
    throw new Error(`${label} changed while it was being read`);
  }
}

function closeDescriptorQuietly(closeSync, descriptor) {
  if (descriptor === undefined) return;
  try {
    closeSync(descriptor);
  } catch {
    // best-effort
  }
}

function readTrustedRegularFile(filePath, {
  label = 'file',
  maxBytes,
  allowedModes = [0o600],
  validateStat = null,
  preOpenValidate = null,
} = {}, dependencies = {}) {
  assertPositiveSafeInteger(maxBytes, `${label} maxBytes`);
  validateAllowedModes(allowedModes);
  const lstatSync = dependencies.lstatSync || fs.lstatSync;
  const openSync = dependencies.openSync || fs.openSync;
  const fstatSync = dependencies.fstatSync || fs.fstatSync;
  const readSync = dependencies.readSync || fs.readSync;
  const closeSync = dependencies.closeSync || fs.closeSync;
  const resolved = path.resolve(requireNonEmptyString(filePath, `${label} path`));
  let before;
  try {
    before = lstatSync(resolved);
  } catch (error) {
    if (error.code === 'ENOENT') throw new Error(`${label} not found: ${resolved}`);
    throw error;
  }
  const statPolicy = validateStat || ((stat, targetPath) => {
    assertTrustedRegularFileStat(stat, targetPath, { label, maxBytes, allowedModes });
  });
  statPolicy(before, resolved);
  if (preOpenValidate) preOpenValidate(resolved, before);

  const openFlags = resolveTrustedOpenFlags();
  let descriptor;
  try {
    descriptor = openSync(resolved, openFlags);
    const opened = fstatSync(descriptor);
    statPolicy(opened, resolved);
    assertDescriptorIdentity(before, opened, label, resolved);

    const buffer = Buffer.alloc(opened.size);
    let offset = 0;
    while (offset < opened.size) {
      const bytesRead = readSync(descriptor, buffer, offset, opened.size - offset, offset);
      if (bytesRead <= 0) throw new Error(`${label} changed while it was being read`);
      offset += bytesRead;
    }

    const afterDescriptor = fstatSync(descriptor);
    statPolicy(afterDescriptor, resolved);
    assertDescriptorIdentity(opened, afterDescriptor, label, resolved);
    assertDescriptorMetadataStable(opened, afterDescriptor, label);

    const afterPath = lstatSync(resolved);
    statPolicy(afterPath, resolved);
    if (
      !afterPath.isFile()
      || afterPath.dev !== afterDescriptor.dev
      || afterPath.ino !== afterDescriptor.ino
      || afterPath.size !== afterDescriptor.size
    ) {
      throw new Error(`${label} path changed while it was being read`);
    }

    closeDescriptorQuietly(closeSync, descriptor);
    descriptor = undefined;
    return { buffer, resolved, mode: before.mode & 0o777 };
  } catch (error) {
    closeDescriptorQuietly(closeSync, descriptor);
    descriptor = undefined;
    throw error;
  }
}

module.exports = {
  MAX_ACTUAL_GENERATION_EVIDENCE_BYTES,
  MAX_JSON_EVIDENCE_BYTES,
  MAX_MANIFEST_BYTES,
  MAX_OTA_RESULT_BYTES,
  assertPositiveSafeInteger,
  assertTrustedRegularFileStat,
  readTrustedRegularFile,
  requireNonEmptyString,
  resolveTrustedOpenFlags,
  validateAllowedModes,
};
