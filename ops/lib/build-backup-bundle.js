'use strict';

const fs = require('fs');
const path = require('path');
const crypto = require('crypto');
const { spawnSync } = require('child_process');
const {
  BUNDLE_KIND,
  BUNDLE_SCHEMA_VERSION,
  EMBEDDED_MANIFEST,
  RUNTIME_PREFIX,
  VERIFY_ENTRYPOINT,
  SUPPORTED_NODE_ENGINE,
} = require('./backup-bundle-schema');
const {
  buildStateInventory,
  inventoryDigest,
  loadBackupStateInventory,
  allowsLastGoodSidecar,
  isExcludedRuntimeBasename,
  lastGoodRelativePath,
} = require('./backup-bundle-inventory');
const { copyBundleTooling, bundleToolingSourcePaths } = require('./backup-bundle-tooling');
const {
  toolingDigest,
  runtimeArtifactId,
  assertRequiredStoresOnDisk,
} = require('./backup-bundle-manifest');
const { buildGenerationBinding, embedActiveGenerationBindingsForBuild } = require('./restore-generation-binding');
const { generationBindingArtifactId } = require('./generation-binding-artifact');
const { assertSafeRelativePath } = require('./backup-bundle-verify');
const { sha256File } = require('./backup-verify');

const ROOT = path.resolve(__dirname, '..', '..');

function gitCommit() {
  const result = spawnSync('git', ['rev-parse', 'HEAD'], { cwd: ROOT, encoding: 'utf8' });
  return result.status === 0 ? result.stdout.trim() : null;
}

function fileInventoryEntry(relativePath, absolutePath) {
  const stat = fs.lstatSync(absolutePath);
  if (stat.isSymbolicLink()) throw new Error(`refusing to bundle symlink: ${relativePath}`);
  if (!stat.isFile()) throw new Error(`expected regular file: ${relativePath}`);
  return {
    path: relativePath.replace(/\\/g, '/'),
    sha256: sha256File(absolutePath),
    bytes: stat.size,
    mode: stat.mode & 0o777,
  };
}

function collectRuntimeFiles(runtimeRoot, inventory) {
  const entries = [];
  const seen = new Set();

  for (const store of inventory.stores) {
    const primary = path.join(runtimeRoot, store.filename);
    if (fs.existsSync(primary)) {
      const relative = `${RUNTIME_PREFIX}${store.filename}`;
      entries.push(fileInventoryEntry(relative, primary));
      seen.add(relative);
      if (allowsLastGoodSidecar(store)) {
        const lastGood = path.join(runtimeRoot, lastGoodRelativePath(store.filename));
        if (fs.existsSync(lastGood)) {
          const lastGoodRelative = `${RUNTIME_PREFIX}${lastGoodRelativePath(store.filename)}`;
          entries.push(fileInventoryEntry(lastGoodRelative, lastGood));
          seen.add(lastGoodRelative);
        }
      }
    }
  }

  const receiptsDir = path.join(runtimeRoot, inventory.auxiliary.receiptsDirectory);
  if (fs.existsSync(receiptsDir)) {
    const children = fs.readdirSync(receiptsDir).sort();
    for (const child of children) {
      if (isExcludedRuntimeBasename(child)) continue;
      const absolute = path.join(receiptsDir, child);
      const stat = fs.lstatSync(absolute);
      if (stat.isSymbolicLink()) throw new Error(`refusing to bundle receipt symlink: ${child}`);
      if (!stat.isFile()) continue;
      const relative = `${RUNTIME_PREFIX}${inventory.auxiliary.receiptsDirectory}/${child}`;
      entries.push(fileInventoryEntry(relative, absolute));
      seen.add(relative);
    }
  }

  if (entries.length === 0) {
    throw new Error(`no runtime files found in ${runtimeRoot}`);
  }

  return entries.sort((a, b) => a.path.localeCompare(b.path));
}

