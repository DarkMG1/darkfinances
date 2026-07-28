'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const crypto = require('crypto');
const fs = require('fs');
const os = require('os');
const path = require('path');
const { spawnSync } = require('child_process');
const {
  buildSignatureEnvelope,
  decodeStrictBase64,
  generateSigningMaterial,
  loadKeyring,
  loadSigningKey,
  manifestDigest,
  readSignatureFile,
  readTrustedSecretFile,
  signaturePathFor,
  validateSignatureEnvelope,
  verifyManifestEvidence,
  verifySignatureEnvelope,
  verifySignedManifest,
  writeKeyMaterialAtomic,
  writeManifestAndSignatureAtomic,
} = require('../../finance-dashboard/lib/release-signing');
const {
  buildManifest,
  main,
  sha256Canonical,
  verifyManifest,
} = require('../../scripts/release-manifest');
const { createEphemeralSigningMaterial, writeSignedManifest, writeSignedReleaseEvidence } = require('./helpers/release-signing-fixtures');

const REPOSITORY_ROOT = path.resolve(__dirname, '..', '..');
const temporaryDirectories = [];

test.after(() => {
  for (const directory of temporaryDirectories) {
    fs.rmSync(directory, { recursive: true, force: true });
  }
});

function tempDir(prefix) {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), prefix));
  temporaryDirectories.push(directory);
  return directory;
}

function fixtureManifest(options = {}) {
  return buildManifest({
    root: REPOSITORY_ROOT,
    mode: 'source',
    ...options,
  }, {
    root: REPOSITORY_ROOT,
    clock: () => new Date('2026-07-01T00:00:00.000Z'),
    resolveAppConfig: () => ({
      version: '1.2.0',
      runtimeVersion: { policy: 'appVersion' },
      updates: { requestHeaders: { 'expo-channel-name': 'production' } },
      ios: { buildNumber: '5' },
    }),
  });
}

test('ephemeral Ed25519 round trip signs and verifies production manifest', () => {
  const root = tempDir('release-signing-roundtrip-');
  const signing = createEphemeralSigningMaterial(root);
  const manifest = fixtureManifest();
  const destination = path.join(root, 'build', 'release.json');
  writeSignedManifest(destination, manifest, signing.signingPath, signing.keyringPath);
  const parsed = JSON.parse(fs.readFileSync(destination, 'utf8'));
  verifySignedManifest(parsed, destination, signing.keyringPath);
  assert.equal(fs.existsSync(signaturePathFor(destination)), true);
});

test('unsigned production destination generation is rejected', () => {
  const root = tempDir('release-signing-unsigned-prod-');
  const manifestPath = path.join(root, 'build', 'dashboard.json');
  const result = spawnSync(process.execPath, [
    path.join(REPOSITORY_ROOT, 'scripts/release-manifest.js'),
    `--root=${REPOSITORY_ROOT}`,
    '--mode=dashboard',
    `--deployed-root=${REPOSITORY_ROOT}/finance-dashboard`,
    manifestPath,
  ], { encoding: 'utf8' });
  assert.equal(result.status, 1);
  assert.match(result.stderr, /RELEASE_SIGNING_KEY_PATH|signing-key-path/);
});

test('source-only unsigned generation requires explicit allow flag', () => {
  const root = tempDir('release-signing-source-unsigned-');
  const destination = path.join(root, 'build', 'source.json');
  const blocked = spawnSync(process.execPath, [
    path.join(REPOSITORY_ROOT, 'scripts/release-manifest.js'),
    `--root=${REPOSITORY_ROOT}`,
    '--mode=source',
    destination,
  ], { encoding: 'utf8' });
  assert.equal(blocked.status, 1);
  assert.match(blocked.stderr, /allow-unsigned/);

  const allowedEnv = { ...process.env };
  delete allowedEnv.RELEASE_SIGNING_KEY_PATH;
  delete allowedEnv.RELEASE_KEYRING_PATH;
  const allowed = spawnSync(process.execPath, [
    path.join(REPOSITORY_ROOT, 'scripts/release-manifest.js'),
    `--root=${REPOSITORY_ROOT}`,
    '--mode=source',
    '--allow-unsigned',
    destination,
  ], { encoding: 'utf8', env: allowedEnv });
  assert.equal(allowed.status, 0, allowed.stderr);
  assert.equal(fs.existsSync(signaturePathFor(destination)), false);
});

