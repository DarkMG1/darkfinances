'use strict';

const fs = require('fs');
const crypto = require('crypto');
const path = require('path');

const ADMISSION_KIND = 'darkfinances-restore-quiescence-admission';
const ADMISSION_SCHEMA_VERSION = 1;

const DEFAULT_ADMISSION_TTL_MS = 15 * 60 * 1000;

function isPlainObject(value) {
  return !!value && typeof value === 'object' && !Array.isArray(value);
}

function canonicalAdmissionPayload(payload) {
  return JSON.stringify({
    schemaVersion: payload.schemaVersion,
    kind: payload.kind,
    admitted: payload.admitted,
    issuedAt: payload.issuedAt,
    expiresAt: payload.expiresAt,
    writers: payload.writers,
    bindings: payload.bindings,
  });
}

function admissionDigest(payload) {
  return crypto.createHash('sha256').update(`${canonicalAdmissionPayload(payload)}\n`).digest('hex');
}

function parseAdmissionToken(text, label = 'quiescence admission token') {
  let parsed;
  try {
    parsed = JSON.parse(text);
  } catch (error) {
    throw new Error(`${label} is not valid JSON: ${error.message}`);
  }
  if (!isPlainObject(parsed)) throw new Error(`${label} must be a JSON object`);
  if (parsed.kind !== ADMISSION_KIND) throw new Error(`${label} kind mismatch`);
  if (parsed.schemaVersion !== ADMISSION_SCHEMA_VERSION) {
    throw new Error(`${label} schemaVersion ${parsed.schemaVersion} is unsupported`);
  }
  if (parsed.admitted !== true) throw new Error(`${label} is not admitted`);
  if (typeof parsed.issuedAt !== 'string' || !parsed.issuedAt) {
    throw new Error(`${label} requires issuedAt`);
  }
  if (typeof parsed.expiresAt !== 'string' || !parsed.expiresAt) {
    throw new Error(`${label} requires expiresAt`);
  }
  if (Date.parse(parsed.expiresAt) <= Date.parse(parsed.issuedAt)) {
    throw new Error(`${label} expiresAt must be after issuedAt`);
  }
  if (typeof parsed.token !== 'string' || !/^[a-f0-9]{64}$/.test(parsed.token)) {
    throw new Error(`${label} requires token sha256 digest`);
  }
  if (!isPlainObject(parsed.writers)) throw new Error(`${label} writers must be an object`);
  for (const [name, state] of Object.entries(parsed.writers)) {
    if (typeof state !== 'string' || !['stopped', 'inactive', 'not-present'].includes(state)) {
      throw new Error(`${label} writer ${name} has invalid state ${state}`);
    }
  }
  if (!isPlainObject(parsed.bindings)) throw new Error(`${label} bindings must be an object`);
  for (const field of ['archiveSha256', 'destinationRoot']) {
    const value = parsed.bindings[field];
    if (typeof value !== 'string' || !value) {
      throw new Error(`${label} bindings.${field} is required`);
    }
  }
  if (parsed.bindings.archiveSha256 && !/^[a-f0-9]{64}$/.test(parsed.bindings.archiveSha256)) {
    throw new Error(`${label} bindings.archiveSha256 must be sha256 hex`);
  }
  const expected = admissionDigest(parsed);
  if (parsed.token !== expected) throw new Error(`${label} token digest mismatch`);
  return parsed;
}

function admissionTokenFromEnv(env = process.env) {
  const inline = env.RESTORE_QUIESCENCE_ADMISSION_TOKEN;
  if (inline) return parseAdmissionToken(inline, 'RESTORE_QUIESCENCE_ADMISSION_TOKEN');
  const tokenPath = env.RESTORE_QUIESCENCE_ADMISSION_PATH;
  if (tokenPath) {
    if (!fs.existsSync(tokenPath)) {
      throw new Error(`quiescence admission token file not found: ${tokenPath}`);
    }
    return parseAdmissionToken(fs.readFileSync(tokenPath, 'utf8'), tokenPath);
  }
  return null;
}

function assertAdmissionFresh(token, now = Date.now()) {
  if (Date.parse(token.expiresAt) < now) {
    throw new Error('quiescence admission token expired');
  }
}

function canonicalBindingPath(root) {
  const resolved = path.resolve(root);
  if (fs.existsSync(resolved)) {
    return fs.realpathSync(resolved);
  }
  return resolved;
}

function assertAdmissionBindings(token, context = {}) {
  if (token.bindings.archiveSha256 !== context.archiveSha256) {
    throw new Error('quiescence admission token archive binding mismatch');
  }
  if (canonicalBindingPath(token.bindings.destinationRoot)
    !== canonicalBindingPath(context.destinationRoot)) {
    throw new Error('quiescence admission token destination binding mismatch');
  }
  if (context.manifestArtifactId && token.bindings.manifestArtifactId
    && token.bindings.manifestArtifactId !== context.manifestArtifactId) {
    throw new Error('quiescence admission token manifest artifact binding mismatch');
  }
}

function requireQuiescenceAdmission(options = {}) {
  if (options.skipQuiescenceAdmission === true) return null;
  const token = admissionTokenFromEnv(options.env || process.env);
  if (!token) {
    throw new Error('restore refused: missing quiescence admission token (PR-18 owns writer quiescence)');
  }
  assertAdmissionFresh(token);
  if (options.requireBindings === true) {
    assertAdmissionBindings(token, options.bindingContext || {});
  }
  return token;
}

function buildTestAdmissionToken(writers = {}, bindings = {}, ttlMs = DEFAULT_ADMISSION_TTL_MS) {
  const issuedAt = new Date();
  const payload = {
    schemaVersion: ADMISSION_SCHEMA_VERSION,
    kind: ADMISSION_KIND,
    admitted: true,
    issuedAt: issuedAt.toISOString(),
    expiresAt: new Date(issuedAt.getTime() + ttlMs).toISOString(),
    writers: {
      'finance-dashboard': 'stopped',
      'actual-sync': 'stopped',
      ...writers,
    },
    bindings: {
      archiveSha256: bindings.archiveSha256 || '0'.repeat(64),
      destinationRoot: canonicalBindingPath(bindings.destinationRoot || '/tmp/finance-dashboard'),
      manifestArtifactId: bindings.manifestArtifactId ?? null,
      releaseManifestDigest: bindings.releaseManifestDigest ?? null,
      actualDataGeneration: bindings.actualDataGeneration ?? null,
    },
  };
  payload.token = admissionDigest(payload);
  return payload;
}

function buildAdmissionTokenForRestore({
  archiveSha256,
  destinationRoot,
  manifestArtifactId = null,
  releaseManifestDigest = null,
  actualDataGeneration = null,
  writers = {},
  ttlMs = DEFAULT_ADMISSION_TTL_MS,
}) {
  return buildTestAdmissionToken(writers, {
    archiveSha256,
    destinationRoot,
    manifestArtifactId,
    releaseManifestDigest,
    actualDataGeneration,
  }, ttlMs);
}

module.exports = {
  ADMISSION_KIND,
  ADMISSION_SCHEMA_VERSION,
  DEFAULT_ADMISSION_TTL_MS,
  admissionTokenFromEnv,
  requireQuiescenceAdmission,
  parseAdmissionToken,
  buildTestAdmissionToken,
  buildAdmissionTokenForRestore,
  assertAdmissionFresh,
  assertAdmissionBindings,
  canonicalBindingPath,
  admissionDigest,
};
