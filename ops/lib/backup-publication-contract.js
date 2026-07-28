'use strict';

const fs = require('fs');
const { sha256File } = require('./backup-verify');
const { signaturePathFor } = require('../../finance-dashboard/lib/release-signing');

function archiveChecksumPath(archivePath) {
  return `${archivePath}.sha256`;
}

function archiveManifestPath(archivePath) {
  return `${archivePath}.manifest.json`;
}

function isArchivePublicationCommitted(archivePath) {
  const checksumPath = archiveChecksumPath(archivePath);
  if (!fs.existsSync(archivePath) || !fs.existsSync(checksumPath)) return false;
  try {
    const expected = fs.readFileSync(checksumPath, 'utf8').trim().split(/\s+/)[0];
    return expected === sha256File(archivePath);
  } catch {
    return false;
  }
}

function assertArchivePublicationCommitted(archivePath, label = 'archive') {
  if (!archivePath || !fs.existsSync(archivePath)) {
    throw new Error(`${label} not found: ${archivePath}`);
  }
  const checksumPath = archiveChecksumPath(archivePath);
  if (!fs.existsSync(checksumPath)) {
    throw new Error(`missing archive checksum commit marker: ${checksumPath}`);
  }
  const expected = fs.readFileSync(checksumPath, 'utf8').trim().split(/\s+/)[0];
  const actual = sha256File(archivePath);
  if (expected !== actual) throw new Error('archive checksum mismatch');
}

function createRunPublicationTracker() {
  return {
    bundleArchive: null,
    bundleManifest: null,
    bundleChecksumCommitted: false,
    actualArchive: null,
    actualChecksumCommitted: false,
    releaseManifest: null,
    releaseSignature: null,
    releaseEvidenceCommitted: false,
    coordinatedManifest: null,
  };
}

function rmIfExists(target) {
  if (!target) return;
  try {
    if (fs.existsSync(target)) fs.rmSync(target, { force: true });
  } catch {
    // best-effort
  }
}

function cleanupPartialRunPublication(tracker) {
  if (!tracker) return;
  if (tracker.bundleArchive && !tracker.bundleChecksumCommitted) {
    rmIfExists(tracker.bundleArchive);
    rmIfExists(archiveManifestPath(tracker.bundleArchive));
    rmIfExists(archiveChecksumPath(tracker.bundleArchive));
  }
  if (tracker.actualArchive && !tracker.actualChecksumCommitted) {
    rmIfExists(tracker.actualArchive);
    rmIfExists(archiveChecksumPath(tracker.actualArchive));
  }
  if (!tracker.releaseEvidenceCommitted) {
    rmIfExists(tracker.releaseManifest);
    rmIfExists(tracker.releaseSignature || (tracker.releaseManifest
      ? signaturePathFor(tracker.releaseManifest)
      : null));
  }
  rmIfExists(tracker.coordinatedManifest);
}

module.exports = {
  archiveChecksumPath,
  archiveManifestPath,
  isArchivePublicationCommitted,
  assertArchivePublicationCommitted,
  createRunPublicationTracker,
  cleanupPartialRunPublication,
};
