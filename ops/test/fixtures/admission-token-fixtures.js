'use strict';

const crypto = require('crypto');
const {
  signPayload,
  generateTestKeyPair,
  exportPublicKeyPem,
  exportPrivateKeyPem,
} = require('../../lib/coordinated-admission-crypto');
const {
  ADMISSION_KIND,
  ADMISSION_SCHEMA_VERSION,
  canonicalAdmissionPayload,
} = require('../../lib/restore-quiescence-admission');

function buildTestAdmissionToken({
  writers = {},
  bindings = {},
  ttlMs = 15 * 60 * 1000,
  keyPair = null,
  runId = 'test-run',
  journalId = 'test-journal',
  nonce = crypto.randomUUID(),
} = {}) {
  const pair = keyPair || generateTestKeyPair();
  const issuedAt = new Date();
  const payload = {
    schemaVersion: ADMISSION_SCHEMA_VERSION,
    kind: ADMISSION_KIND,
    admitted: true,
    issuedAt: issuedAt.toISOString(),
    expiresAt: new Date(issuedAt.getTime() + ttlMs).toISOString(),
    nonce,
    runId,
    journalId,
    writers: {
      'finance-dashboard': 'stopped',
      'actual-sync.timer': 'stopped',
      'actual-sync.service': 'stopped',
      ...writers,
    },
    bindings: {
      archiveSha256: bindings.archiveSha256 || '0'.repeat(64),
      destinationRoot: bindings.destinationRoot || '/tmp/finance-dashboard',
      manifestArtifactId: bindings.manifestArtifactId || 'a'.repeat(64),
      releaseManifestDigest: bindings.releaseManifestDigest || 'b'.repeat(64),
      coordinatedManifestDigest: bindings.coordinatedManifestDigest || 'c'.repeat(64),
      writerInventoryDigest: bindings.writerInventoryDigest || 'd'.repeat(64),
      actualDataGeneration: bindings.actualDataGeneration ?? null,
      journalId,
    },
  };
  payload.signature = signPayload(pair.privateKey, canonicalAdmissionPayload(payload));
  return { token: payload, keyPair: pair, publicKeyPem: exportPublicKeyPem(pair.publicKey), privateKeyPem: exportPrivateKeyPem(pair.privateKey) };
}

function registerTestAdmission(layout, token, registryModule = require('../../lib/coordinated-admission-registry')) {
  registryModule.registerAdmission(layout, {
    nonce: token.nonce,
    runId: token.runId,
    journalId: token.journalId,
    issuedAt: token.issuedAt,
    expiresAt: token.expiresAt,
  });
}

module.exports = {
  buildTestAdmissionToken,
  registerTestAdmission,
};