test('--allow-unsigned is rejected for production backup mode', () => {
  const root = tempDir('release-signing-disallow-unsigned-');
  const backupManifest = path.join(root, 'backup.manifest.json');
  const backupArchive = path.join(root, 'backup.tgz');
  fs.mkdirSync(root, { recursive: true });
  fs.writeFileSync(backupManifest, '{}\n');
  fs.writeFileSync(backupArchive, 'archive\n');
  const result = spawnSync(process.execPath, [
    path.join(REPOSITORY_ROOT, 'scripts/release-manifest.js'),
    `--root=${REPOSITORY_ROOT}`,
    '--mode=backup',
    '--allow-unsigned',
    `--backup-manifest=${backupManifest}`,
    `--backup-archive=${backupArchive}`,
    path.join(root, 'out.json'),
  ], { encoding: 'utf8' });
  assert.equal(result.status, 1);
  assert.match(result.stderr, /forbidden for production mode backup|requires RELEASE_SIGNING_KEY_PATH/);
});

test('tampered manifest content, digest, signature, and envelope fail verification', () => {
  const root = tempDir('release-signing-tamper-');
  const signing = createEphemeralSigningMaterial(root);
  const manifest = fixtureManifest();
  const destination = path.join(root, 'manifest.json');
  writeSignedManifest(destination, manifest, signing.signingPath, signing.keyringPath);

  const tamperedContent = JSON.parse(fs.readFileSync(destination, 'utf8'));
  tamperedContent.content.app.version = '9.9.9';
  fs.writeFileSync(destination, `${JSON.stringify(tamperedContent, null, 2)}\n`);
  assert.throws(
    () => verifySignedManifest(tamperedContent, destination, signing.keyringPath),
    /manifestDigest mismatch|content digest mismatch/,
  );

  writeSignedManifest(destination, manifest, signing.signingPath, signing.keyringPath);
  const tamperedDigest = JSON.parse(fs.readFileSync(destination, 'utf8'));
  tamperedDigest.contentDigest.value = 'f'.repeat(64);
  fs.writeFileSync(destination, `${JSON.stringify(tamperedDigest, null, 2)}\n`);
  assert.throws(
    () => verifySignedManifest(tamperedDigest, destination, signing.keyringPath),
    /content digest mismatch|manifestDigest mismatch/,
  );

  writeSignedManifest(destination, manifest, signing.signingPath, signing.keyringPath);
  const envelope = readSignatureFile(destination);
  const bytes = Buffer.from(envelope.signature, 'base64');
  bytes[0] ^= 0xff;
  envelope.signature = bytes.toString('base64');
  fs.writeFileSync(signaturePathFor(destination), `${JSON.stringify(envelope, null, 2)}\n`);
  assert.throws(
    () => verifySignedManifest(JSON.parse(fs.readFileSync(destination, 'utf8')), destination, signing.keyringPath),
    /verification failed/,
  );

  writeSignedManifest(destination, manifest, signing.signingPath, signing.keyringPath);
  const badEnvelope = readSignatureFile(destination);
  badEnvelope.extra = 'not-allowed';
  fs.writeFileSync(signaturePathFor(destination), `${JSON.stringify(badEnvelope, null, 2)}\n`);
  assert.throws(
    () => verifySignedManifest(JSON.parse(fs.readFileSync(destination, 'utf8')), destination, signing.keyringPath),
    /unsupported field/,
  );
});

test('signature transplant onto different manifest fails', () => {
  const root = tempDir('release-signing-transplant-');
  const signing = createEphemeralSigningMaterial(root);
  const first = fixtureManifest();
  const second = structuredClone(first);
  second.builtAt = '2026-07-02T00:00:00.000Z';
  second.contentDigest.value = sha256Canonical(second.content);
  const firstPath = path.join(root, 'first.json');
  const secondPath = path.join(root, 'second.json');
  writeSignedManifest(firstPath, first, signing.signingPath, signing.keyringPath);
  fs.writeFileSync(secondPath, `${JSON.stringify(second, null, 2)}\n`, { mode: 0o600 });
  fs.copyFileSync(signaturePathFor(firstPath), signaturePathFor(secondPath));
  assert.throws(
    () => verifySignedManifest(second, secondPath, signing.keyringPath),
    /manifestDigest mismatch|content digest mismatch/,
  );
});

