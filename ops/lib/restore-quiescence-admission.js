'use strict';

const fs = require('fs');
const path = require('path');
const {
  resolveVerificationKey,
  resolveSigningKey,
  signPayload,
  verifySignature,
} = require('./coordinated-admission-crypto');
const {
  assertAdmissionConsumable,
  consumeAdmission,
  registerAdmission,
  revokeAdmission,
} = require('./coordinated-admission-registry');
const { coordinatedLayoutForRoot, assertNotSymlink } = require('./coordinated-operation-layout');
const { assertAllWritersQuiescentForAdmission, writerStatesForAdmission } = require('./writer-quiescence');

const ADMISSION_KIND = 'darkfinances-restore-quiescence-admission';
const ADMISSION_SCHEMA_VERSION = 2;
const MIN_ADMISSION_SCHEMA_VERSION = 2;

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
    nonce: payload.nonce,
    runId: payload.runId,
    journalId: payload.journalId,
    writers: payload.writers,
    bindings: payload.bindings,
  });
}

function parseAdmissionToken(text, label = 'quiescence admission token', options = {}) {
  let parsed;
  try {
    parsed = JSON.parse(text);
  } catch (error) {
    throw new Error(`${label} is not valid JSON: ${error.message}`);
  }
  if (!isPlainObject(parsed)) throw new Error(`${label} must be a JSON object`);
  if (parsed.kind !== ADMISSION_KIND) throw new Error(`${label} kind mismatch`);
  if (typeof parsed.schemaVersion !== 'number' || parsed.schemaVersion < MIN_ADMISSION_SCHEMA_VERSION) {
    throw new Error(`${label} schemaVersion ${parsed.schemaVersion} lacks signed live-restore support`);
  }
  if (parsed.admitted !== true) throw new Error(`${label} is not admitted`);
  for (const field of ['issuedAt', 'expiresAt', 'nonce', 'runId', 'journalId']) {
    if (typeof parsed[field] !== 'string' || !parsed[field]) {
      throw new Error(`${label} requires ${field}`);
    }
  }
  if (Date.parse(parsed.expiresAt) <= Date.parse(parsed.issuedAt)) {
    throw new Error(`${label} expiresAt must be after issuedAt`);
  }
  if (typeof parsed.signature !== 'string' || !parsed.signature) {
    throw new Error(`${label} requires Ed25519 signature`);
  }
  if (!isPlainObject(parsed.writers)) throw new Error(`${label} writers must be an object`);
  for (const [name, state] of Object.entries(parsed.writers)) {
    if (typeof state !== 'string' || !['stopped', 'inactive', 'not-present'].includes(state)) {
      throw new Error(`${label} writer ${name} has invalid quiescent state ${state}`);
    }
  }
  if (!isPlainObject(parsed.bindings)) throw new Error(`${label} bindings must be an object`);
  for (const field of [
    'archiveSha256',
    'destinationRoot',
    'manifestArtifactId',
    'releaseManifestDigest',
    'coordinatedManifestDigest',
    'writerInventoryDigest',
    'journalId',
  ]) {
    const value = parsed.bindings[field];
    if (typeof value !== 'string' || !value) {
      throw new Error(`${label} bindings.${field} is required`);
    }
  }
  if (!/^[a-f0-9]{64}$/.test(parsed.bindings.archiveSha256)) {
    throw new Error(`${label} bindings.archiveSha256 must be sha256 hex`);
  }

  const publicKey = options.publicKey || resolveVerificationKey(options.env || process.env);
  const canonical = canonicalAdmissionPayload(parsed);
  if (!verifySignature(publicKey, canonical, parsed.signature)) {
    throw new Error(`${label} signature verification failed`);
  }
  return parsed;
}

function trustedCoordinatorRoots(options = {}) {
  const roots = [];
  if (options.layout) {
    roots.push(options.layout.controlRoot, options.layout.workRoot, options.layout.canonicalRoot);
  }
  if (options.coordinatorRoot) {
    const layout = coordinatedLayoutForRoot(options.coordinatorRoot);
    roots.push(layout.controlRoot, layout.workRoot, layout.canonicalRoot);
  }
  for (const root of options.trustedRoots || []) {
    if (root) roots.push(root);
  }
  return [...new Set(roots.map((entry) => path.resolve(entry)))];
}

function assertTrustedAdmissionTokenPath(tokenPath, options = {}, label = 'admission token path') {
  const resolved = path.resolve(tokenPath);
  const stat = fs.lstatSync(resolved);
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
  const canonical = fs.realpathSync(resolved);
  const allowedRoots = trustedCoordinatorRoots(options);
  if (allowedRoots.length === 0) {
    throw new Error(`${label} requires trusted coordinator roots`);
  }
  const allowed = allowedRoots.map((root) => (
    fs.existsSync(root) ? fs.realpathSync(root) : root
  ));
  if (!allowed.some((root) => canonical === root || canonical.startsWith(`${root}${path.sep}`))) {
    throw new Error(`${label} is outside trusted coordinator roots`);
  }
  return canonical;
}

function readAdmissionTokenFile(tokenPath, options = {}, label = 'quiescence admission token') {
  const canonical = assertTrustedAdmissionTokenPath(tokenPath, options, label);
  return parseAdmissionToken(fs.readFileSync(canonical, 'utf8'), label, { env: options.env, ...options });
}

