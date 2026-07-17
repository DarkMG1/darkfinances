'use strict';

const fs = require('fs');
const path = require('path');
const crypto = require('crypto');
const { fsyncPath } = require('./restore-durable-io');
const { assertNotSymlink } = require('./coordinated-operation-layout');

const REGISTRY_KIND = 'darkfinances-coordinated-admission-registry-entry';
const REGISTRY_SCHEMA_VERSION = 1;
const TERMINAL_SCHEMA_VERSION = 2;
const REGISTRY_MAX_BYTES = 4096;
const TERMINAL_CONSUMED = 'consumed';
const TERMINAL_REVOKED = 'revoked';

function registryRootForLayout(layout) {
  return path.join(layout.controlRoot, 'admission-registry');
}

function registeredPath(registryRoot, nonce) {
  return path.join(registryRoot, 'registered', `${nonce}.json`);
}

function terminalPath(registryRoot, nonce) {
  return path.join(registryRoot, 'terminal', `${nonce}.json`);
}

function legacyConsumedPath(registryRoot, nonce) {
  return path.join(registryRoot, 'consumed', `${nonce}.json`);
}

function legacyRevokedPath(registryRoot, nonce) {
  return path.join(registryRoot, 'revoked', `${nonce}.json`);
}

function ensureRegistryDirs(registryRoot) {
  for (const sub of ['registered', 'terminal', 'consumed', 'revoked']) {
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

function readTerminalMarkerWithRetry(registryRoot, nonce, attempts = 25) {
  for (let attempt = 0; attempt < attempts; attempt += 1) {
    try {
      return readTerminalMarker(registryRoot, nonce);
    } catch (error) {
      if (!/not valid JSON|invalid terminal state/.test(error.message) || attempt + 1 >= attempts) {
        throw error;
      }
      const until = Date.now() + 2;
      while (Date.now() < until) {
        // brief spin while a concurrent claim finishes publishing
      }
    }
  }
  return null;
}

function writeCompleteFile(filePath, payload, { exclusive = true } = {}) {
  const text = `${JSON.stringify(payload, null, 2)}\n`;
  if (Buffer.byteLength(text, 'utf8') > REGISTRY_MAX_BYTES) {
    throw new Error('admission registry marker exceeds size limit');
  }
  const fd = fs.openSync(filePath, exclusive ? 'wx' : 'w', 0o600);
  try {
    fs.writeFileSync(fd, text, { encoding: 'utf8' });
    fs.fsyncSync(fd);
  } finally {
    fs.closeSync(fd);
  }
  fsyncPath(path.dirname(filePath), true);
}

function writeMarkerAtomic(filePath, payload) {
  writeCompleteFile(filePath, payload, { exclusive: true });
}

function normalizeTerminalMarker(parsed, label = 'admission terminal marker') {
  if (parsed.terminal === TERMINAL_CONSUMED || parsed.terminal === TERMINAL_REVOKED) {
    if (parsed.kind !== REGISTRY_KIND) throw new Error(`${label} kind mismatch`);
    if (parsed.schemaVersion !== TERMINAL_SCHEMA_VERSION) {
      throw new Error(`${label} schemaVersion ${parsed.schemaVersion} is unsupported`);
    }
    return {
      terminal: parsed.terminal,
      at: parsed.at || parsed.consumedAt || parsed.revokedAt,
      reasonCode: parsed.reasonCode ?? null,
      nonce: parsed.nonce,
    };
  }
  if (parsed.consumedAt) {
    return { terminal: TERMINAL_CONSUMED, at: parsed.consumedAt, reasonCode: null, nonce: parsed.nonce };
  }
  if (parsed.revokedAt) {
    return {
      terminal: TERMINAL_REVOKED,
      at: parsed.revokedAt,
      reasonCode: parsed.reasonCode ?? null,
      nonce: parsed.nonce,
    };
  }
  throw new Error(`${label} has invalid terminal state`);
}

function readTerminalMarker(registryRoot, nonce) {
  const unified = terminalPath(registryRoot, nonce);
  if (fs.existsSync(unified)) {
    return normalizeTerminalMarker(readRegistryJson(unified, 'admission terminal marker'));
  }
  const hasConsumed = fs.existsSync(legacyConsumedPath(registryRoot, nonce));
  const hasRevoked = fs.existsSync(legacyRevokedPath(registryRoot, nonce));
  if (hasConsumed && hasRevoked) {
    throw new Error('admission registry legacy dual terminal markers detected');
  }
  if (hasConsumed) {
    return normalizeTerminalMarker(
      readRegistryJson(legacyConsumedPath(registryRoot, nonce), 'admission legacy consumption marker'),
    );
  }
  if (hasRevoked) {
    return normalizeTerminalMarker(
      readRegistryJson(legacyRevokedPath(registryRoot, nonce), 'admission legacy revocation marker'),
    );
  }
  return null;
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

function claimTerminal(registryRoot, nonce, terminal, { reasonCode = null } = {}) {
  ensureRegistryDirs(registryRoot);
  const filePath = terminalPath(registryRoot, nonce);
  const payload = {
    kind: REGISTRY_KIND,
    schemaVersion: TERMINAL_SCHEMA_VERSION,
    nonce,
    terminal,
    at: new Date().toISOString(),
    ...(terminal === TERMINAL_REVOKED
      ? { reasonCode: String(reasonCode || 'revoked').slice(0, 64) }
      : {}),
  };
  const partPath = path.join(
    registryRoot,
    'terminal',
    `.${nonce}.${process.pid}.${crypto.randomUUID()}.part`,
  );
  writeCompleteFile(partPath, payload, { exclusive: true });
  try {
    fs.linkSync(partPath, filePath);
  } catch (error) {
    try {
      fs.unlinkSync(partPath);
    } catch {
      // best-effort cleanup
    }
    if (error.code === 'EEXIST') {
      const existing = readTerminalMarkerWithRetry(registryRoot, nonce);
      if (!existing) throw new Error('admission terminal marker conflict without readable state');
      return { created: false, marker: existing };
    }
    throw error;
  }
  fs.unlinkSync(partPath);
  fsyncPath(path.dirname(filePath), true);
  return { created: true, marker: normalizeTerminalMarker(payload) };
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
  const terminal = readTerminalMarker(registryRoot, nonce);
  if (terminal?.terminal === TERMINAL_REVOKED) throw new Error('admission token revoked');
  if (terminal?.terminal === TERMINAL_CONSUMED) throw new Error('admission token already consumed');
  if (Date.parse(entry.expiresAt) < Date.now()) throw new Error('admission token expired');
  if (runId && entry.runId !== runId) throw new Error('admission token runId mismatch');
  if (journalId && entry.journalId !== journalId) throw new Error('admission token journalId mismatch');
  return entry;
}

function consumeAdmission(layout, nonce) {
  const registryRoot = registryRootForLayout(layout);
  const entry = assertAdmissionConsumable(layout, nonce);
  const result = claimTerminal(registryRoot, nonce, TERMINAL_CONSUMED);
  if (result.created) {
    return { ...entry, consumedAt: result.marker.at };
  }
  if (result.marker.terminal === TERMINAL_CONSUMED) {
    throw new Error('admission token already consumed');
  }
  throw new Error('admission token revoked');
}

function revokeAdmission(layout, nonce, reasonCode = 'revoked') {
  const registryRoot = registryRootForLayout(layout);
  const entry = readRegisteredEntry(registryRoot, nonce);
  if (!entry) return null;
  const result = claimTerminal(registryRoot, nonce, TERMINAL_REVOKED, { reasonCode });
  if (result.created) return entry;
  if (result.marker.terminal === TERMINAL_REVOKED) return entry;
  throw new Error('admission token already consumed');
}

module.exports = {
  REGISTRY_KIND,
  REGISTRY_SCHEMA_VERSION,
  TERMINAL_SCHEMA_VERSION,
  TERMINAL_CONSUMED,
  TERMINAL_REVOKED,
  registryRootForLayout,
  registeredPath,
  terminalPath,
  legacyConsumedPath,
  legacyRevokedPath,
  readTerminalMarker,
  registerAdmission,
  assertAdmissionConsumable,
  consumeAdmission,
  revokeAdmission,
};