test('unknown, wrong, expired, not-yet-valid, and revoked keys fail verification', () => {
  const root = tempDir('release-signing-key-states-');
  const signing = createEphemeralSigningMaterial(root);
  const manifest = fixtureManifest();
  const destination = path.join(root, 'manifest.json');
  writeSignedManifest(destination, manifest, signing.signingPath, signing.keyringPath);
  const envelope = readSignatureFile(destination);
  envelope.keyId = crypto.randomUUID();
  assert.throws(
    () => verifySignatureEnvelope(envelope, manifest, signing.keyringPath),
    /unknown/,
  );

  const other = createEphemeralSigningMaterial(path.join(root, 'other-keys'));
  assert.throws(
    () => verifySignatureEnvelope(readSignatureFile(destination), manifest, other.keyringPath),
    /verification failed|unknown/,
  );

  const expired = generateSigningMaterial({
    notBefore: '2020-01-01T00:00:00.000Z',
    notAfter: '2020-01-02T00:00:00.000Z',
  });
  const expiredDir = path.join(root, 'expired');
  const expiredPaths = writeKeyMaterialAtomic(expiredDir, expired);
  const expiredManifest = path.join(root, 'expired-manifest.json');
  writeSignedManifest(
    expiredManifest,
    manifest,
    expiredPaths.signingPath,
    expiredPaths.keyringPath,
    {
      signedAt: '2020-01-01T12:00:00.000Z',
      now: Date.parse('2020-01-01T12:00:00.000Z'),
    },
  );
  assert.throws(
    () => verifySignedManifest(
      JSON.parse(fs.readFileSync(expiredManifest, 'utf8')),
      expiredManifest,
      expiredPaths.keyringPath,
      { now: Date.parse('2026-01-01T00:00:00.000Z') },
    ),
    /expired|outside key validity/,
  );

  const future = generateSigningMaterial({
    notBefore: '2090-01-01T00:00:00.000Z',
    notAfter: '2099-01-01T00:00:00.000Z',
  });
  const futureDir = path.join(root, 'future');
  const futurePaths = writeKeyMaterialAtomic(futureDir, future);
  const futureManifest = path.join(root, 'future-manifest.json');
  fs.writeFileSync(futureManifest, `${JSON.stringify(manifest, null, 2)}\n`, { mode: 0o600 });
  const futureSigningKey = loadSigningKey(futurePaths.signingPath);
  const futureEnvelope = buildSignatureEnvelope(manifest, {
    keyId: futureSigningKey.keyId,
    privateKey: futureSigningKey.privateKey,
    signedAt: '2090-06-01T00:00:00.000Z',
  });
  writeManifestAndSignatureAtomic(futureManifest, manifest, futureEnvelope);
  assert.throws(
    () => verifySignedManifest(
      JSON.parse(fs.readFileSync(futureManifest, 'utf8')),
      futureManifest,
      futurePaths.keyringPath,
      { now: Date.parse('2026-01-01T00:00:00.000Z') },
    ),
    /not yet valid|outside key validity|materially in the future/,
  );

  const revokedMaterial = generateSigningMaterial({
    notBefore: '2020-01-01T00:00:00.000Z',
    notAfter: '2099-01-01T00:00:00.000Z',
  });
  revokedMaterial.keyring.keys[0].revokedAt = '2025-01-01T00:00:00.000Z';
  const revokedDir = path.join(root, 'revoked');
  const revokedPaths = writeKeyMaterialAtomic(revokedDir, revokedMaterial);
  const revokedManifest = path.join(root, 'revoked-manifest.json');
  writeSignedManifest(
    revokedManifest,
    manifest,
    revokedPaths.signingPath,
    revokedPaths.keyringPath,
    {
      signedAt: '2024-01-01T00:00:00.000Z',
      now: Date.parse('2024-01-01T00:00:00.000Z'),
    },
  );
  assert.throws(
    () => verifySignedManifest(
      JSON.parse(fs.readFileSync(revokedManifest, 'utf8')),
      revokedManifest,
      revokedPaths.keyringPath,
      { now: Date.parse('2026-01-01T00:00:00.000Z') },
    ),
    /revoked/,
  );
});

