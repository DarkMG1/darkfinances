'use strict';

const fs = require('fs');
const crypto = require('crypto');
const path = require('path');

const PEM_PRIVATE_HEADER = '-----BEGIN PRIVATE KEY-----';
const PEM_PUBLIC_HEADER = '-----BEGIN PUBLIC KEY-----';

function assertTrustedKeyFile(keyPath, label = 'coordinator key') {
  if (!keyPath || typeof keyPath !== 'string') {
    throw new Error(`${label} path is required`);
  }
  const resolved = path.resolve(keyPath);
  const stat = fs.lstatSync(resolved);
  if (stat.isSymbolicLink()) throw new Error(`${label} must not be a symbolic link`);
  if (!stat.isFile()) throw new Error(`${label} must be a regular file`);
  if (process.platform !== 'win32' && typeof process.getuid === 'function' && stat.uid !== process.getuid()) {
    throw new Error(`${label} ownership mismatch`);
  }
  if ((stat.mode & 0o777) !== 0o600) {
    throw new Error(`${label} mode must be 0600`);
  }
  return resolved;
}

function loadPrivateKey(keyPath) {
  const resolved = assertTrustedKeyFile(keyPath, 'coordinator signing key');
  const keyObject = crypto.createPrivateKey(fs.readFileSync(resolved, 'utf8'));
  if (keyObject.asymmetricKeyType !== 'ed25519') {
    throw new Error('coordinator signing key must be Ed25519');
  }
  return keyObject;
}

function loadPublicKey(keyPath) {
  const resolved = assertTrustedKeyFile(keyPath, 'coordinator verification key');
  const pem = fs.readFileSync(resolved, 'utf8');
  if (!pem.includes(PEM_PUBLIC_HEADER) && !pem.includes(PEM_PRIVATE_HEADER)) {
    throw new Error('coordinator verification key must be PEM encoded');
  }
  const keyObject = crypto.createPublicKey(pem);
  if (keyObject.asymmetricKeyType !== 'ed25519') {
    throw new Error('coordinator verification key must be Ed25519');
  }
  return keyObject;
}

function resolveVerificationKey(env = process.env) {
  const publicPath = env.COORDINATED_VERIFY_KEY_PATH
    || env.COORDINATED_PUBLIC_KEY_PATH
    || path.join(env.HOME || '', '.config', 'darkfinances', 'coordinated-verify.pem');
  if (!fs.existsSync(publicPath)) {
    throw new Error(`coordinator verification key not found: ${publicPath}`);
  }
  return loadPublicKey(publicPath);
}

function resolveSigningKey(env = process.env) {
  const privatePath = env.COORDINATED_SIGNING_KEY_PATH
    || path.join(env.HOME || '', '.config', 'darkfinances', 'coordinated-sign.pem');
  if (!fs.existsSync(privatePath)) {
    throw new Error(`coordinator signing key not found: ${privatePath}`);
  }
  return loadPrivateKey(privatePath);
}

function signPayload(privateKey, canonicalPayload) {
  return crypto.sign(null, Buffer.from(`${canonicalPayload}\n`, 'utf8'), privateKey).toString('base64');
}

function verifySignature(publicKey, canonicalPayload, signatureBase64) {
  if (typeof signatureBase64 !== 'string' || !signatureBase64) return false;
  try {
    return crypto.verify(
      null,
      Buffer.from(`${canonicalPayload}\n`, 'utf8'),
      publicKey,
      Buffer.from(signatureBase64, 'base64'),
    );
  } catch {
    return false;
  }
}

function generateTestKeyPair() {
  return crypto.generateKeyPairSync('ed25519');
}

function exportPublicKeyPem(publicKey) {
  return publicKey.export({ type: 'spki', format: 'pem' });
}

function exportPrivateKeyPem(privateKey) {
  return privateKey.export({ type: 'pkcs8', format: 'pem' });
}

module.exports = {
  assertTrustedKeyFile,
  loadPrivateKey,
  loadPublicKey,
  resolveVerificationKey,
  resolveSigningKey,
  signPayload,
  verifySignature,
  generateTestKeyPair,
  exportPublicKeyPem,
  exportPrivateKeyPem,
};
