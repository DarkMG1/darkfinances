'use strict';

const crypto = require('crypto');
const fs = require('fs');
const path = require('path');
const {
  MAX_MANIFEST_BYTES,
  readTrustedRegularFile,
  requireNonEmptyString,
} = require('./trusted-regular-file-read');
const {
  assertNoUnknownKeys,
  assertPlainObject,
  canonicalSerialize,
  validateHash,
  validateManifestEnvelope,
} = require('./release-schema');

const SIGNATURE_KIND = 'darkfinances-release-signature';
const SIGNATURE_SCHEMA_VERSION = 1;
const SIGNING_KEY_KIND = 'darkfinances-release-signing-key';
const SIGNING_KEY_SCHEMA_VERSION = 1;
const KEYRING_KIND = 'darkfinances-release-keyring';
const KEYRING_SCHEMA_VERSION = 1;
const ALGORITHM = 'ed25519';
const ED25519_SIGNATURE_BYTES = 64;
const PRODUCTION_MODES = new Set(['dashboard', 'ipa', 'ota', 'backup']);
const MAX_SIGNING_KEY_BYTES = 16 * 1024;
const MAX_KEYRING_BYTES = 256 * 1024;
const MAX_SIGNATURE_BYTES = 8 * 1024;
const MAX_FUTURE_SKEW_MS = 5 * 60 * 1000;
const BASE64_PATTERN = /^[A-Za-z0-9+/]+={0,2}$/;

const SIGNATURE_ENVELOPE_KEYS = new Set([
  'algorithm',
  'keyId',
  'kind',
  'manifestDigest',
  'schemaVersion',
  'signature',
  'signedAt',
]);

const KEYRING_ENTRY_KEYS = new Set([
  'algorithm',
  'keyId',
  'notAfter',
  'notBefore',
  'publicKeyPkcs8',
  'revokedAt',
]);

function signaturePathFor(manifestPath) {
  return `${path.resolve(manifestPath)}.sig.json`;
}

function isProductionMode(mode) {
  return PRODUCTION_MODES.has(mode);
}

function requiresProductionSignature(mode) {
  return isProductionMode(mode);
}

function canonicalIsoTimestamp(value, label) {
  const text = requireNonEmptyString(value, label);
  const date = new Date(text);
  if (Number.isNaN(date.getTime()) || date.toISOString() !== text) {
    throw new Error(`${label} must be a canonical ISO timestamp`);
  }
  return text;
}

function decodeStrictBase64(value, label, expectedBytes = null) {
  const text = requireNonEmptyString(value, label);
  if (Buffer.byteLength(text, 'utf8') > MAX_SIGNATURE_BYTES) {
    throw new Error(`${label} is out of bounds`);
  }
  if (!BASE64_PATTERN.test(text) || text.length % 4 !== 0) {
    throw new Error(`${label} is not canonical base64`);
  }
  const decoded = Buffer.from(text, 'base64');
  if (decoded.length === 0) throw new Error(`${label} is empty`);
  if (decoded.toString('base64') !== text) {
    throw new Error(`${label} is not canonical base64`);
  }
  if (expectedBytes != null && decoded.length !== expectedBytes) {
    throw new Error(`${label} has invalid length`);
  }
  return decoded;
}

function readTrustedSecretFile(filePath, options = {}, dependencies = {}) {
  return readTrustedRegularFile(filePath, options, dependencies);
}

function readTrustedManifestFile(manifestPath, options = {}, dependencies = {}) {
  return readTrustedRegularFile(manifestPath, {
    label: options.label || 'release manifest',
    maxBytes: options.maxBytes ?? MAX_MANIFEST_BYTES,
    allowedModes: options.allowedModes || [0o600, 0o644],
    validateStat: options.validateStat || null,
    preOpenValidate: options.preOpenValidate || null,
  }, dependencies);
}

function parseStrictJson(buffer, label) {
  let parsed;
  try {
    parsed = JSON.parse(buffer.toString('utf8'));
  } catch (error) {
    throw new Error(`${label} is not valid JSON: ${error.message}`);
  }
  assertPlainObject(parsed, label);
  return parsed;
}

function manifestDigest(manifest) {
  validateManifestEnvelope(manifest);
  return crypto.createHash('sha256')
    .update(Buffer.from(canonicalSerialize(manifest), 'utf8'))
    .digest('hex');
}