test('signedAt materially in the future is rejected', () => {
  const root = tempDir('release-signing-future-');
  const signing = createEphemeralSigningMaterial(root);
  const manifest = fixtureManifest();
  const signingKey = loadSigningKey(signing.signingPath);
  const envelope = buildSignatureEnvelope(manifest, {
    keyId: signingKey.keyId,
    privateKey: signingKey.privateKey,
    signedAt: '2099-01-01T00:00:00.000Z',
  });
  assert.throws(
    () => verifySignatureEnvelope(envelope, manifest, signing.keyringPath, {
      now: Date.parse('2026-01-01T00:00:00.000Z'),
    }),
    /future/,
  );
});

test('key rotation with overlapping keys verifies historical signatures', () => {
  const root = tempDir('release-signing-rotation-');
  const first = generateSigningMaterial({
    keyId: 'key-one',
    notBefore: '2020-01-01T00:00:00.000Z',
    notAfter: '2026-06-01T00:00:00.000Z',
  });
  const second = generateSigningMaterial({
    keyId: 'key-two',
    notBefore: '2026-01-01T00:00:00.000Z',
    notAfter: '2099-01-01T00:00:00.000Z',
  });
  const keyring = {
    kind: 'darkfinances-release-keyring',
    schemaVersion: 1,
    keys: [first.keyring.keys[0], second.keyring.keys[0]],
  };
  const keyringPath = path.join(root, 'rotation-keyring.json');
  fs.mkdirSync(root, { recursive: true, mode: 0o700 });
  fs.writeFileSync(keyringPath, `${JSON.stringify(keyring, null, 2)}\n`, { mode: 0o644 });

  const manifest = fixtureManifest();
  const destination = path.join(root, 'rotated.json');
  const firstSigningPath = path.join(root, 'first-signing.json');
  fs.writeFileSync(firstSigningPath, `${JSON.stringify(first.signingKey, null, 2)}\n`, { mode: 0o600 });
  writeSignedManifest(destination, manifest, firstSigningPath, keyringPath, {
    signedAt: '2026-03-01T00:00:00.000Z',
    now: Date.parse('2026-03-01T00:00:00.000Z'),
  });
  verifySignedManifest(JSON.parse(fs.readFileSync(destination, 'utf8')), destination, keyringPath, {
    now: Date.parse('2026-03-01T00:00:00.000Z'),
  });

  const secondSigningPath = path.join(root, 'second-signing.json');
  fs.writeFileSync(secondSigningPath, `${JSON.stringify(second.signingKey, null, 2)}\n`, { mode: 0o600 });
  writeSignedManifest(destination, manifest, secondSigningPath, keyringPath, {
    signedAt: '2026-07-01T00:00:00.000Z',
    now: Date.parse('2026-07-01T00:00:00.000Z'),
  });
  verifySignedManifest(JSON.parse(fs.readFileSync(destination, 'utf8')), destination, keyringPath, {
    now: Date.parse('2026-07-01T00:00:00.000Z'),
  });
});

test('symlink, hardlink, wrong mode, and replacement trusted files are rejected', {
  skip: process.platform === 'win32' ? 'POSIX-specific file semantics' : false,
}, () => {
  const root = tempDir('release-signing-trusted-file-');
  const signing = createEphemeralSigningMaterial(root);
  fs.chmodSync(signing.signingPath, 0o644);
  assert.throws(() => loadSigningKey(signing.signingPath), /permissions must be 600/);

  fs.chmodSync(signing.signingPath, 0o600);
  const linkTarget = path.join(root, 'linked-key.json');
  fs.linkSync(signing.signingPath, linkTarget);
  assert.throws(() => loadSigningKey(linkTarget), /hard-linked/);

  const symlink = path.join(root, 'symlink-key.json');
  fs.symlinkSync(signing.signingPath, symlink);
  assert.throws(() => loadSigningKey(symlink), /symbolic link/);
});

