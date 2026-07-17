'use strict';

const fs = require('fs');
const path = require('path');
const { writeFileAtomic } = require('./restore-durable-io');
const { assertNotSymlink } = require('./coordinated-operation-layout');

const REGISTRY_KIND = 'darkfinances-coordinated-admission-registry';
const REGISTRY_SCHEMA_VERSION = 1;
const REGISTRY_MAX_BYTES = 256 * 1024;

function registryPathForLayout(layout) {
  return path.join(layout.controlRoot, 'admission-registry.json');
}

function readAdmissionRegistry(registryPath) {
  if (!fs.existsSync(registryPath)) {
    return {
      kind: REGISTRY_KIND,
      schemaVersion: REGISTRY_SCHEMA_VERSION,
      entries: {},
    };
  }
  const stat = fs.lstatSync(registryPath);
  assertNotSymlink(stat, 'admission registry');
  if (!stat.isFile()) throw new Error('admission registry must be a regular file');
  if (stat.size > REGISTRY_MAX_BYTES) throw new Error('admission registry exceeds size limit');
  const parsed = JSON.parse(fs.readFileSync(registryPath, 'utf8'));
  if (parsed.kind !== REGISTRY_KIND) throw new Error('admission registry kind mismatch');
  if (parsed.schemaVersion !== REGISTRY_SCHEMA_VERSION) {
    throw new Error(`unsupported admission registry schemaVersion ${parsed.schemaVersion}`);
  }
  if (!parsed.entries || typeof parsed.entries !== 'object') {
    throw new Error('admission registry requires entries object');
  }
  return parsed;
}

function writeAdmissionRegistry(registryPath, registry) {
  const text = `${JSON.stringify(registry, null, 2)}\n`;
  if (Buffer.byteLength(text, 'utf8') > REGISTRY_MAX_BYTES) {
    throw new Error('admission registry exceeds size limit');
  }
  writeFileAtomic(registryPath, text, 0o600);
}

function registerAdmission(layout, { nonce, runId, journalId, issuedAt, expiresAt }) {
  const registryPath = registryPathForLayout(layout);
  const registry = readAdmissionRegistry(registryPath);
  if (registry.entries[nonce]) {
    throw new Error('admission nonce already registered');
  }
  registry.entries[nonce] = {
    nonce,
    runId,
    journalId,
    issuedAt,
    expiresAt,
    consumedAt: null,
    revokedAt: null,
  };
  writeAdmissionRegistry(registryPath, registry);
  return registry.entries[nonce];
}

function assertAdmissionConsumable(layout, nonce, { runId = null, journalId = null } = {}) {
  const registryPath = registryPathForLayout(layout);
  const registry = readAdmissionRegistry(registryPath);
  const entry = registry.entries[nonce];
  if (!entry) throw new Error('admission token nonce is not registered');
  if (entry.revokedAt) throw new Error('admission token revoked');
  if (entry.consumedAt) throw new Error('admission token already consumed');
  if (Date.parse(entry.expiresAt) < Date.now()) throw new Error('admission token expired');
  if (runId && entry.runId !== runId) throw new Error('admission token runId mismatch');
  if (journalId && entry.journalId !== journalId) throw new Error('admission token journalId mismatch');
  return entry;
}

function consumeAdmission(layout, nonce) {
  const registryPath = registryPathForLayout(layout);
  const registry = readAdmissionRegistry(registryPath);
  const entry = registry.entries[nonce];
  if (!entry) throw new Error('admission token nonce is not registered');
  if (entry.revokedAt) throw new Error('admission token revoked');
  if (entry.consumedAt) throw new Error('admission token already consumed');
  entry.consumedAt = new Date().toISOString();
  writeAdmissionRegistry(registryPath, registry);
  return entry;
}

function revokeAdmission(layout, nonce, reason = 'revoked') {
  const registryPath = registryPathForLayout(layout);
  const registry = readAdmissionRegistry(registryPath);
  const entry = registry.entries[nonce];
  if (!entry) return null;
  if (!entry.consumedAt) entry.revokedAt = new Date().toISOString();
  entry.revokeReason = reason;
  writeAdmissionRegistry(registryPath, registry);
  return entry;
}

module.exports = {
  REGISTRY_KIND,
  REGISTRY_SCHEMA_VERSION,
  registryPathForLayout,
  readAdmissionRegistry,
  writeAdmissionRegistry,
  registerAdmission,
  assertAdmissionConsumable,
  consumeAdmission,
  revokeAdmission,
};
