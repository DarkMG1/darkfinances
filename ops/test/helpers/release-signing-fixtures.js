'use strict';

const crypto = require('crypto');
const fs = require('fs');
const path = require('path');
const {
  buildSignatureEnvelope,
  generateSigningMaterial,
  writeKeyMaterialAtomic,
  writeManifestAndSignatureAtomic,
} = require('../../../finance-dashboard/lib/release-signing');
const { verifyManifest } = require('../../../scripts/release-manifest');
const { sha256File } = require('../../lib/backup-verify');
const { sha256Canonical } = require('../../../scripts/release-manifest');

function createEphemeralSigningMaterial(root, options = {}) {
  const keysDir = path.join(root, `.release-signing-keys-${crypto.randomUUID()}`);
  const material = generateSigningMaterial({
    notBefore: options.notBefore || '2020-01-01T00:00:00.000Z',
    notAfter: options.notAfter || '2099-01-01T00:00:00.000Z',
  });
  const paths = writeKeyMaterialAtomic(keysDir, material);
  return {
    ...paths,
    material,
    signingEnv: {
      RELEASE_SIGNING_KEY_PATH: paths.signingPath,
      RELEASE_KEYRING_PATH: paths.keyringPath,
    },
  };
}

function signManifestFile(manifestPath, signingKeyPath, options = {}) {
  const manifest = JSON.parse(fs.readFileSync(manifestPath, 'utf8'));
  const { loadSigningKey } = require('../../../finance-dashboard/lib/release-signing');
  const signingKey = loadSigningKey(signingKeyPath);
  const envelope = buildSignatureEnvelope(manifest, {
    keyId: signingKey.keyId,
    privateKey: signingKey.privateKey,
    signedAt: options.signedAt,
    clock: options.clock,
  });
  writeManifestAndSignatureAtomic(manifestPath, manifest, envelope, options);
  return manifestPath;
}

function writeSignedManifest(destination, manifest, signingKeyPath, keyringPath, options = {}) {
  fs.mkdirSync(path.dirname(destination), { recursive: true });
  fs.writeFileSync(destination, `${JSON.stringify(manifest, null, 2)}\n`, { mode: 0o600 });
  const { loadSigningKey, buildSignatureEnvelope, writeManifestAndSignatureAtomic } = require('../../../finance-dashboard/lib/release-signing');
  const signingKey = loadSigningKey(signingKeyPath);
  const envelope = buildSignatureEnvelope(manifest, {
    keyId: signingKey.keyId,
    privateKey: signingKey.privateKey,
    signedAt: options.signedAt,
    clock: options.clock,
  });
  writeManifestAndSignatureAtomic(destination, manifest, envelope, options);
  if (keyringPath) {
    verifyManifest(manifest, {
      manifestPath: destination,
      keyringPath,
      now: options.now,
    });
  }
  return destination;
}

function buildMinimalBackupManifestContent(bundleManifestPath, bundleArchivePath) {
  return {
    mode: 'backup',
    repository: {
      commit: '1234567890abcdef1234567890abcdef12345678',
      dirty: false,
      source: {
        algorithm: 'sha256',
        digest: 'a'.repeat(64),
        state: 'clean',
        trackedDirty: false,
        untrackedSource: false,
      },
    },
    lockfile: { path: 'package-lock.json', sha256: 'b'.repeat(64) },
    actual: {
      serverImage: '26.7.0',
      dashboardApi: '26.7.0',
      toolsApi: '26.7.0',
    },
    contract: { fingerprint: 'e92dd64e2bba333f' },
    app: {
      variant: 'full',
      releaseProfile: 'production',
      version: '2.0.0',
      runtimeVersion: '2.0.0',
      updateChannel: 'production',
      iosBuildNumber: '5',
    },
    backup: {
      manifest: {
        file: path.basename(bundleManifestPath),
        bytes: fs.statSync(bundleManifestPath).size,
        sha256: sha256File(bundleManifestPath),
      },
      archive: {
        file: path.basename(bundleArchivePath),
        bytes: fs.statSync(bundleArchivePath).size,
        sha256: sha256File(bundleArchivePath),
      },
    },
  };
}

function writeSignedBackupReleaseManifest(releaseManifestPath, bundleManifestPath, bundleArchivePath, signing) {
  const content = buildMinimalBackupManifestContent(bundleManifestPath, bundleArchivePath);
  const manifest = {
    kind: 'darkfinances-release',
    schemaVersion: 2,
    builtAt: '2026-01-01T00:00:00.000Z',
    content,
    contentDigest: {
      algorithm: 'sha256',
      canonicalization: 'darkfinances-canonical-json-v1',
      value: sha256Canonical(content),
    },
    display: { repository: { commitShort: '1234567', branch: null } },
  };
  writeSignedManifest(
    releaseManifestPath,
    manifest,
    signing.signingPath,
    signing.keyringPath,
  );
  return manifest;
}

function createSignedBackupReleaseStub(signing) {
  return ({ releaseManifestPath, bundleManifestFinal, bundleArchiveFinal }) => {
    writeSignedBackupReleaseManifest(
      releaseManifestPath,
      bundleManifestFinal,
      bundleArchiveFinal,
      signing,
    );
  };
}

function writeSignedReleaseEvidence(releasePath, bundleManifestPath, bundleArchivePath, signing) {
  const content = buildMinimalBackupManifestContent(bundleManifestPath, bundleArchivePath);
  const manifest = {
    kind: 'darkfinances-release',
    schemaVersion: 2,
    builtAt: '2026-01-01T00:00:00.000Z',
    content,
    contentDigest: {
      algorithm: 'sha256',
      canonicalization: 'darkfinances-canonical-json-v1',
      value: sha256Canonical(content),
    },
    display: { repository: { commitShort: '1234567', branch: null } },
  };
  writeSignedManifest(
    releasePath,
    manifest,
    signing.signingPath,
    signing.keyringPath,
  );
  return manifest;
}

module.exports = {
  createEphemeralSigningMaterial,
  signManifestFile,
  writeSignedManifest,
  writeSignedBackupReleaseManifest,
  createSignedBackupReleaseStub,
  writeSignedReleaseEvidence,
  buildMinimalBackupManifestContent,
};