test('missing sibling signature fails verification', () => {
  const root = tempDir('release-signing-missing-sig-');
  const signing = createEphemeralSigningMaterial(root);
  const manifest = buildManifest({
    root: REPOSITORY_ROOT,
    mode: 'dashboard',
    deployedRoot: path.join(REPOSITORY_ROOT, 'finance-dashboard'),
  }, {
    root: REPOSITORY_ROOT,
    clock: () => new Date('2026-07-01T00:00:00.000Z'),
    resolveAppConfig: () => ({
      version: '1.2.0',
      runtimeVersion: { policy: 'appVersion' },
      updates: { requestHeaders: { 'expo-channel-name': 'production' } },
      ios: { buildNumber: '5' },
    }),
  });
  const destination = path.join(root, 'manifest.json');
  fs.writeFileSync(destination, `${JSON.stringify(manifest, null, 2)}\n`, { mode: 0o600 });
  assert.throws(
    () => verifyManifest(manifest, { manifestPath: destination, keyringPath: signing.keyringPath }),
    /release signature is missing/,
  );
});

test('atomic publication preserves prior committed pair on partial rewrite failure', () => {
  const root = tempDir('release-signing-atomic-');
  const signing = createEphemeralSigningMaterial(root);
  const manifest = fixtureManifest();
  const destination = path.join(root, 'manifest.json');
  writeSignedManifest(destination, manifest, signing.signingPath, signing.keyringPath);
  const priorManifest = fs.readFileSync(destination, 'utf8');
  const priorSignature = fs.readFileSync(signaturePathFor(destination), 'utf8');

  const signingKey = loadSigningKey(signing.signingPath);
  const validEnvelope = buildSignatureEnvelope(manifest, {
    keyId: signingKey.keyId,
    privateKey: signingKey.privateKey,
  });
  const nextManifest = structuredClone(manifest);
  nextManifest.display.repository.branch = 'feature/test';
  nextManifest.contentDigest.value = sha256Canonical(nextManifest.content);
  fs.writeFileSync(destination, `${JSON.stringify(nextManifest, null, 2)}\n`, { mode: 0o600 });
  fs.writeFileSync(signaturePathFor(destination), `${JSON.stringify(validEnvelope, null, 2)}\n`, { mode: 0o600 });
  assert.throws(
    () => verifySignedManifest(nextManifest, destination, signing.keyringPath),
    /manifestDigest mismatch/,
  );
  fs.writeFileSync(destination, priorManifest, { mode: 0o600 });
  fs.writeFileSync(signaturePathFor(destination), priorSignature, { mode: 0o600 });
  verifySignedManifest(JSON.parse(priorManifest), destination, signing.keyringPath);
});

test('malformed and duplicate keyring entries are rejected', () => {
  const root = tempDir('release-signing-keyring-shape-');
  const valid = generateSigningMaterial();
  const keyringPath = path.join(root, 'bad-keyring.json');
  fs.mkdirSync(root, { recursive: true, mode: 0o700 });
  fs.writeFileSync(keyringPath, `${JSON.stringify({
    kind: 'darkfinances-release-keyring',
    schemaVersion: 1,
    keys: [valid.keyring.keys[0], { ...valid.keyring.keys[0], keyId: valid.keyId }],
  }, null, 2)}\n`, { mode: 0o644 });
  assert.throws(() => loadKeyring(keyringPath), /duplicate key IDs/);
});

test('verifyManifestEvidence requires keyring, manifest path, and sibling signature for production modes', () => {
  const root = tempDir('release-signing-evidence-');
  const signing = createEphemeralSigningMaterial(root);
  const manifest = buildManifest({
    root: REPOSITORY_ROOT,
    mode: 'dashboard',
    deployedRoot: path.join(REPOSITORY_ROOT, 'finance-dashboard'),
  }, {
    root: REPOSITORY_ROOT,
    clock: () => new Date('2026-07-01T00:00:00.000Z'),
    resolveAppConfig: () => ({
      version: '1.2.0',
      runtimeVersion: { policy: 'appVersion' },
      updates: { requestHeaders: { 'expo-channel-name': 'production' } },
      ios: { buildNumber: '5' },
    }),
  });
  const destination = path.join(root, 'dashboard.json');
  writeSignedManifest(destination, manifest, signing.signingPath, signing.keyringPath);
  const parsed = JSON.parse(fs.readFileSync(destination, 'utf8'));
  assert.ok(verifyManifestEvidence(parsed, {
    manifestPath: destination,
    keyringPath: signing.keyringPath,
  }));
  assert.throws(
    () => verifyManifestEvidence(parsed, { manifestPath: destination, env: {} }),
    /RELEASE_KEYRING_PATH|keyring/i,
  );
  assert.throws(
    () => verifyManifestEvidence(parsed, { keyringPath: signing.keyringPath, env: {} }),
    /manifest path/i,
  );
  fs.rmSync(signaturePathFor(destination), { force: true });
  assert.throws(
    () => verifyManifestEvidence(parsed, {
      manifestPath: destination,
      keyringPath: signing.keyringPath,
      env: {},
    }),
    /release signature is missing/,
  );
});

