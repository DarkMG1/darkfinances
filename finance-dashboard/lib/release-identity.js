const crypto = require('crypto');
const fs = require('fs');
const path = require('path');
const { DASHBOARD_RUNTIME_FILES } = require('./release-files');
const {
  isPlainObject,
  validateManifestEnvelope,
} = require('./release-schema');

const HASH_CHUNK_BYTES = 64 * 1024;

function hasValidContentDigest(manifest) {
  try {
    return validateManifestEnvelope(manifest);
  } catch {
    return false;
  }
}

function normalizeRuntimePath(value) {
  if (typeof value !== 'string' || !value || value.includes('\\') || value.startsWith('/')) {
    throw new Error('invalid deployed file path');
  }
  const parts = value.split('/');
  if (parts.some((part) => !part || part === '.' || part === '..')) {
    throw new Error('invalid deployed file path');
  }
  if (path.posix.normalize(value) !== value) throw new Error('invalid deployed file path');
  return value;
}

function hashRuntimeFile(runtimeDir, logicalPath, dependencies = {}) {
  const runtimeStat = fs.lstatSync(runtimeDir);
  if (runtimeStat.isSymbolicLink() || !runtimeStat.isDirectory()) {
    throw new Error('dashboard runtime directory must be a real directory');
  }
  const realRoot = fs.realpathSync(runtimeDir);
  const normalized = normalizeRuntimePath(logicalPath);
  let current = realRoot;
  let finalPathStat = null;
  for (const part of normalized.split('/')) {
    current = path.join(current, part);
    const stat = fs.lstatSync(current);
    if (stat.isSymbolicLink()) throw new Error('deployed file path contains a symbolic link');
    finalPathStat = stat;
  }
  if (!finalPathStat?.isFile()) throw new Error('deployed file must be a regular file');
  const candidate = path.resolve(realRoot, ...normalized.split('/'));
  const relative = path.relative(realRoot, candidate);
  if (relative === '..' || relative.startsWith(`..${path.sep}`) || path.isAbsolute(relative)) {
    throw new Error('deployed file escapes dashboard runtime directory');
  }

  const noFollow = fs.constants.O_NOFOLLOW || 0;
  const nonBlock = fs.constants.O_NONBLOCK || 0;
  const readSync = dependencies.readSync || fs.readSync;
  let descriptor;
  try {
    descriptor = fs.openSync(candidate, fs.constants.O_RDONLY | noFollow | nonBlock);
    const stat = fs.fstatSync(descriptor);
    if (!stat.isFile()) throw new Error('deployed file must be a regular file');
    if (stat.dev !== finalPathStat.dev || stat.ino !== finalPathStat.ino) {
      throw new Error('deployed file changed before hashing');
    }
    const hash = crypto.createHash('sha256');
    const chunk = Buffer.allocUnsafe(Math.min(HASH_CHUNK_BYTES, Math.max(1, stat.size)));
    let offset = 0;
    while (offset < stat.size) {
      const bytesRead = readSync(
        descriptor,
        chunk,
        0,
        Math.min(chunk.length, stat.size - offset),
        offset,
      );
      if (bytesRead <= 0) throw new Error('deployed file changed while hashing');
      hash.update(chunk.subarray(0, bytesRead));
      offset += bytesRead;
    }
    const extra = Buffer.allocUnsafe(1);
    if (readSync(descriptor, extra, 0, 1, offset) !== 0) {
      throw new Error('deployed file changed while hashing');
    }
    const after = fs.fstatSync(descriptor);
    if (
      after.size !== stat.size
      || after.mtimeMs !== stat.mtimeMs
      || after.ctimeMs !== stat.ctimeMs
      || after.ino !== stat.ino
      || after.dev !== stat.dev
    ) {
      throw new Error('deployed file changed while hashing');
    }
    const afterRoot = fs.lstatSync(runtimeDir);
    if (
      !afterRoot.isDirectory()
      || afterRoot.isSymbolicLink()
      || afterRoot.dev !== runtimeStat.dev
      || afterRoot.ino !== runtimeStat.ino
    ) {
      throw new Error('dashboard runtime directory changed while hashing');
    }
    let postCurrent = realRoot;
    let afterPath = null;
    for (const part of normalized.split('/')) {
      postCurrent = path.join(postCurrent, part);
      afterPath = fs.lstatSync(postCurrent);
      if (afterPath.isSymbolicLink()) {
        throw new Error('deployed file path gained a symbolic link while hashing');
      }
    }
    const postReal = fs.realpathSync(candidate);
    const postRelative = path.relative(realRoot, postReal);
    if (
      postRelative === '..'
      || postRelative.startsWith(`..${path.sep}`)
      || path.isAbsolute(postRelative)
      || !afterPath.isFile()
      || afterPath.isSymbolicLink()
      || afterPath.dev !== after.dev
      || afterPath.ino !== after.ino
    ) {
      throw new Error('deployed file path changed while hashing');
    }
    return {
      bytes: stat.size,
      executable: (stat.mode & 0o111) !== 0,
      sha256: hash.digest('hex'),
    };
  } finally {
    if (descriptor !== undefined) fs.closeSync(descriptor);
  }
}

