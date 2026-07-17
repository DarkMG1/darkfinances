'use strict';

const fs = require('fs');
const path = require('path');
const crypto = require('crypto');
const {
  RUNTIME_PREFIX,
  VERIFY_ENTRYPOINT,
  SUPPORTED_NODE_ENGINE,
} = require('./backup-bundle-schema');
const { generationBindingArtifactId } = require('./generation-binding-artifact');

function toolingSourceRelativeFromBundlePath(bundlePath) {
  if (bundlePath === 'tooling/ops/bin/verify-backup-bundle.js') {
    return 'ops/lib/verify-backup-bundle-standalone.js';
  }
  if (bundlePath === 'tooling/ops/bin/restore-dashboard-runtime.js') {
    return 'ops/lib/staged-restore-cli.js';
  }
  if (bundlePath === 'tooling/ops/bin/backup-coordinated.js') {
    return 'ops/lib/coordinated-backup-cli.js';
  }
  if (!bundlePath.startsWith('tooling/')) {
    throw new Error(`expected tooling bundle path: ${bundlePath}`);
  }
  return bundlePath.slice('tooling/'.length);
}

function toolingDigest(bundleRoot, toolingFiles) {
  const hash = crypto.createHash('sha256');
  for (const relative of [...toolingFiles].sort()) {
    hash.update(relative);
    hash.update(fs.readFileSync(path.join(bundleRoot, relative)));
  }
  return hash.digest('hex');
}

function runtimeArtifactId(runtimeEntries) {
  const hash = crypto.createHash('sha256');
  for (const entry of runtimeEntries) {
    hash.update(entry.path);
    hash.update(entry.sha256);
    hash.update(String(entry.bytes));
  }
  return hash.digest('hex');
}

function runtimeEntriesFromManifest(manifest) {
  return manifest.files.filter((entry) => entry.path.startsWith(RUNTIME_PREFIX));
}

function toolingEntriesFromManifest(manifest) {
  return manifest.files.filter((entry) => entry.path.startsWith('tooling/'));
}

function toolingSourcesFromManifest(manifest) {
  return toolingEntriesFromManifest(manifest)
    .map((entry) => toolingSourceRelativeFromBundlePath(entry.path))
    .sort();
}

function assertRequiredRuntimeStores(inventory, manifestPaths) {
  for (const store of inventory.stores) {
    if (store.optionalMissing) continue;
    const runtimePath = `${RUNTIME_PREFIX}${store.filename}`;
    if (!manifestPaths.has(runtimePath)) {
      throw new Error(`required runtime store missing from manifest: ${runtimePath}`);
    }
  }
}

function assertRequiredStoresOnDisk(runtimeRoot, inventory) {
  for (const store of inventory.stores) {
    if (store.optionalMissing) continue;
    const primary = path.join(runtimeRoot, store.filename);
    if (!fs.existsSync(primary)) {
      throw new Error(`required runtime store missing at build time: ${store.filename}`);
    }
  }
}

function assertManifestProvenanceFields(manifest, bundleRoot, inventory) {
  const manifestPaths = new Set(manifest.files.map((entry) => entry.path));
  const runtimeEntries = runtimeEntriesFromManifest(manifest);
  const toolingFiles = toolingEntriesFromManifest(manifest).map((entry) => entry.path);
  const runtimeRoot = path.join(bundleRoot, RUNTIME_PREFIX.slice(0, -1));

  const expectedArtifactId = generationBindingArtifactId({
    runtimeRoot,
    runtimeEntries,
    inventory,
  });
  if (manifest.artifact.id !== expectedArtifactId) {
    throw new Error('manifest.artifact.id mismatch');
  }

  const expectedToolingDigest = toolingDigest(bundleRoot, toolingFiles);
  if (manifest.restoreTooling.toolingDigest !== expectedToolingDigest) {
    throw new Error('manifest.restoreTooling.toolingDigest mismatch');
  }

  if (manifest.restoreTooling.toolingFileCount !== toolingFiles.length) {
    throw new Error('manifest.restoreTooling.toolingFileCount mismatch');
  }

  const expectedSources = toolingSourcesFromManifest(manifest);
  const declaredSources = manifest.restoreTooling.toolingSources;
  if (!Array.isArray(declaredSources)
    || declaredSources.length !== expectedSources.length
    || declaredSources.some((source, index) => source !== expectedSources[index])) {
    throw new Error('manifest.restoreTooling.toolingSources mismatch');
  }

  if (manifest.restoreTooling.nodeEngine !== SUPPORTED_NODE_ENGINE) {
    throw new Error('manifest.restoreTooling.nodeEngine mismatch');
  }

  if (manifest.restoreTooling.verifyEntrypoint !== VERIFY_ENTRYPOINT) {
    throw new Error('manifest.restoreTooling.verifyEntrypoint mismatch');
  }

  for (const toolingPath of toolingFiles) {
    if (!manifestPaths.has(toolingPath)) {
      throw new Error(`tooling manifest entry missing: ${toolingPath}`);
    }
  }

  return manifestPaths;
}

module.exports = {
  toolingDigest,
  runtimeArtifactId,
  runtimeEntriesFromManifest,
  toolingEntriesFromManifest,
  toolingSourcesFromManifest,
  toolingSourceRelativeFromBundlePath,
  assertRequiredRuntimeStores,
  assertRequiredStoresOnDisk,
  assertManifestProvenanceFields,
};
