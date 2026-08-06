const fs = require('fs');
const path = require('path');
const crypto = require('crypto');
const { spawnSync } = require('child_process');
const { validateBackupSidecar } = require('../../finance-dashboard/lib/runtime-state-store');

const { sidecarFilenames } = require('./backup-bundle-inventory');
const {
  ARCHIVE_MAX_DECLARED_BYTES,
  ARCHIVE_MAX_MEMBER_COUNT,
} = require('./backup-bundle-schema');
const { inspectTarArchive } = require('./backup-bundle-tar-listing');
const { backupTarEnv } = require('./backup-tar-env');

function backupArchiveGuards() {
  return require('./backup-bundle-verify');
}

const ROOT = path.resolve(__dirname, '..', '..');
const STATE_SCHEMA_VERSION = 1;
const SIDECAR_FILES = sidecarFilenames();
const LEGACY_EMBEDDED_MANIFEST = '.backup-manifest.json';
const LEGACY_SIDECAR_ONLY_FIELDS = Object.freeze([]);
const FILE_HASH_CHUNK_BYTES = 1024 * 1024;

function sha256Buffer(buffer) {
  return crypto.createHash('sha256').update(buffer).digest('hex');
}

function hashOpenFlags(constants = fs.constants) {
  if (!constants.O_NOFOLLOW) {
    throw new Error('descriptor hashing requires O_NOFOLLOW support on this platform');
  }
  return constants.O_RDONLY | constants.O_NOFOLLOW | (constants.O_NONBLOCK || 0);
}

function assertHashableRegularFile(stat, resolved) {
  if (stat.isSymbolicLink()) {
    throw new Error(`refusing to hash symbolic link: ${resolved}`);
  }
  if (!stat.isFile()) {
    throw new Error(`hash target must be a regular file: ${resolved}`);
  }
  if (!Number.isSafeInteger(stat.size) || stat.size < 0) {
    throw new Error(`hash target size is out of bounds: ${resolved}`);
  }
}

function sameStatField(left, right, field) {
  return left[field] === right[field];
}

function assertHashIdentityStable(left, right, message) {
  for (const field of ['dev', 'ino', 'size']) {
    if (!sameStatField(left, right, field)) throw new Error(message);
  }
}

function assertHashMetadataStable(left, right, message) {
  for (const field of ['mode', 'nlink', 'uid', 'gid', 'mtimeMs', 'ctimeMs']) {
    if (!sameStatField(left, right, field)) throw new Error(message);
  }
}

function closeHashDescriptor(closeSync, descriptor) {
  if (descriptor === undefined) return;
  try {
    closeSync(descriptor);
  } catch {
    // Preserve the primary trust failure.
  }
}

function updateHashFromFile(file, hash, dependencies = {}) {
  if (!hash || typeof hash.update !== 'function') {
    throw new Error('descriptor hashing requires a hash with update()');
  }
  const lstatSync = dependencies.lstatSync || fs.lstatSync;
  const openSync = dependencies.openSync || fs.openSync;
  const fstatSync = dependencies.fstatSync || fs.fstatSync;
  const readSync = dependencies.readSync || fs.readSync;
  const closeSync = dependencies.closeSync || fs.closeSync;
  const constants = dependencies.constants || fs.constants;
  const resolved = path.resolve(file);

  let descriptor;
  try {
    try {
      descriptor = openSync(resolved, hashOpenFlags(constants));
    } catch (error) {
      if (error.code === 'ELOOP') {
        throw new Error(`refusing to follow symbolic link while hashing: ${resolved}`);
      }
      if (error.code === 'ENOENT') throw new Error(`hash target not found: ${resolved}`);
      throw error;
    }
    const opened = fstatSync(descriptor);
    assertHashableRegularFile(opened, resolved);

    const buffer = Buffer.allocUnsafe(FILE_HASH_CHUNK_BYTES);
    let position = 0;
    while (position < opened.size) {
      const requested = Math.min(buffer.length, opened.size - position);
      const bytesRead = readSync(descriptor, buffer, 0, requested, position);
      if (!Number.isInteger(bytesRead) || bytesRead <= 0 || bytesRead > requested) {
        throw new Error(`hash target size changed while it was being read: ${resolved}`);
      }
      hash.update(buffer.subarray(0, bytesRead));
      position += bytesRead;
    }

    const afterDescriptor = fstatSync(descriptor);
    assertHashableRegularFile(afterDescriptor, resolved);
    assertHashIdentityStable(opened, afterDescriptor, `hash target size changed while it was being read: ${resolved}`);
    assertHashMetadataStable(opened, afterDescriptor, `hash target metadata changed while it was being read: ${resolved}`);

    let afterPath;
    try {
      afterPath = lstatSync(resolved);
    } catch (error) {
      if (error.code === 'ENOENT') {
        throw new Error(`hash target path changed while it was being read: ${resolved}`);
      }
      throw error;
    }
    assertHashableRegularFile(afterPath, resolved);
    assertHashIdentityStable(afterDescriptor, afterPath, `hash target path changed while it was being read: ${resolved}`);
    assertHashMetadataStable(afterDescriptor, afterPath, `hash target path metadata changed while it was being read: ${resolved}`);

    closeHashDescriptor(closeSync, descriptor);
    descriptor = undefined;
    return { resolved, stat: afterDescriptor };
  } catch (error) {
    closeHashDescriptor(closeSync, descriptor);
    descriptor = undefined;
    throw error;
  }
}

