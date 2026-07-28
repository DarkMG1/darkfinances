'use strict';

const fs = require('fs');
const path = require('path');
const crypto = require('crypto');
const { spawnSync } = require('child_process');
const {
  BUNDLE_KIND,
  BUNDLE_SCHEMA_VERSION,
  EMBEDDED_MANIFEST,
  INVENTORY_RELATIVE,
  RUNTIME_PREFIX,
  SENSITIVE_RUNTIME_BASENAMES,
  VERIFY_ENTRYPOINT,
  ARCHIVE_MAX_MEMBER_COUNT,
  ARCHIVE_MAX_DECLARED_BYTES,
  assertSupportedBundleSchemaVersion,
} = require('./backup-bundle-schema');
const {
  inventoryDigest,
  loadBackupStateInventory,
  allowsLastGoodSidecar,
  isExcludedRuntimeBasename,
  lastGoodRelativePath,
} = require('./backup-bundle-inventory');
const {
  assertManifestProvenanceFields,
  assertRequiredRuntimeStores,
} = require('./backup-bundle-manifest');
const {
  validateSidecar,
  validateReceiptReferences,
  sha256File,
} = require('./backup-verify');
const {
  listTarMemberNames,
  listTarVerboseEntries,
  inspectTarArchive,
} = require('./backup-bundle-tar-listing');
const { backupTarEnv } = require('./backup-tar-env');
const { assertArchivePublicationCommitted } = require('./backup-publication-contract');

function sha256Buffer(buffer) {
  return crypto.createHash('sha256').update(buffer).digest('hex');
}

function parseJson(label, text) {
  try {
    return JSON.parse(text);
  } catch (error) {
    throw new Error(`${label} is not valid JSON: ${error.message}`);
  }
}

function normalizeTarMemberForCollision(member) {
  return member.endsWith('/') && member.length > 1 ? member.slice(0, -1) : member;
}

function assertNoTarMemberNormalizationCollisions(rawMembers, label = 'archive member') {
  const normalizedToRaw = new Map();
  for (const raw of rawMembers) {
    const normalized = normalizeTarMemberForCollision(raw);
    const prior = normalizedToRaw.get(normalized);
    if (prior !== undefined && prior !== raw) {
      throw new Error(`archive member normalization collision for ${label}: ${prior} vs ${raw}`);
    }
    if (prior === undefined) normalizedToRaw.set(normalized, raw);
  }
}

function assertSafeRelativePath(relativePath, label = 'path') {
  if (typeof relativePath !== 'string' || !relativePath) {
    throw new Error(`${label} must be a non-empty string`);
  }
  if (/[\x00-\x1f\x7f]/.test(relativePath)) {
    throw new Error(`unsafe ${label}: control characters are forbidden`);
  }
  if (path.isAbsolute(relativePath)) {
    throw new Error(`unsafe ${label}: absolute paths are forbidden`);
  }
  const normalized = path.posix.normalize(relativePath.replace(/\\/g, '/'));
  if (normalized === '..' || normalized.startsWith('../') || normalized.includes('/../')) {
    throw new Error(`unsafe ${label}: ${relativePath}`);
  }
  if (normalized !== relativePath.replace(/\\/g, '/')) {
    throw new Error(`unsafe ${label}: ${relativePath}`);
  }
  return normalized;
}

function assertNoUnicodeNormalizationCollisions(members, label = 'archive member') {
  const seen = new Map();
  for (const member of members) {
    for (const form of ['NFC', 'NFD']) {
      const key = member.normalize(form);
      const prior = seen.get(key);
      if (prior && prior !== member) {
        throw new Error(`unicode normalization collision for ${label}: ${prior} vs ${member}`);
      }
      seen.set(key, member);
    }
  }
}

function redactErrorMessage(message) {
  return String(message)
    .replace(/passkey-credentials\.json[^\n]*/gi, 'passkey-credentials.json [redacted]')
    .replace(/credentialPublicKey[^\n]*/gi, 'credentialPublicKey [redacted]');
}

function safeError(error) {
  return new Error(redactErrorMessage(error.message));
}

function assertPrivateMode(mode, relativePath) {
  const bits = mode & 0o777;
  if (relativePath.endsWith('.json') || relativePath.endsWith('.last-good')) {
    if (bits !== 0o600) throw new Error(`unsafe mode ${bits.toString(8)} for ${relativePath}`);
    return;
  }
  if (relativePath.endsWith('receipts') || /\/receipts\/[^/]+$/.test(relativePath)) {
    if (relativePath.endsWith('receipts')) {
      if (bits !== 0o700) throw new Error(`unsafe mode ${bits.toString(8)} for ${relativePath}`);
    } else if (bits !== 0o600) {
      throw new Error(`unsafe mode ${bits.toString(8)} for ${relativePath}`);
    }
  }
}

