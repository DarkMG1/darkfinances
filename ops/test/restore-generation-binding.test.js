'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const os = require('os');
const path = require('path');
const { readDestinationGenerationEvidence } = require('../lib/restore-generation-binding');
const { signaturePathFor } = require('../../finance-dashboard/lib/release-signing');
const {
  createEphemeralSigningMaterial,
  writeSignedReleaseEvidence,
} = require('./helpers/release-signing-fixtures');

const temporaryDirectories = [];

test.after(() => {
  for (const directory of temporaryDirectories) {
    fs.rmSync(directory, { recursive: true, force: true });
  }
});

function tempDir(prefix) {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), prefix));
  temporaryDirectories.push(directory);
  return directory;
}

test('readDestinationGenerationEvidence verifies signed production backup manifests', () => {
  const root = tempDir('restore-generation-evidence-');
  const signing = createEphemeralSigningMaterial(root);
  const bundleManifestPath = path.join(root, 'bundle.manifest.json');
  const bundleArchivePath = path.join(root, 'bundle.tgz');
  const releaseManifestPath = path.join(root, 'release.json');
  fs.writeFileSync(bundleManifestPath, '{"artifact":{"id":"abc"}}\n');
  fs.writeFileSync(bundleArchivePath, 'bundle\n');
  const manifest = writeSignedReleaseEvidence(
    releaseManifestPath,
    bundleManifestPath,
    bundleArchivePath,
    signing,
  );
  const evidence = readDestinationGenerationEvidence({
    releaseManifestPath,
    env: signing.signingEnv,
  });
  assert.equal(evidence.releaseManifestDigest, manifest.contentDigest.value);
});

test('readDestinationGenerationEvidence fails without keyring for production backup manifests', () => {
  const root = tempDir('restore-generation-no-keyring-');
  const signing = createEphemeralSigningMaterial(root);
  const bundleManifestPath = path.join(root, 'bundle.manifest.json');
  const bundleArchivePath = path.join(root, 'bundle.tgz');
  const releaseManifestPath = path.join(root, 'release.json');
  fs.writeFileSync(bundleManifestPath, '{"artifact":{"id":"abc"}}\n');
  fs.writeFileSync(bundleArchivePath, 'bundle\n');
  writeSignedReleaseEvidence(releaseManifestPath, bundleManifestPath, bundleArchivePath, signing);
  const env = { ...process.env };
  delete env.RELEASE_KEYRING_PATH;
  assert.throws(
    () => readDestinationGenerationEvidence({ releaseManifestPath, env }),
    /RELEASE_KEYRING_PATH|keyring-path/,
  );
});

test('readDestinationGenerationEvidence fails for unsigned production backup manifests', () => {
  const root = tempDir('restore-generation-unsigned-');
  const signing = createEphemeralSigningMaterial(root);
  const bundleManifestPath = path.join(root, 'bundle.manifest.json');
  const bundleArchivePath = path.join(root, 'bundle.tgz');
  const releaseManifestPath = path.join(root, 'release.json');
  fs.writeFileSync(bundleManifestPath, '{"artifact":{"id":"abc"}}\n');
  fs.writeFileSync(bundleArchivePath, 'bundle\n');
  writeSignedReleaseEvidence(releaseManifestPath, bundleManifestPath, bundleArchivePath, signing);
  fs.rmSync(signaturePathFor(releaseManifestPath), { force: true });
  assert.throws(
    () => readDestinationGenerationEvidence({
      releaseManifestPath,
      env: signing.signingEnv,
    }),
    /release signature is missing/,
  );
});

test('readDestinationGenerationEvidence fails when rewritten manifest lacks sibling signature', () => {
  const root = tempDir('restore-generation-missing-signature-');
  const signing = createEphemeralSigningMaterial(root);
  const bundleManifestPath = path.join(root, 'bundle.manifest.json');
  const bundleArchivePath = path.join(root, 'bundle.tgz');
  const releaseManifestPath = path.join(root, 'release.json');
  fs.writeFileSync(bundleManifestPath, '{"artifact":{"id":"abc"}}\n');
  fs.writeFileSync(bundleArchivePath, 'bundle\n');
  const manifest = writeSignedReleaseEvidence(
    releaseManifestPath,
    bundleManifestPath,
    bundleArchivePath,
    signing,
  );
  fs.writeFileSync(releaseManifestPath, `${JSON.stringify(manifest, null, 2)}\n`, { mode: 0o600 });
  fs.rmSync(signaturePathFor(releaseManifestPath), { force: true });
  assert.throws(
    () => readDestinationGenerationEvidence({
      releaseManifestPath,
      env: signing.signingEnv,
    }),
    /release signature is missing/,
  );
});

test('readDestinationGenerationEvidence rejects symlink and oversized release manifests', {
  skip: process.platform === 'win32' ? 'POSIX symlink semantics' : false,
}, () => {
  const root = tempDir('restore-generation-trusted-read-');
  const signing = createEphemeralSigningMaterial(root);
  const bundleManifestPath = path.join(root, 'bundle.manifest.json');
  const bundleArchivePath = path.join(root, 'bundle.tgz');
  const releaseManifestPath = path.join(root, 'release.json');
  fs.writeFileSync(bundleManifestPath, '{"artifact":{"id":"abc"}}\n');
  fs.writeFileSync(bundleArchivePath, 'bundle\n');
  writeSignedReleaseEvidence(releaseManifestPath, bundleManifestPath, bundleArchivePath, signing);

  const symlinkPath = path.join(root, 'linked-release.json');
  fs.symlinkSync(releaseManifestPath, symlinkPath);
  assert.throws(
    () => readDestinationGenerationEvidence({
      releaseManifestPath: symlinkPath,
      env: signing.signingEnv,
    }),
    /symbolic link/,
  );

  fs.writeFileSync(releaseManifestPath, Buffer.alloc(4 * 1024 * 1024 + 1, 0x7b), { mode: 0o600 });
  assert.throws(
    () => readDestinationGenerationEvidence({
      releaseManifestPath,
      env: signing.signingEnv,
    }),
    /size is out of bounds/,
  );
});

test('readDestinationGenerationEvidence rejects oversized actual generation evidence', () => {
  const root = tempDir('restore-generation-actual-oversize-');
  const actualGenerationPath = path.join(root, 'actual-generation.txt');
  fs.writeFileSync(actualGenerationPath, `${'a'.repeat(300)}\n`, { mode: 0o600 });
  assert.throws(
    () => readDestinationGenerationEvidence({ actualDataGenerationPath: actualGenerationPath }),
    /size is out of bounds/,
  );
});