function hashFileIncrementally(file, dependencies = {}) {
  const createHash = dependencies.createHash || crypto.createHash;
  const hash = createHash('sha256');
  const { resolved, stat } = updateHashFromFile(file, hash, dependencies);
  return {
    resolved,
    stat,
    sha256: hash.digest('hex'),
  };
}

function sha256File(file, dependencies = {}) {
  return hashFileIncrementally(file, dependencies).sha256;
}

function gitCommit() {
  const result = spawnSync('git', ['rev-parse', 'HEAD'], { cwd: ROOT, encoding: 'utf8' });
  return result.status === 0 ? result.stdout.trim() : null;
}

function parseJson(label, text) {
  try {
    return JSON.parse(text);
  } catch (error) {
    throw new Error(`${label} is not valid JSON: ${error.message}`);
  }
}

function assertArray(label, value) {
  if (!Array.isArray(value)) throw new Error(`${label} must be an array`);
}

function assertObject(label, value) {
  if (!value || typeof value !== 'object' || Array.isArray(value)) {
    throw new Error(`${label} must be an object`);
  }
}

function receiptRecords(receipts) {
  if (Array.isArray(receipts)) {
    for (const receipt of receipts) assertObject('receipts.json entry', receipt);
    return { format: 'legacy', records: receipts };
  }

  assertObject('receipts.json', receipts);
  assertObject('receipts.json byTxn', receipts.byTxn);
  const records = [];
  for (const [txnId, bucket] of Object.entries(receipts.byTxn)) {
    assertArray(`receipts.json byTxn.${txnId}`, bucket);
    for (const receipt of bucket) {
      assertObject(`receipts.json byTxn.${txnId} entry`, receipt);
      records.push(receipt);
    }
  }
  return { format: 'byTxn', records };
}

function validateSidecar(name, text) {
  const data = parseJson(name, text);
  return validateBackupSidecar(name, data);
}

function assertArchivedFile(root, relativePath, label) {
  if (typeof relativePath !== 'string' || !relativePath) {
    throw new Error(`${label} must be a non-empty string`);
  }
  const resolvedRoot = path.resolve(root);
  const resolved = path.resolve(resolvedRoot, relativePath);
  const relative = path.relative(resolvedRoot, resolved);
  if (!relative || relative === '..' || relative.startsWith(`..${path.sep}`) || path.isAbsolute(relative)) {
    throw new Error(`unsafe receipt path: ${relativePath}`);
  }
  if (!fs.existsSync(resolved) || !fs.lstatSync(resolved).isFile()) {
    throw new Error(`missing receipt file: ${relativePath}`);
  }
}

function validateReceiptReferences(receipts, dashboardDir) {
  const { format, records } = receiptRecords(receipts);
  for (const receipt of records) {
    if (format === 'legacy' && receipt.path != null) {
      assertArchivedFile(dashboardDir, receipt.path, 'receipt path');
    }
    if (format === 'byTxn' && receipt.file != null) {
      if (typeof receipt.file !== 'string' || path.basename(receipt.file) !== receipt.file) {
        throw new Error(`unsafe receipt path: ${receipt.file}`);
      }
      assertArchivedFile(path.join(dashboardDir, 'receipts'), receipt.file, 'receipt file');
    }
  }
}