function loadValidateBackupSidecar(toolingRoot) {
  const modulePath = path.join(toolingRoot, 'finance-dashboard/lib/runtime-state-store.js');
  if (!fs.existsSync(modulePath)) {
    throw new Error(`bundled runtime-state-store.js is missing: ${modulePath}`);
  }
  // eslint-disable-next-line import/no-dynamic-require, global-require
  const { validateBackupSidecar } = require(modulePath);
  return validateBackupSidecar;
}

function inventoryFromBundle(bundleRoot) {
  const inventoryPath = path.join(bundleRoot, INVENTORY_RELATIVE);
  if (!fs.existsSync(inventoryPath)) {
    throw new Error(`bundle is missing ${INVENTORY_RELATIVE}`);
  }
  return loadBackupStateInventory({ inventoryPath });
}

function assertArchiveChecksum(archivePath) {
  assertArchivePublicationCommitted(archivePath, 'archive');
}

function readManifestFromArchive(archivePath, listing = null) {
  const sidecarPath = `${archivePath}.manifest.json`;
  if (!fs.existsSync(sidecarPath)) {
    throw new Error(`missing sidecar manifest: ${sidecarPath}`);
  }
  const manifest = parseJson('manifest', fs.readFileSync(sidecarPath, 'utf8'));
  if (manifest.kind !== BUNDLE_KIND) throw new Error('manifest kind mismatch');
  assertSupportedBundleSchemaVersion(manifest.schemaVersion);

  assertArchiveChecksum(archivePath);

  const resolvedListing = listing || inspectTarArchive(archivePath);
  const members = resolvedListing.memberNames;
  if (!members.includes(EMBEDDED_MANIFEST)) {
    throw new Error(`archive is missing embedded ${EMBEDDED_MANIFEST}`);
  }

  const embedded = spawnSync('tar', ['-xOf', archivePath, EMBEDDED_MANIFEST], {
    encoding: 'utf8',
    env: backupTarEnv(),
  });
  if (embedded.status !== 0) throw new Error('unable to read embedded manifest');
  const embeddedManifest = parseJson(EMBEDDED_MANIFEST, embedded.stdout);
  if (JSON.stringify(embeddedManifest) !== JSON.stringify(manifest)) {
    throw new Error('embedded manifest does not match sidecar manifest');
  }

  return manifest;
}

function assertManifestStructure(manifest) {
  if (!manifest.artifact || typeof manifest.artifact !== 'object') {
    throw new Error('manifest.artifact must be an object');
  }
  if (!manifest.provenance || typeof manifest.provenance !== 'object') {
    throw new Error('manifest.provenance must be an object');
  }
  if (!manifest.runtimeState || typeof manifest.runtimeState !== 'object') {
    throw new Error('manifest.runtimeState must be an object');
  }
  if (!manifest.restoreTooling || typeof manifest.restoreTooling !== 'object') {
    throw new Error('manifest.restoreTooling must be an object');
  }
  if (!Array.isArray(manifest.files) || manifest.files.length === 0) {
    throw new Error('manifest.files must be a non-empty array');
  }
  if (manifest.restoreTooling.verifyEntrypoint !== VERIFY_ENTRYPOINT) {
    throw new Error('manifest.restoreTooling.verifyEntrypoint mismatch');
  }
}

function validateManifestInventory(manifest, inventory) {
  if (manifest.runtimeState.inventoryDigest !== inventoryDigest(inventory)) {
    throw new Error('manifest.runtimeState.inventoryDigest mismatch');
  }
  if (manifest.runtimeState.storeCount !== inventory.storeCount) {
    throw new Error('manifest.runtimeState.storeCount mismatch');
  }
}

function validateManifestFiles(manifest) {
  const seen = new Set();
  for (const entry of manifest.files) {
    const relativePath = assertSafeRelativePath(entry.path, 'manifest file path');
    if (seen.has(relativePath)) throw new Error(`duplicate manifest path: ${relativePath}`);
    seen.add(relativePath);
    if (typeof entry.sha256 !== 'string' || !/^[a-f0-9]{64}$/.test(entry.sha256)) {
      throw new Error(`invalid sha256 for ${relativePath}`);
    }
    if (!Number.isInteger(entry.bytes) || entry.bytes < 0) {
      throw new Error(`invalid bytes for ${relativePath}`);
    }
    if (!Number.isInteger(entry.mode)) {
      throw new Error(`invalid mode for ${relativePath}`);
    }
    assertPrivateMode(entry.mode, relativePath);
  }
  return seen;
}