function verifyDeployedFiles(content, runtimeDir, dependencies = {}) {
  if (typeof runtimeDir !== 'string' || !runtimeDir) {
    throw new Error('dashboard runtime directory is required for schema-v2 verification');
  }
  const entries = content.deployedFiles;
  if (!Array.isArray(entries) || entries.length === 0) {
    throw new Error('dashboard manifest requires deployed files');
  }
  const expectedFiles = dependencies.expectedFiles || DASHBOARD_RUNTIME_FILES;
  const expected = [...expectedFiles].map(normalizeRuntimePath).sort();
  if (new Set(expected).size !== expected.length) throw new Error('dashboard runtime allowlist has duplicates');

  let previous = null;
  const actualPaths = [];
  for (const entry of entries) {
    if (!isPlainObject(entry)) throw new Error('deployed file evidence must be an object');
    const keys = Object.keys(entry).sort();
    if (keys.join(',') !== 'bytes,executable,path,sha256') {
      throw new Error('deployed file evidence has unexpected fields');
    }
    const normalized = normalizeRuntimePath(entry.path);
    if (previous !== null && previous >= normalized) {
      throw new Error('deployed file paths must be unique and sorted');
    }
    previous = normalized;
    actualPaths.push(normalized);
    if (!Number.isSafeInteger(entry.bytes) || entry.bytes < 0) {
      throw new Error('deployed file byte count is invalid');
    }
    if (typeof entry.executable !== 'boolean') {
      throw new Error('deployed file executable state is invalid');
    }
    if (typeof entry.sha256 !== 'string' || !/^[a-f0-9]{64}$/.test(entry.sha256)) {
      throw new Error('deployed file SHA-256 is invalid');
    }
    const current = hashRuntimeFile(runtimeDir, normalized, dependencies);
    if (
      current.bytes !== entry.bytes
      || current.executable !== entry.executable
      || current.sha256 !== entry.sha256
    ) {
      throw new Error(`deployed file does not match manifest: ${normalized}`);
    }
  }
  if (
    actualPaths.length !== expected.length
    || actualPaths.some((entry, index) => entry !== expected[index])
  ) {
    throw new Error('deployed file set does not match dashboard runtime allowlist');
  }
  return true;
}

function releaseIdentityFromManifest(manifest, options = {}) {
  if (!manifest || typeof manifest !== 'object' || Array.isArray(manifest)) return null;
  let content;
  let schemaV2 = false;
  if (manifest.schemaVersion === 2) {
    if (!isPlainObject(manifest.content) || !hasValidContentDigest(manifest)) return null;
    content = manifest.content;
    try {
      verifyDeployedFiles(content, options.runtimeDir, options);
    } catch {
      return null;
    }
    schemaV2 = true;
  } else if (manifest.schemaVersion === 1) {
    content = manifest;
  } else {
    return null;
  }
  const repository = content.repository || {};
  const commitShort = schemaV2
    ? (typeof repository.commit === 'string' ? repository.commit.slice(0, 7) : null)
    : (repository.commitShort || null);

  return {
    commit: commitShort,
    dirty: repository.dirty === true,
    lockSha256: content.lockfile?.sha256 || null,
    contract: content.contract?.fingerprint || null,
    appVersion: content.app?.version || null,
    builtAt: manifest.builtAt || null,
  };
}

function readReleaseIdentity(manifestPath, runtimeDir, dependencies = {}) {
  try {
    const readFile = dependencies.readFile || fs.readFileSync;
    return releaseIdentityFromManifest(
      JSON.parse(readFile(manifestPath, 'utf8')),
      { ...dependencies, runtimeDir },
    );
  } catch {
    return null;
  }
}

module.exports = {
  hasValidContentDigest,
  hashRuntimeFile,
  readReleaseIdentity,
  releaseIdentityFromManifest,
  verifyDeployedFiles,
};