function buildManifest({ dashboardDir, archivePath, files }) {
  const entries = files.map((name) => {
    const full = path.join(dashboardDir, name);
    const stat = fs.statSync(full);
    const entry = {
      path: name,
      sha256: stat.isDirectory() ? null : sha256File(full),
      bytes: stat.isDirectory() ? null : stat.size,
      mode: stat.mode & 0o777,
    };
    if (stat.isDirectory()) {
      entry.files = fs.readdirSync(full).sort().map((child) => {
        const childPath = path.join(full, child);
        const childStat = fs.statSync(childPath);
        return {
          path: `${name}/${child}`,
          sha256: sha256File(childPath),
          bytes: childStat.size,
          mode: childStat.mode & 0o777,
        };
      });
    }
    return entry;
  });

  return {
    kind: 'darkfinances-dashboard-runtime-backup',
    schemaVersion: STATE_SCHEMA_VERSION,
    createdAt: new Date().toISOString(),
    repositoryCommit: gitCommit(),
    archive: path.basename(archivePath),
    files: entries,
    sidecars: SIDECAR_FILES.filter((name) => files.includes(name)),
    recovery: {
      requiresServiceStop: true,
      confirmEnv: 'CONFIRM=1',
      postRestoreChecks: [
        '/api/v1/ping',
        'browser passkey login',
        'receipts and reimbursements',
      ],
    },
  };
}

function canonicalLegacyManifest(manifest) {
  const copy = JSON.parse(JSON.stringify(manifest));
  for (const field of LEGACY_SIDECAR_ONLY_FIELDS) {
    delete copy[field];
  }
  return copy;
}

function normalizeLegacyTarMember(member) {
  if (typeof member !== 'string' || !member) {
    throw new Error('archive member must be a non-empty string');
  }
  return member.endsWith('/') && member.length > 1 ? member.slice(0, -1) : member;
}

function legacyExpectedMembers(manifest) {
  const { assertSafeRelativePath } = backupArchiveGuards();
  const expected = new Set([LEGACY_EMBEDDED_MANIFEST]);
  for (const entry of manifest.files) {
    const relativePath = assertSafeRelativePath(entry.path, 'manifest file path');
    expected.add(relativePath);
    if (entry.files) {
      for (const child of entry.files) {
        expected.add(assertSafeRelativePath(child.path, 'manifest file path'));
      }
    }
  }
  return expected;
}

function assertLegacyArchivePreflightBounds(manifest) {
  let declaredBytes = 0;
  for (const entry of manifest.files) {
    if (Number.isInteger(entry.bytes) && entry.bytes >= 0) {
      declaredBytes += entry.bytes;
      if (declaredBytes > ARCHIVE_MAX_DECLARED_BYTES) {
        throw new Error(`archive declared bytes exceed bound: ${declaredBytes}`);
      }
    }
    if (entry.files) {
      for (const child of entry.files) {
        if (Number.isInteger(child.bytes) && child.bytes >= 0) {
          declaredBytes += child.bytes;
          if (declaredBytes > ARCHIVE_MAX_DECLARED_BYTES) {
            throw new Error(`archive declared bytes exceed bound: ${declaredBytes}`);
          }
        }
      }
    }
  }
}

function assertLegacyManifestMatchesArchive(manifest, rawArchiveMembers) {
  const { assertNoTarMemberNormalizationCollisions } = backupArchiveGuards();
  assertNoTarMemberNormalizationCollisions(rawArchiveMembers, 'legacy archive member');
  const expected = legacyExpectedMembers(manifest);
  const actual = new Set(rawArchiveMembers.map((member) => normalizeLegacyTarMember(member)));
  const expectedNormalized = new Set([...expected].map((member) => normalizeLegacyTarMember(member)));
  if (!actual.has(LEGACY_EMBEDDED_MANIFEST)) {
    throw new Error(`archive is missing embedded ${LEGACY_EMBEDDED_MANIFEST}`);
  }
  for (const member of actual) {
    if (!expectedNormalized.has(member)) {
      throw new Error(`unexpected archive member: ${member}`);
    }
  }
  for (const member of expectedNormalized) {
    if (!actual.has(member)) {
      throw new Error(`archive missing ${member}`);
    }
  }
}

function assertLegacyArchivePreflight(archivePath, manifest) {
  const {
    assertTarMembersSafe,
    assertTarEntryTypesSafe,
    assertNoTarMemberNormalizationCollisions,
  } = backupArchiveGuards();
  assertLegacyArchivePreflightBounds(manifest);
  const listing = inspectTarArchive(archivePath);
  assertNoTarMemberNormalizationCollisions(listing.memberNames, 'legacy archive member');
  const members = assertTarMembersSafe(listing.memberNames);
  assertTarEntryTypesSafe(archivePath, listing);
  if (members.size > ARCHIVE_MAX_MEMBER_COUNT) {
    throw new Error(`archive member count exceeds bound: ${members.size}`);
  }
  assertLegacyManifestMatchesArchive(manifest, listing.memberNames);
  return listing;
}