function listTarMembers(archivePath) {
  return listTarMemberNames(archivePath);
}

function assertTarMembersSafe(members) {
  const seen = new Set();
  for (const member of members) {
    assertSafeRelativePath(member, 'archive member');
    if (seen.has(member)) throw new Error(`duplicate archive member: ${member}`);
    seen.add(member);
    if (member.includes('..')) throw new Error(`unsafe archive member: ${member}`);
  }
  assertNoUnicodeNormalizationCollisions(members, 'archive member');
  return seen;
}

function assertArchivePreflightBounds(manifest) {
  const memberCount = manifest.files.length + 1;
  if (memberCount > ARCHIVE_MAX_MEMBER_COUNT) {
    throw new Error(`archive member count exceeds bound: ${memberCount}`);
  }
  let declaredBytes = 0;
  for (const entry of manifest.files) {
    declaredBytes += entry.bytes;
    if (declaredBytes > ARCHIVE_MAX_DECLARED_BYTES) {
      throw new Error(`archive declared bytes exceed bound: ${declaredBytes}`);
    }
  }
}

function assertTarEntryTypesSafe(archivePath, listing = null) {
  const resolved = listing || inspectTarArchive(archivePath);
  const memberNames = resolved.memberNames;
  const entries = resolved.verboseEntries;

  if (entries.length !== memberNames.length) {
    throw new Error(
      `tar verbose listing count mismatch: ${entries.length} lines vs ${memberNames.length} members`,
    );
  }

  const verbosePaths = entries.map((entry) => entry.path);
  const sortedMembers = [...memberNames].sort();
  const sortedVerbose = [...verbosePaths].sort();
  if (sortedMembers.join('\0') !== sortedVerbose.join('\0')) {
    throw new Error('tar verbose listing paths do not match nonverbose member names');
  }

  let uncompressedBytes = 0;
  for (const entry of entries) {
    assertSafeRelativePath(entry.path, 'archive member');
    if (entry.type === 'l') throw new Error(`symbolic links are forbidden in archive: ${entry.path}`);
    if (entry.type === 'h') throw new Error(`hard links are forbidden in archive: ${entry.path}`);
    if (entry.type === 'b' || entry.type === 'c') {
      throw new Error(`device nodes are forbidden in archive: ${entry.path}`);
    }
    if (entry.type === 'p') throw new Error(`FIFO entries are forbidden in archive: ${entry.path}`);
    if (entry.type !== '-' && entry.type !== 'd') {
      throw new Error(`unsupported archive entry type ${entry.type} for ${entry.path}`);
    }
    if (entry.type === '-') {
      uncompressedBytes += entry.size;
      if (uncompressedBytes > ARCHIVE_MAX_DECLARED_BYTES) {
        throw new Error(`archive uncompressed bytes exceed bound: ${uncompressedBytes}`);
      }
    }
  }
  if (entries.length > ARCHIVE_MAX_MEMBER_COUNT) {
    throw new Error(`archive member count exceeds bound: ${entries.length}`);
  }
}

function assertManifestMatchesArchive(manifestPaths, archiveMembers) {
  const expected = new Set(manifestPaths);
  const actual = new Set(archiveMembers);
  if (!actual.has(EMBEDDED_MANIFEST)) {
    throw new Error(`archive is missing embedded ${EMBEDDED_MANIFEST}`);
  }
  expected.add(EMBEDDED_MANIFEST);
  for (const member of actual) {
    if (!expected.has(member)) throw new Error(`unexpected archive member: ${member}`);
  }
  for (const member of expected) {
    if (!actual.has(member)) throw new Error(`archive missing ${member}`);
  }
}

function extractArchiveTo(archivePath, destination) {
  fs.mkdirSync(destination, { recursive: true, mode: 0o700 });
  const extract = spawnSync('tar', ['-xzf', archivePath, '-C', destination], {
    encoding: 'utf8',
    env: backupTarEnv(),
  });
  if (extract.status !== 0) throw new Error(extract.stderr || 'tar extract failed');
}