function signedPayload(envelopeWithoutSignature) {
  assertNoUnknownKeys(
    envelopeWithoutSignature,
    new Set(['algorithm', 'keyId', 'kind', 'manifestDigest', 'schemaVersion', 'signedAt']),
    'signature payload',
  );
  return Buffer.from(canonicalSerialize(envelopeWithoutSignature), 'utf8');
}

function loadSigningKey(filePath) {
  const { buffer, resolved } = readTrustedSecretFile(filePath, {
    label: 'release signing key',
    maxBytes: MAX_SIGNING_KEY_BYTES,
    allowedModes: [0o600],
  });
  const wrapper = parseStrictJson(buffer, 'release signing key');
  assertNoUnknownKeys(
    wrapper,
    new Set(['algorithm', 'keyId', 'kind', 'privateKeyPkcs8', 'schemaVersion']),
    'release signing key',
  );
  if (wrapper.kind !== SIGNING_KEY_KIND) {
    throw new Error(`unsupported signing key kind: ${wrapper.kind}`);
  }
  if (wrapper.schemaVersion !== SIGNING_KEY_SCHEMA_VERSION) {
    throw new Error(`unsupported signing key schemaVersion: ${wrapper.schemaVersion}`);
  }
  if (wrapper.algorithm !== ALGORITHM) throw new Error('signing key algorithm must be ed25519');
  const keyId = requireNonEmptyString(wrapper.keyId, 'signing key ID');
  const privateKeyPkcs8 = decodeStrictBase64(wrapper.privateKeyPkcs8, 'signing private key');
  let privateKey;
  try {
    privateKey = crypto.createPrivateKey({
      key: privateKeyPkcs8,
      format: 'der',
      type: 'pkcs8',
    });
  } catch (error) {
    throw new Error(`signing private key is invalid: ${error.message}`);
  }
  if (privateKey.asymmetricKeyType !== 'ed25519') {
    throw new Error('signing private key must be Ed25519');
  }
  return { keyId, privateKey, resolved };
}

function parseKeyringEntry(entry, label = 'keyring entry') {
  assertNoUnknownKeys(entry, KEYRING_ENTRY_KEYS, label);
  if (entry.algorithm !== ALGORITHM) throw new Error(`${label} algorithm must be ed25519`);
  const keyId = requireNonEmptyString(entry.keyId, `${label} keyId`);
  const notBefore = canonicalIsoTimestamp(entry.notBefore, `${label} notBefore`);
  const notAfter = canonicalIsoTimestamp(entry.notAfter, `${label} notAfter`);
  if (notBefore >= notAfter) throw new Error(`${label} notBefore must precede notAfter`);
  const revokedAt = entry.revokedAt == null
    ? null
    : canonicalIsoTimestamp(entry.revokedAt, `${label} revokedAt`);
  const publicKeyDer = decodeStrictBase64(entry.publicKeyPkcs8, `${label} public key`);
  let publicKey;
  try {
    publicKey = crypto.createPublicKey({
      key: publicKeyDer,
      format: 'der',
      type: 'spki',
    });
  } catch (error) {
    throw new Error(`${label} public key is invalid: ${error.message}`);
  }
  if (publicKey.asymmetricKeyType !== 'ed25519') {
    throw new Error(`${label} public key must be Ed25519`);
  }
  return { keyId, notBefore, notAfter, revokedAt, publicKey };
}

function loadKeyring(filePath) {
  const { buffer, resolved } = readTrustedSecretFile(filePath, {
    label: 'release keyring',
    maxBytes: MAX_KEYRING_BYTES,
    allowedModes: [0o600, 0o644],
  });
  const wrapper = parseStrictJson(buffer, 'release keyring');
  assertNoUnknownKeys(
    wrapper,
    new Set(['kind', 'keys', 'schemaVersion']),
    'release keyring',
  );
  if (wrapper.kind !== KEYRING_KIND) throw new Error(`unsupported keyring kind: ${wrapper.kind}`);
  if (wrapper.schemaVersion !== KEYRING_SCHEMA_VERSION) {
    throw new Error(`unsupported keyring schemaVersion: ${wrapper.schemaVersion}`);
  }
  if (!Array.isArray(wrapper.keys) || wrapper.keys.length === 0) {
    throw new Error('release keyring must contain at least one key');
  }
  const keys = wrapper.keys.map((entry, index) => parseKeyringEntry(entry, `keyring entry ${index}`));
  const ids = keys.map((entry) => entry.keyId);
  if (new Set(ids).size !== ids.length) throw new Error('release keyring contains duplicate key IDs');
  return { keys, resolved };
}