function admissionTokenFromEnv(env = process.env, options = {}) {
  const resolvedOptions = {
    env,
    ...options,
    coordinatorRoot: options.coordinatorRoot || env.DARKFINANCES_BACKUP_DIR || null,
  };
  const inline = env.RESTORE_QUIESCENCE_ADMISSION_TOKEN;
  if (inline) return parseAdmissionToken(inline, 'RESTORE_QUIESCENCE_ADMISSION_TOKEN', resolvedOptions);
  const tokenPath = env.RESTORE_QUIESCENCE_ADMISSION_PATH;
  if (tokenPath) {
    if (!fs.existsSync(tokenPath)) {
      throw new Error(`quiescence admission token file not found: ${tokenPath}`);
    }
    return readAdmissionTokenFile(tokenPath, resolvedOptions);
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
  if (context.manifestArtifactId && token.bindings.manifestArtifactId !== context.manifestArtifactId) {
    throw new Error('quiescence admission token manifest artifact binding mismatch');
  }
  if (context.releaseManifestDigest && token.bindings.releaseManifestDigest !== context.releaseManifestDigest) {
    throw new Error('quiescence admission token release digest binding mismatch');
  }
  if (context.coordinatedManifestDigest
    && token.bindings.coordinatedManifestDigest !== context.coordinatedManifestDigest) {
    throw new Error('quiescence admission token coordinated manifest binding mismatch');
  }
  if (context.writerInventoryDigest && token.bindings.writerInventoryDigest !== context.writerInventoryDigest) {
    throw new Error('quiescence admission token writer inventory binding mismatch');
  }
  if (context.actualDataGeneration !== undefined && context.actualDataGeneration !== null
    && token.bindings.actualDataGeneration !== context.actualDataGeneration) {
    throw new Error('quiescence admission token actual generation binding mismatch');
  }
}

function assertAdmissionRegistryState(token, layout) {
  assertAdmissionConsumable(layout, token.nonce, {
    runId: token.runId,
    journalId: token.journalId,
  });
}

function requireQuiescenceAdmission(options = {}) {
  if (options.skipQuiescenceAdmission === true) {
    throw new Error('restore refused: quiescence admission cannot be skipped');
  }
  const env = options.env || process.env;
  const token = admissionTokenFromEnv(env, options);
  if (!token) {
    throw new Error('restore refused: missing signed quiescence admission token (PR-18 owns writer quiescence)');
  }
  assertAdmissionFresh(token);
  if (options.requireBindings === true) {
    assertAdmissionBindings(token, options.bindingContext || {});
  }
  if (options.layout) {
    assertAdmissionRegistryState(token, options.layout);
  } else if (options.coordinatorRoot) {
    assertAdmissionRegistryState(token, coordinatedLayoutForRoot(options.coordinatorRoot));
  }
  if (options.verifyLiveWriters !== false && options.writerContext) {
    assertAllWritersQuiescentForAdmission(options.writerContext, token.writers);
  }
  return token;
}

function issueSignedAdmissionToken({
  layout,
  runId,
  journalId,
  snapshotsById,
  context,
  bindings,
  ttlMs = DEFAULT_ADMISSION_TTL_MS,
  env = process.env,
  privateKey = null,
}) {
  assertAllWritersQuiescentForAdmission({ ...context, snapshotsById });
  const writers = writerStatesForAdmission(snapshotsById);
  const issuedAt = new Date();
  const nonce = require('crypto').randomUUID();
  const payload = {
    schemaVersion: ADMISSION_SCHEMA_VERSION,
    kind: ADMISSION_KIND,
    admitted: true,
    issuedAt: issuedAt.toISOString(),
    expiresAt: new Date(issuedAt.getTime() + ttlMs).toISOString(),
    nonce,
    runId,
    journalId,
    writers,
    bindings: {
      ...bindings,
      journalId,
    },
  };
  const signingKey = privateKey || resolveSigningKey(env);
  payload.signature = signPayload(signingKey, canonicalAdmissionPayload(payload));
  registerAdmission(layout, {
    nonce,
    runId,
    journalId,
    issuedAt: payload.issuedAt,
    expiresAt: payload.expiresAt,
  });
  return payload;
}

function consumeAdmissionToken(layout, token) {
  consumeAdmission(layout, token.nonce);
}

function revokeAdmissionToken(layout, token, reasonCode = 'revoked') {
  if (!token?.nonce) return null;
  return revokeAdmission(layout, token.nonce, reasonCode);
}

module.exports = {
  ADMISSION_KIND,
  ADMISSION_SCHEMA_VERSION,
  MIN_ADMISSION_SCHEMA_VERSION,
  DEFAULT_ADMISSION_TTL_MS,
  canonicalAdmissionPayload,
  admissionTokenFromEnv,
  requireQuiescenceAdmission,
  parseAdmissionToken,
  issueSignedAdmissionToken,
  consumeAdmissionToken,
  revokeAdmissionToken,
  readAdmissionTokenFile,
  assertTrustedAdmissionTokenPath,
  trustedCoordinatorRoots,
  assertAdmissionFresh,
  assertAdmissionBindings,
  assertAdmissionRegistryState,
  canonicalBindingPath,
};