function listBundleTreePaths(bundleRoot) {
  const paths = [];
  function walk(relativeDir) {
    const absoluteDir = relativeDir ? path.join(bundleRoot, relativeDir) : bundleRoot;
    for (const name of fs.readdirSync(absoluteDir).sort()) {
      const relativePath = relativeDir ? `${relativeDir}/${name}` : name;
      const absolutePath = path.join(bundleRoot, relativePath);
      const stat = fs.lstatSync(absolutePath);
      if (stat.isSymbolicLink()) {
        throw new Error(`symbolic links are forbidden: ${relativePath}`);
      }
      if (stat.isDirectory()) {
        walk(relativePath);
      } else if (stat.isFile()) {
        paths.push(relativePath.replace(/\\/g, '/'));
      } else {
        throw new Error(`unsupported bundle tree entry: ${relativePath}`);
      }
    }
  }
  walk('');
  return paths.sort();
}

function assertClosedWorldTree(bundleRoot, manifestPaths) {
  const expected = new Set([...manifestPaths, EMBEDDED_MANIFEST]);
  const actual = listBundleTreePaths(bundleRoot);
  for (const relativePath of actual) {
    if (!expected.has(relativePath)) {
      throw new Error(`unexpected bundle tree file: ${relativePath}`);
    }
  }
  for (const relativePath of expected) {
    if (!actual.includes(relativePath)) {
      throw new Error(`bundle tree missing ${relativePath}`);
    }
  }
}

function publishVerifiedTree(sourceRoot, destinationRoot) {
  fs.mkdirSync(destinationRoot, { recursive: true, mode: 0o700 });
  for (const entry of fs.readdirSync(destinationRoot)) {
    fs.rmSync(path.join(destinationRoot, entry), { recursive: true, force: true });
  }
  for (const relativePath of listBundleTreePaths(sourceRoot)) {
    const source = path.join(sourceRoot, relativePath);
    const destination = path.join(destinationRoot, relativePath);
    fs.mkdirSync(path.dirname(destination), { recursive: true, mode: 0o700 });
    fs.copyFileSync(source, destination);
    fs.chmodSync(destination, fs.statSync(source).mode & 0o777);
  }
}

function verifyExtractedTree({
  bundleRoot,
  manifest,
  inventory,
  toolingRoot = path.join(bundleRoot, 'tooling'),
  readOnly = true,
  trustedPreExtracted = false,
}) {
  assertManifestStructure(manifest);
  validateManifestInventory(manifest, inventory);

  const manifestPaths = validateManifestFiles(manifest);
  assertRequiredRuntimeStores(inventory, manifestPaths);
  assertClosedWorldTree(bundleRoot, manifestPaths);

  const validateBackupSidecar = loadValidateBackupSidecar(toolingRoot);
  const runtimeRoot = path.join(bundleRoot, RUNTIME_PREFIX.slice(0, -1));

  for (const entry of manifest.files) {
    const relativePath = assertSafeRelativePath(entry.path, 'manifest file path');
    const target = path.join(bundleRoot, relativePath);
    if (!fs.existsSync(target)) throw new Error(`bundle missing ${relativePath}`);
    const stat = fs.lstatSync(target);
    if (stat.isSymbolicLink()) throw new Error(`symbolic links are forbidden: ${relativePath}`);
    if (!stat.isFile()) throw new Error(`expected file for ${relativePath}`);
    if (stat.size !== entry.bytes) throw new Error(`size mismatch for ${relativePath}`);
    if ((stat.mode & 0o777) !== (entry.mode & 0o777)) {
      throw new Error(`mode mismatch for ${relativePath}`);
    }
    const digest = sha256File(target);
    if (digest !== entry.sha256) throw new Error(`checksum mismatch for ${relativePath}`);

    const basename = path.basename(relativePath);
    if (isExcludedRuntimeBasename(basename)) {
      throw new Error(`forbidden runtime basename in bundle: ${basename}`);
    }

    if (relativePath.startsWith(RUNTIME_PREFIX) && basename.endsWith('.json')) {
      const text = fs.readFileSync(target, 'utf8');
      try {
        if (SENSITIVE_RUNTIME_BASENAMES.includes(basename)) {
          validateBackupSidecar(basename, parseJson(basename, text));
        } else {
          validateBackupSidecar(basename, parseJson(basename, text));
        }
      } catch (error) {
        throw safeError(error);
      }
      try {
        validateSidecar(basename, text);
      } catch (error) {
        throw safeError(error);
      }
    }
  }

  const receiptsPath = path.join(runtimeRoot, 'receipts.json');
  if (fs.existsSync(receiptsPath)) {
    const receipts = parseJson('receipts.json', fs.readFileSync(receiptsPath, 'utf8'));
    try {
      validateReceiptReferences(receipts, runtimeRoot);
    } catch (error) {
      throw safeError(error);
    }
  }

  for (const store of inventory.stores) {
    if (!allowsLastGoodSidecar(store)) continue;
    const lastGoodRelative = path.posix.join(RUNTIME_PREFIX.slice(0, -1), lastGoodRelativePath(store.filename));
    if (manifestPaths.has(lastGoodRelative)) {
      const lastGoodFile = path.join(bundleRoot, lastGoodRelative);
      const text = fs.readFileSync(lastGoodFile, 'utf8');
      try {
        validateBackupSidecar(store.filename, parseJson(store.filename, text));
      } catch (error) {
        throw safeError(error);
      }
    }
  }

  assertManifestProvenanceFields(manifest, bundleRoot, inventory);

  if (readOnly && !trustedPreExtracted) {
    // Archive verification always extracts to a private temp directory first.
  }

  return manifest;
}