function selectKeyringEntry(keyring, keyId, signedAt, now = Date.now()) {
  const signedAtMs = Date.parse(signedAt);
  if (Number.isNaN(signedAtMs)) throw new Error('signature signedAt is invalid');
  if (signedAtMs - now > MAX_FUTURE_SKEW_MS) {
    throw new Error('signature signedAt is materially in the future');
  }
  const entry = keyring.keys.find((candidate) => candidate.keyId === keyId);
  if (!entry) throw new Error(`release signature keyId is unknown: ${keyId}`);
  const notBeforeMs = Date.parse(entry.notBefore);
  const notAfterMs = Date.parse(entry.notAfter);
  if (signedAtMs < notBeforeMs) throw new Error('signature signedAt precedes key validity');
  if (signedAtMs > notAfterMs) throw new Error('signature signedAt is outside key validity');
  if (now < notBeforeMs) throw new Error('release key is not yet valid');
  if (now > notAfterMs) throw new Error('release key is expired');
  if (entry.revokedAt != null) {
    const revokedAtMs = Date.parse(entry.revokedAt);
    if (signedAtMs >= revokedAtMs || now >= revokedAtMs) {
      throw new Error('release key is revoked');
    }
  }
  return entry;
}

function buildSignatureEnvelope(manifest, { keyId, privateKey, signedAt, clock = () => new Date() }) {
  const digest = manifestDigest(manifest);
  const envelope = {
    kind: SIGNATURE_KIND,
    schemaVersion: SIGNATURE_SCHEMA_VERSION,
    algorithm: ALGORITHM,
    keyId,
    signedAt: signedAt || new Date(clock()).toISOString(),
    manifestDigest: digest,
  };
  canonicalIsoTimestamp(envelope.signedAt, 'signature signedAt');
  const signature = crypto.sign(null, signedPayload(envelope), privateKey);
  return {
    ...envelope,
    signature: signature.toString('base64'),
  };
}

function validateSignatureEnvelope(envelope) {
  assertNoUnknownKeys(envelope, SIGNATURE_ENVELOPE_KEYS, 'release signature');
  if (envelope.kind !== SIGNATURE_KIND) throw new Error(`unsupported signature kind: ${envelope.kind}`);
  if (envelope.schemaVersion !== SIGNATURE_SCHEMA_VERSION) {
    throw new Error(`unsupported signature schemaVersion: ${envelope.schemaVersion}`);
  }
  if (envelope.algorithm !== ALGORITHM) throw new Error('signature algorithm must be ed25519');
  requireNonEmptyString(envelope.keyId, 'signature keyId');
  canonicalIsoTimestamp(envelope.signedAt, 'signature signedAt');
  validateHash(envelope.manifestDigest, 'signature manifestDigest');
  const signatureBuffer = decodeStrictBase64(
    envelope.signature,
    'signature value',
    ED25519_SIGNATURE_BYTES,
  );
  return {
    keyId: envelope.keyId,
    signedAt: envelope.signedAt,
    manifestDigest: envelope.manifestDigest,
    signatureBuffer,
    payload: signedPayload({
      kind: envelope.kind,
      schemaVersion: envelope.schemaVersion,
      algorithm: envelope.algorithm,
      keyId: envelope.keyId,
      signedAt: envelope.signedAt,
      manifestDigest: envelope.manifestDigest,
    }),
  };
}

function verifySignatureEnvelope(envelope, manifest, keyringPath, options = {}) {
  const parsed = validateSignatureEnvelope(envelope);
  const digest = manifestDigest(manifest);
  if (parsed.manifestDigest !== digest) {
    throw new Error('release signature manifestDigest mismatch');
  }
  const keyring = options.keyring || loadKeyring(keyringPath);
  const entry = selectKeyringEntry(
    keyring,
    parsed.keyId,
    parsed.signedAt,
    options.now ?? Date.now(),
  );
  const valid = crypto.verify(null, parsed.payload, entry.publicKey, parsed.signatureBuffer);
  if (!valid) throw new Error('release signature verification failed');
  return { keyId: parsed.keyId, manifestDigest: parsed.manifestDigest };
}