test('capturePublishedPair aborts publication when existing manifest leg is unreadable', {
  skip: process.platform === 'win32' ? 'POSIX symlink semantics' : false,
}, () => {
  const root = tempDir('release-signing-capture-abort-');
  const signing = createEphemeralSigningMaterial(root);
  const manifest = fixtureManifest();
  const destination = path.join(root, 'manifest.json');
  writeSignedManifest(destination, manifest, signing.signingPath, signing.keyringPath);
  const priorManifest = fs.readFileSync(destination, 'utf8');
  const priorSignature = fs.readFileSync(signaturePathFor(destination), 'utf8');

  const realManifest = path.join(root, 'real-manifest.json');
  fs.renameSync(destination, realManifest);
  fs.symlinkSync(realManifest, destination);

  const signingKey = loadSigningKey(signing.signingPath);
  const nextManifest = structuredClone(manifest);
  nextManifest.display.repository.branch = 'feature/capture-abort';
  nextManifest.contentDigest.value = sha256Canonical(nextManifest.content);
  assert.throws(
    () => writeManifestAndSignatureAtomic(destination, nextManifest, buildSignatureEnvelope(nextManifest, {
      keyId: signingKey.keyId,
      privateKey: signingKey.privateKey,
    })),
    /symbolic link|published manifest snapshot/,
  );
  assert.equal(fs.readlinkSync(destination), realManifest);
  assert.equal(fs.readFileSync(realManifest, 'utf8'), priorManifest);
  assert.equal(fs.readFileSync(signaturePathFor(destination), 'utf8'), priorSignature);
});

test('signature rename failure restores prior committed manifest and signature pair', () => {
  const root = tempDir('release-signing-rename-fault-');
  const signing = createEphemeralSigningMaterial(root);
  const manifest = fixtureManifest();
  const destination = path.join(root, 'manifest.json');
  writeSignedManifest(destination, manifest, signing.signingPath, signing.keyringPath);
  const priorManifest = fs.readFileSync(destination, 'utf8');
  const priorSignature = fs.readFileSync(signaturePathFor(destination), 'utf8');
  const nextManifest = structuredClone(manifest);
  nextManifest.display.repository.branch = 'feature/rename-fault';
  nextManifest.contentDigest.value = sha256Canonical(nextManifest.content);
  const signingKey = loadSigningKey(signing.signingPath);
  assert.throws(
    () => writeManifestAndSignatureAtomic(destination, nextManifest, buildSignatureEnvelope(nextManifest, {
      keyId: signingKey.keyId,
      privateKey: signingKey.privateKey,
    }), {
      injectFault(stage) {
        if (stage === 'before:signature-rename') {
          throw new Error('injected signature rename failure');
        }
      },
    }),
    /injected signature rename failure/,
  );
  assert.equal(fs.readFileSync(destination, 'utf8'), priorManifest);
  assert.equal(fs.readFileSync(signaturePathFor(destination), 'utf8'), priorSignature);
  verifySignedManifest(JSON.parse(priorManifest), destination, signing.keyringPath);
});

test('release-signing-keygen refuses non-empty output directories', () => {
  const root = tempDir('release-signing-keygen-refuse-');
  const outputDir = path.join(root, 'keys');
  fs.mkdirSync(outputDir, { recursive: true });
  fs.writeFileSync(path.join(outputDir, 'existing.txt'), 'stay\n');
  const result = spawnSync(process.execPath, [
    path.join(REPOSITORY_ROOT, 'scripts/release-signing-keygen.js'),
    `--output-dir=${outputDir}`,
  ], { encoding: 'utf8' });
  assert.equal(result.status, 1);
  assert.match(result.stderr, /non-empty directory/);
});