function verifyBackupBundleArchive({
  archivePath,
  bundleRoot = null,
  publishDir = process.env.DARKFINANCES_BUNDLE_EXTRACT_DIR || null,
  readOnly = true,
}) {
  if (!archivePath || !fs.existsSync(archivePath)) {
    throw new Error(`archive not found: ${archivePath}`);
  }

  const listing = inspectTarArchive(archivePath);
  const manifest = readManifestFromArchive(archivePath, listing);
  assertManifestStructure(manifest);
  assertArchivePreflightBounds(manifest);

  assertNoTarMemberNormalizationCollisions(listing.memberNames);
  const members = assertTarMembersSafe(listing.memberNames);
  assertTarEntryTypesSafe(archivePath, listing);

  const manifestPaths = new Set(manifest.files.map((entry) => assertSafeRelativePath(entry.path)));
  assertManifestMatchesArchive(manifestPaths, members);

  let extractedRoot = bundleRoot;
  let tempDir = null;
  if (!extractedRoot) {
    tempDir = fs.mkdtempSync(path.join(require('os').tmpdir(), 'darkfinances-bundle-verify-'));
    extractedRoot = tempDir;
    extractArchiveTo(archivePath, extractedRoot);
  }

  try {
    const inventory = inventoryFromBundle(extractedRoot);
    const verified = verifyExtractedTree({
      bundleRoot: extractedRoot,
      manifest,
      inventory,
      readOnly,
    });

    if (publishDir) {
      publishVerifiedTree(extractedRoot, publishDir);
    }

    return verified;
  } finally {
    if (tempDir) fs.rmSync(tempDir, { recursive: true, force: true });
  }
}

function stageRuntimeFromBundle({
  bundleRoot,
  stagingDir,
  manifest = null,
}) {
  const resolvedManifest = manifest || parseJson(
    EMBEDDED_MANIFEST,
    fs.readFileSync(path.join(bundleRoot, EMBEDDED_MANIFEST), 'utf8'),
  );
  fs.mkdirSync(stagingDir, { recursive: true, mode: 0o700 });
  for (const entry of resolvedManifest.files) {
    if (!entry.path.startsWith(RUNTIME_PREFIX)) continue;
    const relative = entry.path.slice(RUNTIME_PREFIX.length);
    assertSafeRelativePath(relative, 'runtime staging path');
    const source = path.join(bundleRoot, entry.path);
    const destination = path.join(stagingDir, relative);
    fs.mkdirSync(path.dirname(destination), { recursive: true, mode: 0o700 });
    fs.copyFileSync(source, destination);
    fs.chmodSync(destination, entry.mode & 0o777);
  }
  return stagingDir;
}

module.exports = {
  assertSafeRelativePath,
  assertNoUnicodeNormalizationCollisions,
  assertNoTarMemberNormalizationCollisions,
  normalizeTarMemberForCollision,
  assertTarMembersSafe,
  listTarMembers,
  redactErrorMessage,
  verifyBackupBundleArchive,
  verifyExtractedTree,
  stageRuntimeFromBundle,
  readManifestFromArchive,
  assertArchiveChecksum,
  inventoryFromBundle,
  assertArchivePreflightBounds,
  assertTarEntryTypesSafe,
  assertClosedWorldTree,
  publishVerifiedTree,
};