function readSignatureFile(manifestPath, label = 'release signature') {
  const signaturePath = signaturePathFor(manifestPath);
  if (!fs.existsSync(signaturePath)) {
    throw new Error(`release signature is missing: ${signaturePath}`);
  }
  const { buffer } = readTrustedSecretFile(signaturePath, {
    label,
    maxBytes: MAX_SIGNATURE_BYTES,
    allowedModes: [0o600, 0o644],
  });
  return parseStrictJson(buffer, label);
}

function verifySignedManifest(manifest, manifestPath, keyringPath, options = {}) {
  validateManifestEnvelope(manifest);
  const envelope = options.signatureEnvelope || readSignatureFile(manifestPath);
  return verifySignatureEnvelope(envelope, manifest, keyringPath, options);
}

function verifySignedManifestFile(manifestPath, keyringPath, options = {}, dependencies = {}) {
  const { buffer } = readTrustedManifestFile(manifestPath, options, dependencies);
  let manifest;
  try {
    manifest = JSON.parse(buffer.toString('utf8'));
  } catch (error) {
    throw new Error(`${options.label || 'release manifest'} is not valid JSON: ${error.message}`);
  }
  verifySignedManifest(manifest, manifestPath, keyringPath, options);
  return { manifest, buffer };
}

function resolveSigningPaths(options = {}, env = process.env) {
  const signingKeyPath = options.signingKeyPath
    || env.RELEASE_SIGNING_KEY_PATH
    || null;
  const keyringPath = options.keyringPath
    || env.RELEASE_KEYRING_PATH
    || null;
  return { signingKeyPath, keyringPath };
}

function requireSigningKeyPath(signingKeyPath, mode) {
  if (!signingKeyPath) {
    throw new Error(
      `production ${mode} release manifest generation requires RELEASE_SIGNING_KEY_PATH or --signing-key-path`,
    );
  }
  return signingKeyPath;
}

function requireKeyringPath(keyringPath, context = 'release manifest verification') {
  if (!keyringPath) {
    throw new Error(`${context} requires RELEASE_KEYRING_PATH or --keyring-path`);
  }
  return keyringPath;
}

function assertAllowUnsigned(mode, allowUnsigned) {
  if (allowUnsigned && isProductionMode(mode)) {
    throw new Error(`--allow-unsigned is forbidden for production mode ${mode}`);
  }
}

function verifyManifestEvidence(manifest, options = {}) {
  validateManifestEnvelope(manifest);
  const mode = manifest.content?.mode || 'source';
  const allowUnsigned = options.allowUnsigned === true;
  assertAllowUnsigned(mode, allowUnsigned);
  if (requiresProductionSignature(mode)) {
    const keyringPath = requireKeyringPath(
      options.keyringPath || resolveSigningPaths(options, options.env).keyringPath,
      `${mode} release manifest verification`,
    );
    if (!options.manifestPath) {
      throw new Error('release manifest verification requires a manifest path for signature lookup');
    }
    return verifySignedManifest(manifest, options.manifestPath, keyringPath, options);
  }
  if (allowUnsigned) return true;
  return true;
}

function capturePublishedPair(destination) {
  const signatureDestination = signaturePathFor(destination);
  const readSnapshot = (filePath, snapshotLabel) => {
    if (!fs.existsSync(filePath)) return null;
    const { buffer, mode } = readTrustedRegularFile(filePath, {
      label: snapshotLabel,
      maxBytes: MAX_MANIFEST_BYTES,
      allowedModes: [0o600, 0o644],
    });
    return { bytes: buffer, mode };
  };
  return {
    manifest: readSnapshot(destination, 'published manifest snapshot'),
    signature: readSnapshot(signatureDestination, 'published signature snapshot'),
  };
}

function restorePublishedPair(destination, prior) {
  const signatureDestination = signaturePathFor(destination);
  const writeSnapshot = (filePath, snapshot) => {
    if (!snapshot) {
      if (fs.existsSync(filePath)) fs.rmSync(filePath, { force: true });
      return;
    }
    fs.writeFileSync(filePath, snapshot.bytes, { mode: snapshot.mode });
  };
  writeSnapshot(destination, prior.manifest);
  writeSnapshot(signatureDestination, prior.signature);
}