test('writeKeyMaterialAtomic cleans staging material on mid-write fault', () => {
  const root = tempDir('release-signing-keygen-fault-');
  const outputDir = path.join(root, 'keys');
  const material = generateSigningMaterial();
  assert.throws(
    () => writeKeyMaterialAtomic(outputDir, material, {
      injectFault(stage) {
        if (stage === 'before:keyring-write') throw new Error('injected keyring write failure');
      },
    }),
    /injected keyring write failure/,
  );
  assert.equal(fs.existsSync(outputDir), false);
});

test('release-signing-keygen writes 0700 dir and 0600 key files atomically', () => {
  const root = tempDir('release-signing-keygen-');
  const outputDir = path.join(root, 'keys');
  const result = spawnSync(process.execPath, [
    path.join(REPOSITORY_ROOT, 'scripts/release-signing-keygen.js'),
    `--output-dir=${outputDir}`,
  ], { encoding: 'utf8' });
  assert.equal(result.status, 0, result.stderr);
  assert.match(result.stdout.trim(), /^[0-9a-f-]{36}$/);
  const signingPath = path.join(outputDir, 'release-signing-key.json');
  const keyringPath = path.join(outputDir, 'release-keyring.json');
  assert.equal((fs.statSync(outputDir).mode & 0o777), 0o700);
  assert.equal((fs.statSync(signingPath).mode & 0o777), 0o600);
  assert.equal((fs.statSync(keyringPath).mode & 0o777), 0o600);
  loadSigningKey(signingPath);
  loadKeyring(keyringPath);
});

test('manifestDigest matches verify CLI output digest', () => {
  const root = tempDir('release-signing-cli-digest-');
  const signing = createEphemeralSigningMaterial(root);
  const manifest = fixtureManifest();
  const destination = path.join(root, 'manifest.json');
  writeSignedManifest(destination, manifest, signing.signingPath, signing.keyringPath);
  const verify = spawnSync(process.execPath, [
    path.join(REPOSITORY_ROOT, 'scripts/release-manifest.js'),
    `--verify=${destination}`,
    `--keyring-path=${signing.keyringPath}`,
  ], { encoding: 'utf8', env: { ...process.env, ...signing.signingEnv } });
  assert.equal(verify.status, 0, verify.stderr);
  assert.match(verify.stdout, new RegExp(`release-manifest: ok ${manifestDigest(manifest)}`));
});

test('trusted signing file read rejects path swap before open and during read', () => {
  const root = tempDir('release-signing-toctou-');
  const signing = createEphemeralSigningMaterial(root);
  const filePath = signing.signingPath;
  const readOptions = {
    label: 'release signing key',
    maxBytes: 16 * 1024,
    allowedModes: [0o600],
  };
  const beforeOpen = fs.lstatSync(filePath);
  assert.throws(
    () => readTrustedSecretFile(filePath, readOptions, {
      fstatSync(descriptor) {
        const opened = fs.fstatSync(descriptor);
        return Object.assign(opened, { ino: opened.ino + 1 });
      },
    }),
    /changed before it could be read/,
  );

  assert.throws(
    () => readTrustedSecretFile(filePath, readOptions, {
      readSync(descriptor, buffer, offset, length, position) {
        if (offset === 0) return 1;
        return 0;
      },
    }),
    /changed while it was being read/,
  );

  let pathStats = 0;
  assert.throws(
    () => readTrustedSecretFile(filePath, readOptions, {
      lstatSync(target) {
        const stat = fs.lstatSync(target);
        if (target === filePath) {
          pathStats += 1;
          if (pathStats >= 2) {
            return Object.assign(stat, { ino: stat.ino + 1 });
          }
        }
        return stat;
      },
    }),
    /path changed while it was being read/,
  );
});