function removePartialArtifacts(archivePath) {
  for (const suffix of ['', '.manifest.json', '.sha256']) {
    const target = `${archivePath}${suffix}`;
    if (fs.existsSync(target)) fs.rmSync(target, { force: true });
  }
}

function buildManifest({
  archivePath,
  runtimeEntries,
  toolingFiles,
  stagingRoot,
  inventory,
  provenance = {},
}) {
  const archiveName = path.basename(archivePath);
  const generationId = generationBindingArtifactId({
    runtimeRoot: path.join(stagingRoot, RUNTIME_PREFIX.slice(0, -1)),
    runtimeEntries,
    inventory,
  });
  return {
    kind: BUNDLE_KIND,
    schemaVersion: BUNDLE_SCHEMA_VERSION,
    createdAt: new Date().toISOString(),
    artifact: {
      id: generationId,
      bundleName: archiveName,
    },
    provenance: {
      sourceCommit: provenance.sourceCommit ?? gitCommit(),
      releaseManifestDigest: provenance.releaseManifestDigest ?? null,
      runtimeBackupManifestDigest: provenance.runtimeBackupManifestDigest ?? null,
      actualDataGeneration: provenance.actualDataGeneration ?? null,
      dashboardRelative: 'runtime',
    },
    runtimeState: {
      inventorySchemaVersion: inventory.schemaVersion,
      inventoryDigest: inventoryDigest(inventory),
      storeCount: inventory.storeCount,
    },
    generationBinding: buildGenerationBinding({
      kind: BUNDLE_KIND,
      schemaVersion: BUNDLE_SCHEMA_VERSION,
      artifact: { id: generationId },
      provenance: {
        sourceCommit: provenance.sourceCommit ?? gitCommit(),
        releaseManifestDigest: provenance.releaseManifestDigest ?? null,
        actualDataGeneration: provenance.actualDataGeneration ?? null,
      },
      runtimeState: {
        inventoryDigest: inventoryDigest(inventory),
      },
      files: runtimeEntries,
    }, provenance, {
      runtimeRoot: path.join(stagingRoot, RUNTIME_PREFIX.slice(0, -1)),
      inventory,
    }),
    restoreTooling: {
      nodeEngine: SUPPORTED_NODE_ENGINE,
      verifyEntrypoint: VERIFY_ENTRYPOINT,
      toolingDigest: toolingDigest(stagingRoot, toolingFiles),
      toolingFileCount: toolingFiles.length,
      toolingSources: bundleToolingSourcePaths(),
    },
    files: [...runtimeEntries, ...toolingFiles.map((relativePath) => {
      const absolute = path.join(stagingRoot, relativePath);
      return fileInventoryEntry(relativePath, absolute);
    })].sort((a, b) => a.path.localeCompare(b.path)),
    recovery: {
      requiresServiceStop: true,
      confirmEnv: 'CONFIRM=1',
      scope: 'runtime-sidecars-only',
      postRestoreChecks: [
        '/api/v1/ping',
        'browser passkey login',
        'receipts and reimbursements',
      ],
    },
  };
}

