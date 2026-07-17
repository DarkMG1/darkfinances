'use strict';

const fs = require('fs');
const path = require('path');
const { fsyncPath } = require('./restore-durable-io');
const { assertNotSymlink } = require('./coordinated-operation-layout');

const REGISTRY_KIND = 'darkfinances-coordinated-admission-registry-entry';
const REGISTRY_SCHEMA_VERSION = 1;
const REGISTRY_MAX_BYTES = 4096;

function registryRootForLayout(layout) {
  return path.join(layout.controlRoot, 'admission-registry');
}

function registeredPath(registryRoot, nonce) {
  return path.join(registryRoot, 'registered', `${nonce}.json`);
}

function consumedPath(registryRoot, nonce) {
  return path.join(registryRoot, 'consumed', `${nonce}.json`);
}

function revokedPath(registryRoot, nonce) {
  return path.join(registryRoot, 'revoked', `${nonce}.json`);
}

function ensureRegistryDirs(registryRoot) {
  for (const sub of ['registered', 'consumed', 'revoked']) {
    fs.mkdirSync(path.join(registryRoot, sub), { recursive: true, mode: 0o700 });
  }
}

function assertRegistryFileStat(stat, label) {
  assertNotSymlink(stat, label);
  if (!stat.isFile()) throw new Error(`${label} must be a regular file`);
  if (process.platform !== 'win32' && typeof process.getuid === 'function' && stat.uid !== process.getuid()) {
    throw new Error(`${label} ownership mismatch`);
  }
  if ((stat.mode & 0o777) !== 0o600) {
    throw new Error(`${label} mode must be 0600`);
  }
  if (stat.nlink > 1) {
    throw new Error(`${label} must not be hard-linked`);
  }
}

function readRegistryJson(filePath, label = 'admission registry entry') {
  const stat = fs.lstatSync(filePath);
  assertRegistryFileStat(stat, label);
  if (stat.size > REGISTRY_MAX_BYTES) throw new Error(`${label} exceeds size limit`);
  let parsed;
  try {
    parsed = JSON.parse(fs.readFileSync(filePath, 'utf8'));
  } catch (error) {
    throw new Error(`${label} is not valid JSON: ${error.message}`);
  }
  if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) {
    throw new Error(`${label} must be a JSON object`);
  }
  return parsed;
}

function writeMarkerAtomic(filePath, payload) {
  const text = `${JSON.stringify(payload, null, 2)}\n`;
  if (Buffer.byteLength(text, 'utf8') > REGISTRY_MAX_BYTES) {
    throw new Error('admission registry marker exceeds size limit');
  }
  const fd = fs.openSync(filePath, 'wx', 0o600);
  try {
    fs.writeFileSync(fd, text, { encoding: 'utf8' });
    fs.fsyncSync(fd);
  } finally {
    fs.closeSync(fd);
  }
  fsyncPath(path.dirname(filePath), true);
}

function readRegisteredEntry(registryRoot, nonce) {
  const filePath = registeredPath(registryRoot, nonce);
  if (!fs.existsSync(filePath)) return null;
  const entry = readRegistryJson(filePath, 'admission registration');
  if (entry.kind !== REGISTRY_KIND) throw new Error('admission registration kind mismatch');
  if (entry.schemaVersion !== REGISTRY_SCHEMA_VERSION) {
    throw new Error(`unsupported admission registration schemaVersion ${entry.schemaVersion}`);
  }
  if (entry.nonce !== nonce) throw new Error('admission registration nonce mismatch');
  return entry;
}

function markerExists(registryRoot, nonce, kind) {
  const filePath = kind === 'consumed'
    ? consumedPath(registryRoot, nonce)
    : revokedPath(registryRoot, nonce);
  return fs.existsSync(filePath);
}

function registerAdmission(layout, { nonce, runId, journalId, issuedAt, expiresAt }) {
  const registryRoot = registryRootForLayout(layout);
  ensureRegistryDirs(registryRoot);
  const filePath = registeredPath(registryRoot, nonce);
  const entry = {
    kind: REGISTRY_KIND,
    schemaVersion: REGISTRY_SCHEMA_VERSION,
    nonce,
    runId,
    journalId,
    issuedAt,
    expiresAt,
  };
  try {
    writeMarkerAtomic(filePath, entry);
  } catch (error) {
    if (error.code === 'EEXIST') throw new Error('admission nonce already registered');
    throw error;
  }
  return entry;
}

function assertAdmissionConsumable(layout, nonce, { runId = null, journalId = null } = {}) {
  const registryRoot = registryRootForLayout(layout);
  const entry = readRegisteredEntry(registryRoot, nonce);
  if (!entry) throw new Error('admission token nonce is not registered');
  if (markerExists(registryRoot, nonce, 'revoked')) throw new Error('admission token revoked');
  if (markerExists(registryRoot, nonce, 'consumed')) throw new Error('admission token already consumed');
  if (Date.parse(entry.expiresAt) < Date.now()) throw new Error('admission token expired');
  if (runId && entry.runId !== runId) throw new Error('admission token runId mismatch');
  if (journalId && entry.journalId !== journalId) throw new Error('admission token journalId mismatch');
  return entry;
}

function consumeAdmission(layout, nonce) {
  const registryRoot = registryRootForLayout(layout);
  const entry = assertAdmissionConsumable(layout, nonce);
  ensureRegistryDirs(registryRoot);
  const markerFile = consumedPath(registryRoot, nonce);
  try {
    writeMarkerAtomic(markerFile, {
      kind: REGISTRY_KIND,
      schemaVersion: REGISTRY_SCHEMA_VERSION,
      nonce,
      consumedAt: new Date().toISOString(),
    });
  } catch (error) {
    if (error.code === 'EEXIST') throw new Error('admission token already consumed');
    throw error;
  }
  return { ...entry, consumedAt: readRegistryJson(markerFile, 'admission consumption marker').consumedAt };
}

function revokeAdmission(layout, nonce, reasonCode = 'revoked') {
  const registryRoot = registryRootForLayout(layout);
  if (!readRegisteredEntry(registryRoot, nonce)) return null;
  if (markerExists(registryRoot, nonce, 'consumed')) return readRegisteredEntry(registryRoot, nonce);
  ensureRegistryDirs(registryRoot);
  const markerFile = revokedPath(registryRoot, nonce);
  if (fs.existsSync(markerFile)) {
    return readRegisteredEntry(registryRoot, nonce);
  }
  try {
    writeMarkerAtomic(markerFile, {
      kind: REGISTRY_KIND,
      schemaVersion: REGISTRY_SCHEMA_VERSION,
      nonce,
      revokedAt: new Date().toISOString(),
      reasonCode: String(reasonCode).slice(0, 64),
    });
  } catch (error) {
    if (error.code === 'EEXIST') return readRegisteredEntry(registryRoot, nonce);
    throw error;
  }
  return readRegisteredEntry(registryRoot, nonce);
}

module.exports = {
  REGISTRY_KIND,
  REGISTRY_SCHEMA_VERSION,
  registryRootForLayout,
  registeredPath,
  consumedPath,
  revokedPath,
  registerAdmission,
  assertAdmissionConsumable,
  consumeAdmission,
  revokeAdmission,
};