function fsyncFilePath(filePath) {
  const fd = fs.openSync(filePath, fs.constants.O_RDONLY);
  try {
    fs.fsyncSync(fd);
  } finally {
    fs.closeSync(fd);
  }
}

function fsyncDirectory(dir) {
  const fd = fs.openSync(dir, fs.constants.O_RDONLY | (fs.constants.O_DIRECTORY || 0));
  try {
    fs.fsyncSync(fd);
  } finally {
    fs.closeSync(fd);
  }
}

function publishSignedManifestPair(destination, manifest, signingKeyPath, dependencies = {}) {
  const signingKey = loadSigningKey(signingKeyPath);
  const envelope = buildSignatureEnvelope(manifest, {
    keyId: signingKey.keyId,
    privateKey: signingKey.privateKey,
    clock: dependencies.clock,
  });
  writeManifestAndSignatureAtomic(destination, manifest, envelope, dependencies);
  return { destination, signaturePath: signaturePathFor(destination), keyId: signingKey.keyId };
}

function writeManifestAndSignatureAtomic(destination, manifest, envelope, dependencies = {}) {
  const dir = path.dirname(destination);
  fs.mkdirSync(dir, { recursive: true, mode: 0o700 });
  const signatureDestination = signaturePathFor(destination);
  const prior = capturePublishedPair(destination);
  const manifestTemp = path.join(
    dir,
    `.${path.basename(destination)}.${process.pid}.${crypto.randomBytes(8).toString('hex')}.manifest.tmp`,
  );
  const signatureTemp = path.join(
    dir,
    `.${path.basename(signatureDestination)}.${process.pid}.${crypto.randomBytes(8).toString('hex')}.sig.tmp`,
  );
  const injectFault = dependencies.injectFault;
  const noFollow = fs.constants.O_NOFOLLOW;
  if (!noFollow) {
    throw new Error('atomic signed-manifest writes require O_NOFOLLOW support on this platform');
  }
  let manifestDescriptor;
  let signatureDescriptor;
  try {
    manifestDescriptor = fs.openSync(
      manifestTemp,
      fs.constants.O_WRONLY | fs.constants.O_CREAT | fs.constants.O_EXCL | noFollow,
      0o600,
    );
    fs.writeFileSync(manifestDescriptor, `${JSON.stringify(manifest, null, 2)}\n`);
    fs.fsyncSync(manifestDescriptor);
    fs.closeSync(manifestDescriptor);
    manifestDescriptor = undefined;

    signatureDescriptor = fs.openSync(
      signatureTemp,
      fs.constants.O_WRONLY | fs.constants.O_CREAT | fs.constants.O_EXCL | noFollow,
      0o600,
    );
    fs.writeFileSync(signatureDescriptor, `${JSON.stringify(envelope, null, 2)}\n`);
    fs.fsyncSync(signatureDescriptor);
    fs.closeSync(signatureDescriptor);
    signatureDescriptor = undefined;

    injectFault?.('before:manifest-rename', destination);
    fs.renameSync(manifestTemp, destination);
    injectFault?.('before:signature-rename', signatureDestination);
    fs.renameSync(signatureTemp, signatureDestination);
    fsyncFilePath(destination);
    fsyncFilePath(signatureDestination);
    fsyncDirectory(dir);
  } catch (error) {
    restorePublishedPair(destination, prior);
    throw error;
  } finally {
    if (manifestDescriptor !== undefined) fs.closeSync(manifestDescriptor);
    if (signatureDescriptor !== undefined) fs.closeSync(signatureDescriptor);
    for (const temp of [manifestTemp, signatureTemp]) {
      try {
        fs.rmSync(temp, { force: true });
      } catch {
        // best-effort
      }
    }
  }
}