test('strict signing rejects non-canonical base64 and malformed key material', () => {
  const root = tempDir('release-signing-strict-');
  const signing = createEphemeralSigningMaterial(root);
  const validBytes = Buffer.from('hello');
  const nonCanonical = `${validBytes.toString('base64')}==`;
  assert.throws(
    () => decodeStrictBase64(nonCanonical, 'test value'),
    /not canonical base64/,
  );
  assert.throws(
    () => decodeStrictBase64('AQ', 'test value'),
    /not canonical base64/,
  );

  const badSigningPath = path.join(root, 'bad-signing.json');
  const validSigning = JSON.parse(fs.readFileSync(signing.signingPath, 'utf8'));
  fs.writeFileSync(badSigningPath, `${JSON.stringify({
    ...validSigning,
    privateKeyPkcs8: Buffer.from('not-a-valid-pkcs8-key').toString('base64'),
  }, null, 2)}\n`, { mode: 0o600 });
  assert.throws(() => loadSigningKey(badSigningPath), /signing private key is invalid/);

  const badKindPath = path.join(root, 'bad-kind-signing.json');
  fs.writeFileSync(badKindPath, `${JSON.stringify({
    ...validSigning,
    kind: 'other-signing-key',
  }, null, 2)}\n`, { mode: 0o600 });
  assert.throws(() => loadSigningKey(badKindPath), /unsupported signing key kind/);

  const badSchemaPath = path.join(root, 'bad-schema-signing.json');
  fs.writeFileSync(badSchemaPath, `${JSON.stringify({
    ...validSigning,
    schemaVersion: 99,
  }, null, 2)}\n`, { mode: 0o600 });
  assert.throws(() => loadSigningKey(badSchemaPath), /unsupported signing key schemaVersion/);

  const validKeyring = JSON.parse(fs.readFileSync(signing.keyringPath, 'utf8'));
  const badKeyringSpkiPath = path.join(root, 'bad-keyring-spki.json');
  fs.writeFileSync(badKeyringSpkiPath, `${JSON.stringify({
    ...validKeyring,
    keys: [{
      ...validKeyring.keys[0],
      publicKeyPkcs8: Buffer.from('not-a-valid-spki-key').toString('base64'),
    }],
  }, null, 2)}\n`, { mode: 0o644 });
  assert.throws(() => loadKeyring(badKeyringSpkiPath), /public key is invalid/);

  const badKeyringKindPath = path.join(root, 'bad-keyring-kind.json');
  fs.writeFileSync(badKeyringKindPath, `${JSON.stringify({
    ...validKeyring,
    kind: 'other-keyring',
  }, null, 2)}\n`, { mode: 0o644 });
  assert.throws(() => loadKeyring(badKeyringKindPath), /unsupported keyring kind/);

  const badKeyringSchemaPath = path.join(root, 'bad-keyring-schema.json');
  fs.writeFileSync(badKeyringSchemaPath, `${JSON.stringify({
    ...validKeyring,
    schemaVersion: 99,
  }, null, 2)}\n`, { mode: 0o644 });
  assert.throws(() => loadKeyring(badKeyringSchemaPath), /unsupported keyring schemaVersion/);

  const manifest = fixtureManifest();
  const signingKey = loadSigningKey(signing.signingPath);
  const envelope = buildSignatureEnvelope(manifest, {
    keyId: signingKey.keyId,
    privateKey: signingKey.privateKey,
  });
  const validSignature = envelope.signature;
  envelope.signature = Buffer.alloc(63, 0xab).toString('base64');
  assert.throws(() => validateSignatureEnvelope(envelope), /invalid length/);

  assert.throws(
    () => validateSignatureEnvelope({ ...envelope, kind: 'other-signature', signature: validSignature }),
    /unsupported signature kind/,
  );

  assert.throws(
    () => validateSignatureEnvelope({
      ...envelope,
      schemaVersion: 99,
      signature: validSignature,
    }),
    /unsupported signature schemaVersion/,
  );
});

test('production verify CLI fails without keyring path', () => {
  const root = tempDir('release-signing-verify-no-keyring-');
  const signing = createEphemeralSigningMaterial(root);
  const bundleManifestPath = path.join(root, 'bundle.manifest.json');
  const bundleArchivePath = path.join(root, 'bundle.tgz');
  const destination = path.join(root, 'backup-release.json');
  fs.writeFileSync(bundleManifestPath, '{"artifact":{"id":"abc"}}\n');
  fs.writeFileSync(bundleArchivePath, 'bundle\n');
  writeSignedReleaseEvidence(destination, bundleManifestPath, bundleArchivePath, signing);
  const env = { ...process.env };
  delete env.RELEASE_KEYRING_PATH;
  delete env.RELEASE_SIGNING_KEY_PATH;
  const verify = spawnSync(process.execPath, [
    path.join(REPOSITORY_ROOT, 'scripts/release-manifest.js'),
    `--verify=${destination}`,
  ], { encoding: 'utf8', env });
  assert.equal(verify.status, 1);
  assert.match(verify.stderr, /RELEASE_KEYRING_PATH|keyring-path/);
});