function readLegacyEmbeddedManifest(archivePath, manifest) {
  const embedded = spawnSync('tar', ['-xOf', archivePath, LEGACY_EMBEDDED_MANIFEST], {
    encoding: 'utf8',
    env: backupTarEnv(),
  });
  if (embedded.status !== 0) throw new Error('unable to read embedded manifest');
  const embeddedManifest = parseJson(LEGACY_EMBEDDED_MANIFEST, embedded.stdout);
  const canonicalSidecar = canonicalLegacyManifest(manifest);
  const canonicalEmbedded = canonicalLegacyManifest(embeddedManifest);
  if (JSON.stringify(canonicalEmbedded) !== JSON.stringify(canonicalSidecar)) {
    throw new Error('embedded manifest does not match sidecar manifest');
  }
  return embeddedManifest;
}

function verifyArchive({ archivePath, dashboardDir = null, requireCommit = false }) {
  if (!archivePath || !fs.existsSync(archivePath)) {
    throw new Error(`archive not found: ${archivePath}`);
  }

  const manifestPath = `${archivePath}.manifest.json`;
  if (!fs.existsSync(manifestPath)) {
    throw new Error(`missing sidecar manifest: ${manifestPath}`);
  }

  const manifest = parseJson('manifest', fs.readFileSync(manifestPath, 'utf8'));
  if (manifest.kind !== 'darkfinances-dashboard-runtime-backup') {
    throw new Error('manifest kind mismatch');
  }
  if (manifest.schemaVersion !== STATE_SCHEMA_VERSION) {
    throw new Error(`unsupported manifest schemaVersion ${manifest.schemaVersion}`);
  }
  if (requireCommit && !manifest.repositoryCommit) {
    throw new Error('manifest is missing repositoryCommit');
  }

  const checksumPath = `${archivePath}.sha256`;
  if (fs.existsSync(checksumPath)) {
    const expected = fs.readFileSync(checksumPath, 'utf8').trim().split(/\s+/)[0];
    const actual = sha256File(archivePath);
    if (expected !== actual) throw new Error('archive checksum mismatch');
  }

  assertLegacyArchivePreflight(archivePath, manifest);
  readLegacyEmbeddedManifest(archivePath, manifest);

  const tempDir = fs.mkdtempSync(path.join(require('os').tmpdir(), 'darkfinances-verify-'));
  try {
    const extract = spawnSync('tar', ['-xzf', archivePath, '-C', tempDir], {
      encoding: 'utf8',
      env: backupTarEnv(),
    });
    if (extract.status !== 0) throw new Error(extract.stderr || 'tar extract failed');

    for (const entry of manifest.files) {
      const target = path.join(tempDir, entry.path);
      if (!fs.existsSync(target)) throw new Error(`archive missing ${entry.path}`);
      if (entry.sha256) {
        const actual = sha256File(target);
        if (actual !== entry.sha256) throw new Error(`checksum mismatch for ${entry.path}`);
      }
      if (entry.files) {
        for (const child of entry.files) {
          const childTarget = path.join(tempDir, child.path);
          if (!fs.existsSync(childTarget)) throw new Error(`archive missing ${child.path}`);
          if (sha256File(childTarget) !== child.sha256) {
            throw new Error(`checksum mismatch for ${child.path}`);
          }
        }
      }
      if (entry.path.endsWith('.json')) {
        validateSidecar(entry.path, fs.readFileSync(target, 'utf8'));
      }
    }

    const receiptsPath = path.join(tempDir, 'receipts.json');
    if (fs.existsSync(receiptsPath)) {
      const receipts = validateSidecar('receipts.json', fs.readFileSync(receiptsPath, 'utf8'));
      validateReceiptReferences(receipts, tempDir);
    }

    if (dashboardDir) {
      for (const entry of manifest.files) {
        if (!entry.path.endsWith('.json')) continue;
        const live = path.join(dashboardDir, entry.path);
        if (!fs.existsSync(live)) continue;
        validateSidecar(entry.path, fs.readFileSync(live, 'utf8'));
      }
    }
  } finally {
    fs.rmSync(tempDir, { recursive: true, force: true });
  }

  return manifest;
}

module.exports = {
  SIDECAR_FILES,
  STATE_SCHEMA_VERSION,
  LEGACY_EMBEDDED_MANIFEST,
  LEGACY_SIDECAR_ONLY_FIELDS,
  FILE_HASH_CHUNK_BYTES,
  buildManifest,
  validateSidecar,
  validateReceiptReferences,
  verifyArchive,
  hashFileIncrementally,
  hashOpenFlags,
  sha256File,
  updateHashFromFile,
  assertLegacyArchivePreflight,
  assertLegacyManifestMatchesArchive,
  legacyExpectedMembers,
  normalizeLegacyTarMember,
  canonicalLegacyManifest,
};