function generateSigningMaterial({
  keyId = crypto.randomUUID(),
  notBefore = new Date().toISOString(),
  notAfter = new Date(Date.now() + (365 * 24 * 60 * 60 * 1000)).toISOString(),
} = {}) {
  const { publicKey, privateKey } = crypto.generateKeyPairSync('ed25519');
  const privateKeyPkcs8 = privateKey.export({ format: 'der', type: 'pkcs8' }).toString('base64');
  const publicKeyPkcs8 = publicKey.export({ format: 'der', type: 'spki' }).toString('base64');
  canonicalIsoTimestamp(notBefore, 'key notBefore');
  canonicalIsoTimestamp(notAfter, 'key notAfter');
  const signingKey = {
    kind: SIGNING_KEY_KIND,
    schemaVersion: SIGNING_KEY_SCHEMA_VERSION,
    keyId,
    algorithm: ALGORITHM,
    privateKeyPkcs8,
  };
  const keyring = {
    kind: KEYRING_KIND,
    schemaVersion: KEYRING_SCHEMA_VERSION,
    keys: [{
      keyId,
      algorithm: ALGORITHM,
      publicKeyPkcs8,
      notBefore,
      notAfter,
    }],
  };
  return { keyId, signingKey, keyring };
}

function writeKeyMaterialAtomic(outputDir, material, dependencies = {}) {
  const resolvedDir = path.resolve(outputDir);
  if (fs.existsSync(resolvedDir)) {
    const existing = fs.readdirSync(resolvedDir);
    if (existing.length > 0) {
      throw new Error('refusing to write release signing material into a non-empty directory; use a new directory for rotation');
    }
  }
  const parentDir = path.dirname(resolvedDir);
  fs.mkdirSync(parentDir, { recursive: true, mode: 0o700 });
  const stagingDir = path.join(
    parentDir,
    `.${path.basename(resolvedDir)}.${process.pid}.${crypto.randomBytes(8).toString('hex')}.staging`,
  );
  const injectFault = dependencies.injectFault;
  try {
    fs.mkdirSync(stagingDir, { mode: 0o700 });
    const signingPath = path.join(stagingDir, 'release-signing-key.json');
    const keyringPath = path.join(stagingDir, 'release-keyring.json');
    const writeJson = (target, payload) => {
      const temp = `${target}.tmp-${process.pid}-${Date.now()}`;
      fs.writeFileSync(temp, `${JSON.stringify(payload, null, 2)}\n`, { mode: 0o600 });
      fsyncFilePath(temp);
      fs.renameSync(temp, target);
      fs.chmodSync(target, 0o600);
      fsyncFilePath(target);
    };
    writeJson(signingPath, material.signingKey);
    injectFault?.('before:keyring-write', keyringPath);
    writeJson(keyringPath, material.keyring);
    injectFault?.('before:staging-rename', resolvedDir);
    fs.renameSync(stagingDir, resolvedDir);
    fsyncDirectory(resolvedDir);
    try {
      fs.chmodSync(resolvedDir, 0o700);
    } catch {
      // best-effort
    }
  } catch (error) {
    try {
      fs.rmSync(stagingDir, { recursive: true, force: true });
    } catch {
      // best-effort
    }
    throw error;
  }
  return {
    signingPath: path.join(resolvedDir, 'release-signing-key.json'),
    keyringPath: path.join(resolvedDir, 'release-keyring.json'),
    keyId: material.keyId,
  };
}

module.exports = {
  ALGORITHM,
  ED25519_SIGNATURE_BYTES,
  KEYRING_KIND,
  MAX_FUTURE_SKEW_MS,
  PRODUCTION_MODES,
  SIGNATURE_KIND,
  SIGNATURE_SCHEMA_VERSION,
  SIGNING_KEY_KIND,
  assertAllowUnsigned,
  buildSignatureEnvelope,
  capturePublishedPair,
  decodeStrictBase64,
  generateSigningMaterial,
  isProductionMode,
  loadKeyring,
  loadSigningKey,
  manifestDigest,
  publishSignedManifestPair,
  MAX_MANIFEST_BYTES,
  readTrustedManifestFile,
  readTrustedRegularFile,
  readTrustedSecretFile,
  readSignatureFile,
  requireKeyringPath,
  requireSigningKeyPath,
  requiresProductionSignature,
  resolveSigningPaths,
  restorePublishedPair,
  selectKeyringEntry,
  signaturePathFor,
  validateSignatureEnvelope,
  verifyManifestEvidence,
  verifySignatureEnvelope,
  verifySignedManifest,
  verifySignedManifestFile,
  writeKeyMaterialAtomic,
  writeManifestAndSignatureAtomic,
};