function buildBackupBundle({
  dashboardDir,
  archivePath,
  provenance = {},
  embedGenerationBindings = true,
}) {
  if (!dashboardDir || !archivePath) {
    throw new Error('dashboardDir and archivePath are required');
  }

  const inventory = loadBackupStateInventory();
  const stagingRoot = fs.mkdtempSync(path.join(require('os').tmpdir(), 'darkfinances-bundle-build-'));
  const resolvedProvenance = {
    sourceCommit: provenance.sourceCommit ?? gitCommit(),
    releaseManifestDigest: provenance.releaseManifestDigest ?? null,
    runtimeBackupManifestDigest: provenance.runtimeBackupManifestDigest ?? null,
    actualDataGeneration: provenance.actualDataGeneration ?? null,
  };
  try {
    const runtimeRoot = path.join(stagingRoot, RUNTIME_PREFIX.slice(0, -1));
    fs.mkdirSync(runtimeRoot, { recursive: true, mode: 0o700 });

    for (const store of inventory.stores) {
      const primary = path.join(dashboardDir, store.filename);
      if (fs.existsSync(primary)) {
        const destination = path.join(runtimeRoot, store.filename);
        fs.copyFileSync(primary, destination);
        fs.chmodSync(destination, fs.statSync(primary).mode & 0o777);
        if (allowsLastGoodSidecar(store)) {
          const lastGood = path.join(dashboardDir, lastGoodRelativePath(store.filename));
          if (fs.existsSync(lastGood)) {
            const lastGoodDestination = path.join(runtimeRoot, lastGoodRelativePath(store.filename));
            fs.copyFileSync(lastGood, lastGoodDestination);
            fs.chmodSync(lastGoodDestination, fs.statSync(lastGood).mode & 0o777);
          }
        }
      }
    }

    const receiptsDir = path.join(dashboardDir, inventory.auxiliary.receiptsDirectory);
    if (fs.existsSync(receiptsDir)) {
      const destinationReceipts = path.join(runtimeRoot, inventory.auxiliary.receiptsDirectory);
      fs.mkdirSync(destinationReceipts, { recursive: true, mode: 0o700 });
      for (const child of fs.readdirSync(receiptsDir).sort()) {
        if (isExcludedRuntimeBasename(child)) continue;
        const source = path.join(receiptsDir, child);
        if (!fs.lstatSync(source).isFile()) continue;
        fs.copyFileSync(source, path.join(destinationReceipts, child));
        fs.chmodSync(path.join(destinationReceipts, child), fs.statSync(source).mode & 0o777);
      }
    }

    assertRequiredStoresOnDisk(runtimeRoot, inventory);

    if (embedGenerationBindings) {
      embedActiveGenerationBindingsForBuild({
        runtimeRoot,
        inventory,
        provenance: resolvedProvenance,
      });
    }

    const toolingRoot = path.join(stagingRoot, 'tooling');
    fs.mkdirSync(toolingRoot, { recursive: true, mode: 0o700 });
    const copiedTooling = copyBundleTooling({ destinationRoot: stagingRoot });

    const runtimeEntries = collectRuntimeFiles(runtimeRoot, inventory);
    const manifest = buildManifest({
      archivePath,
      runtimeEntries,
      toolingFiles: copiedTooling,
      stagingRoot,
      inventory,
      provenance: resolvedProvenance,
    });

    fs.mkdirSync(path.dirname(archivePath), { recursive: true, mode: 0o700 });
    const manifestPath = path.join(stagingRoot, EMBEDDED_MANIFEST);
    fs.writeFileSync(manifestPath, `${JSON.stringify(manifest, null, 2)}\n`, { mode: 0o600 });

    const tarMembers = [
      EMBEDDED_MANIFEST,
      ...manifest.files.map((entry) => assertSafeRelativePath(entry.path)),
    ];
    const tar = spawnSync('tar', ['-C', stagingRoot, '-czf', archivePath, ...tarMembers], {
      encoding: 'utf8',
    });
    if (tar.status !== 0) throw new Error(tar.stderr || 'tar create failed');
    fs.chmodSync(archivePath, 0o600);

    fs.writeFileSync(`${archivePath}.manifest.json`, `${JSON.stringify(manifest, null, 2)}\n`, { mode: 0o600 });
    const checksum = crypto.createHash('sha256').update(fs.readFileSync(archivePath)).digest('hex');
    fs.writeFileSync(`${archivePath}.sha256`, `${checksum}  ${path.basename(archivePath)}\n`, { mode: 0o600 });

    return manifest;
  } catch (error) {
    removePartialArtifacts(archivePath);
    throw error;
  } finally {
    fs.rmSync(stagingRoot, { recursive: true, force: true });
  }
}

module.exports = {
  buildBackupBundle,
  buildManifest,
  collectRuntimeFiles,
  runtimeArtifactId,
  removePartialArtifacts,
};
