const crypto = require('crypto');
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const os = require('os');
const path = require('path');
const { execFileSync } = require('child_process');
const {
  hashRuntimeFile,
  readReleaseIdentity,
  releaseIdentityFromManifest,
} = require('../lib/release-identity');
const {
  collectDeployedFiles,
  sha256Canonical,
} = require('../../scripts/release-manifest');
const {
  buildSignatureEnvelope,
  generateSigningMaterial,
  loadSigningKey,
  writeKeyMaterialAtomic,
  writeManifestAndSignatureAtomic,
} = require('../lib/release-signing');

const temporaryDirectories = [];

test.after(() => {
  for (const directory of temporaryDirectories) {
    fs.rmSync(directory, { recursive: true, force: true });
  }
});

function createRuntime(files = { 'server.js': 'server-v1\n' }) {
  const runtimeDir = fs.mkdtempSync(path.join(os.tmpdir(), 'dashboard-release-identity-'));
  temporaryDirectories.push(runtimeDir);
  for (const [relative, contents] of Object.entries(files)) {
    const target = path.join(runtimeDir, relative);
    fs.mkdirSync(path.dirname(target), { recursive: true });
    fs.writeFileSync(target, contents);
  }
  return runtimeDir;
}

function manifestFor(runtimeDir, deployedPaths = ['server.js']) {
  const content = {
    mode: 'dashboard',
    repository: {
      commit: '1234567890abcdef1234567890abcdef12345678',
      dirty: false,
      source: {
        algorithm: 'sha256',
        digest: 'a'.repeat(64),
        state: 'clean',
        trackedDirty: false,
        untrackedSource: false,
      },
    },
    lockfile: { path: 'package-lock.json', sha256: 'b'.repeat(64) },
    actual: {
      serverImage: '26.7.0',
      dashboardApi: '26.7.0',
      toolsApi: '26.7.0',
    },
    contract: { fingerprint: 'e92dd64e2bba333f' },
    app: {
      variant: 'full',
      releaseProfile: 'production',
      version: '2.0.0',
      runtimeVersion: '2.0.0',
      updateChannel: 'production',
      iosBuildNumber: '5',
    },
    deployedFiles: collectDeployedFiles(runtimeDir, deployedPaths),
  };
  return {
    kind: 'darkfinances-release',
    schemaVersion: 2,
    builtAt: '2026-02-02T00:00:00.000Z',
    content,
    contentDigest: {
      algorithm: 'sha256',
      canonicalization: 'darkfinances-canonical-json-v1',
      value: sha256Canonical(content),
    },
    display: { repository: { commitShort: 'unbound', branch: null } },
  };
}

function resign(manifest) {
  manifest.contentDigest.value = sha256Canonical(manifest.content);
  return manifest;
}

function signManifestOnDisk(manifest, runtimeDir) {
  const keysDir = path.join(runtimeDir, `.release-signing-keys-${crypto.randomUUID()}`);
  const material = generateSigningMaterial({
    notBefore: '2020-01-01T00:00:00.000Z',
    notAfter: '2099-01-01T00:00:00.000Z',
  });
  const paths = writeKeyMaterialAtomic(keysDir, material);
  const manifestPath = path.join(runtimeDir, 'release-manifest.json');
  fs.writeFileSync(manifestPath, `${JSON.stringify(manifest, null, 2)}\n`, { mode: 0o600 });
  const signingKey = loadSigningKey(paths.signingPath);
  const envelope = buildSignatureEnvelope(manifest, {
    keyId: signingKey.keyId,
    privateKey: signingKey.privateKey,
    signedAt: manifest.builtAt,
  });
  writeManifestAndSignatureAtomic(manifestPath, manifest, envelope);
  return { manifestPath, keyringPath: paths.keyringPath };
}

function prepareSignedDashboardManifest(runtimeDir, expectedFiles = ['server.js']) {
  const manifest = manifestFor(runtimeDir, expectedFiles);
  const { manifestPath, keyringPath } = signManifestOnDisk(manifest, runtimeDir);
  return { manifest, manifestPath, keyringPath, expectedFiles };
}

function readPreparedIdentity(prepared, runtimeDir, expectedFiles = prepared.expectedFiles) {
  return readReleaseIdentity(prepared.manifestPath, runtimeDir, {
    expectedFiles,
    manifestPath: prepared.manifestPath,
    env: { RELEASE_KEYRING_PATH: prepared.keyringPath },
  });
}

function readSignedIdentity(runtimeDir, expectedFiles = ['server.js']) {
  return readFromDisk(manifestFor(runtimeDir, expectedFiles), runtimeDir, expectedFiles);
}

function readFromDisk(manifest, runtimeDir, expectedFiles = ['server.js']) {
  const { manifestPath, keyringPath } = signManifestOnDisk(manifest, runtimeDir);
  return readReleaseIdentity(manifestPath, runtimeDir, {
    expectedFiles,
    manifestPath,
    env: { RELEASE_KEYRING_PATH: keyringPath },
  });
}

function tamperedSignedIdentity(runtimeDir, mutate, expectedFiles = ['server.js']) {
  const prepared = prepareSignedDashboardManifest(runtimeDir, expectedFiles);
  const manifest = structuredClone(prepared.manifest);
  mutate(manifest);
  fs.writeFileSync(prepared.manifestPath, `${JSON.stringify(manifest, null, 2)}\n`, { mode: 0o600 });
  return readReleaseIdentity(prepared.manifestPath, runtimeDir, {
    expectedFiles,
    manifestPath: prepared.manifestPath,
    env: { RELEASE_KEYRING_PATH: prepared.keyringPath },
  });
}

function unsignedManifestIdentity(runtimeDir, mutate, expectedFiles = ['server.js']) {
  const prepared = prepareSignedDashboardManifest(runtimeDir, expectedFiles);
  const manifest = structuredClone(prepared.manifest);
  mutate(manifest);
  fs.writeFileSync(prepared.manifestPath, `${JSON.stringify(manifest, null, 2)}\n`, { mode: 0o600 });
  return releaseIdentityFromManifest(JSON.parse(fs.readFileSync(prepared.manifestPath, 'utf8')), {
    runtimeDir,
    expectedFiles,
    manifestPath: prepared.manifestPath,
    env: { RELEASE_KEYRING_PATH: prepared.keyringPath },
  });
}

test('non-production legacy identity preserves schema-v1 /ping compatibility', () => {
  assert.deepEqual(releaseIdentityFromManifest({
    schemaVersion: 1,
    builtAt: '2026-01-01T00:00:00.000Z',
    repository: { commitShort: 'abcdef0', dirty: true },
    lockfile: { sha256: 'lock-v1' },
    contract: { fingerprint: 'contract-v1' },
    app: { version: '1.0.0' },
  }, {
    env: { NODE_ENV: 'development' },
    allowLegacyIdentity: true,
  }), {
    commit: 'abcdef0',
    dirty: true,
    lockSha256: 'lock-v1',
    contract: 'contract-v1',
    appVersion: '1.0.0',
    builtAt: '2026-01-01T00:00:00.000Z',
  });
});

test('production runtime rejects schema-v1 and unsigned schema-v2 dashboard manifests', () => {
  const productionEnv = {
    FINANCE_RUNTIME_MODE: 'production',
    NODE_ENV: 'production',
    RELEASE_KEYRING_PATH: '/tmp/unused-keyring.json',
  };
  assert.equal(releaseIdentityFromManifest({
    schemaVersion: 1,
    builtAt: '2026-01-01T00:00:00.000Z',
    repository: { commitShort: 'abcdef0', dirty: false },
    lockfile: { sha256: 'b'.repeat(64) },
    contract: { fingerprint: 'contract-v1' },
    app: { version: '1.0.0' },
  }, { env: productionEnv, allowLegacyIdentity: false }), null);

  const runtimeDir = createRuntime();
  const manifest = manifestFor(runtimeDir);
  assert.equal(releaseIdentityFromManifest(manifest, {
    runtimeDir,
    expectedFiles: ['server.js'],
    env: productionEnv,
    allowLegacyIdentity: false,
  }), null);
});

test('release identity maps schema-v2 content to the unchanged /ping shape', () => {
  const runtimeDir = createRuntime();
  assert.deepEqual(readSignedIdentity(runtimeDir), {
    commit: '1234567',
    dirty: false,
    lockSha256: 'b'.repeat(64),
    contract: 'e92dd64e2bba333f',
    appVersion: '2.0.0',
    builtAt: '2026-02-02T00:00:00.000Z',
  });
});

test('release identity rejects schema-v2 content tampering', () => {
  const runtimeDir = createRuntime();
  assert.equal(tamperedSignedIdentity(runtimeDir, (manifest) => {
    manifest.content.app.version = 'tampered';
  }), null);
});

test('release identity rejects rehashed but structurally invalid schema-v2 content', () => {
  const runtimeDir = createRuntime();
  assert.equal(unsignedManifestIdentity(runtimeDir, (manifest) => {
    manifest.content.repository.extra = true;
    resign(manifest);
  }), null);

  assert.equal(unsignedManifestIdentity(runtimeDir, (manifest) => {
    manifest.content.actual.toolsApi = '26.7.1';
    resign(manifest);
  }), null);

  assert.equal(unsignedManifestIdentity(runtimeDir, (manifest) => {
    manifest.extra = true;
  }), null);

  assert.equal(unsignedManifestIdentity(runtimeDir, (manifest) => {
    manifest.contentDigest.extra = true;
  }), null);
});

test('release identity rejects non-dashboard schema-v2 manifests', () => {
  const runtimeDir = createRuntime();
  assert.equal(unsignedManifestIdentity(runtimeDir, (manifest) => {
    manifest.content.mode = 'source';
    resign(manifest);
  }), null);
});

test('deployed runtime mutation invalidates schema-v2 /ping identity', () => {
  const runtimeDir = createRuntime();
  const prepared = prepareSignedDashboardManifest(runtimeDir);
  assert.ok(readPreparedIdentity(prepared, runtimeDir));
  fs.writeFileSync(path.join(runtimeDir, 'server.js'), 'server-v2\n');
  assert.equal(readPreparedIdentity(prepared, runtimeDir), null);
});

test('deployed runtime verification rejects missing files, directories, and symlinks', () => {
  const missingRuntime = createRuntime();
  const missingPrepared = prepareSignedDashboardManifest(missingRuntime);
  fs.unlinkSync(path.join(missingRuntime, 'server.js'));
  assert.equal(readPreparedIdentity(missingPrepared, missingRuntime), null);

  const directoryRuntime = createRuntime();
  const directoryPrepared = prepareSignedDashboardManifest(directoryRuntime);
  fs.unlinkSync(path.join(directoryRuntime, 'server.js'));
  fs.mkdirSync(path.join(directoryRuntime, 'server.js'));
  assert.equal(readPreparedIdentity(directoryPrepared, directoryRuntime), null);

  const symlinkRuntime = createRuntime();
  const symlinkPrepared = prepareSignedDashboardManifest(symlinkRuntime);
  fs.renameSync(path.join(symlinkRuntime, 'server.js'), path.join(symlinkRuntime, 'real-server.js'));
  fs.symlinkSync('real-server.js', path.join(symlinkRuntime, 'server.js'));
  assert.equal(readPreparedIdentity(symlinkPrepared, symlinkRuntime), null);

  const nestedRuntime = createRuntime({ 'lib/runtime.js': 'nested\n' });
  const nestedPrepared = prepareSignedDashboardManifest(nestedRuntime, ['lib/runtime.js']);
  const outside = createRuntime({ 'runtime.js': 'nested\n' });
  fs.rmSync(path.join(nestedRuntime, 'lib'), { recursive: true });
  fs.symlinkSync(outside, path.join(nestedRuntime, 'lib'));
  assert.equal(readPreparedIdentity(nestedPrepared, nestedRuntime, ['lib/runtime.js']), null);
});

test('deployed runtime verification rejects FIFOs before opening them', {
  skip: process.platform === 'win32',
}, () => {
  const runtimeDir = createRuntime();
  const prepared = prepareSignedDashboardManifest(runtimeDir);
  fs.unlinkSync(path.join(runtimeDir, 'server.js'));
  execFileSync('mkfifo', [path.join(runtimeDir, 'server.js')]);
  assert.equal(readPreparedIdentity(prepared, runtimeDir), null);
});

test('deployed hashing rejects atomic path replacement', () => {
  const runtimeDir = createRuntime({ 'server.js': Buffer.alloc(128 * 1024, 0x31) });
  const server = path.join(runtimeDir, 'server.js');
  let replaced = false;
  assert.throws(() => hashRuntimeFile(runtimeDir, 'server.js', {
    readSync(descriptor, buffer, offset, length, position) {
      if (!replaced) {
        replaced = true;
        fs.renameSync(server, `${server}.old`);
        fs.writeFileSync(server, Buffer.alloc(128 * 1024, 0x32));
      }
      return fs.readSync(descriptor, buffer, offset, length, position);
    },
  }), /changed while hashing/);
});

test('deployed runtime verification rejects traversal, malformed evidence, and path ordering', () => {
  const runtimeDir = createRuntime({
    'a.js': 'a\n',
    'b.js': 'b\n',
    'server.js': 'server\n',
  });
  assert.equal(unsignedManifestIdentity(runtimeDir, (manifest) => {
    manifest.content.deployedFiles[0].path = '../server.js';
    resign(manifest);
  }), null);

  for (const field of ['bytes', 'sha256', 'executable']) {
    assert.equal(unsignedManifestIdentity(runtimeDir, (manifest) => {
      if (field === 'bytes') manifest.content.deployedFiles[0].bytes += 1;
      if (field === 'sha256') manifest.content.deployedFiles[0].sha256 = '0'.repeat(64);
      if (field === 'executable') {
        manifest.content.deployedFiles[0].executable = !manifest.content.deployedFiles[0].executable;
      }
      resign(manifest);
    }), null, field);
  }

  assert.equal(unsignedManifestIdentity(runtimeDir, (manifest) => {
    manifest.content.deployedFiles.push({ ...manifest.content.deployedFiles[0] });
    resign(manifest);
  }), null);

  const unsortedRuntime = createRuntime({ 'a.js': 'a\n', 'b.js': 'b\n' });
  assert.equal(unsignedManifestIdentity(unsortedRuntime, (manifest) => {
    manifest.content.deployedFiles.reverse();
    resign(manifest);
  }, ['a.js', 'b.js']), null);
});

test('release identity returns null for missing or malformed manifests', () => {
  assert.equal(readReleaseIdentity('/missing', '/runtime', { readFile: () => {
    throw new Error('missing');
  } }), null);
  assert.equal(readReleaseIdentity('/invalid', '/runtime', { readFile: () => '{not-json' }), null);
  assert.equal(releaseIdentityFromManifest({ schemaVersion: 2 }), null);
  assert.equal(releaseIdentityFromManifest({ schemaVersion: 99, repository: {} }), null);
});

test('readReleaseIdentity returns null for symlink and raced manifest files without injected readFile', {
  skip: process.platform === 'win32' ? 'POSIX symlink semantics' : false,
}, () => {
  const runtimeDir = createRuntime();
  const prepared = prepareSignedDashboardManifest(runtimeDir);
  const realManifest = path.join(runtimeDir, 'real-release-manifest.json');
  fs.renameSync(prepared.manifestPath, realManifest);
  fs.symlinkSync(realManifest, prepared.manifestPath);
  assert.equal(readReleaseIdentity(prepared.manifestPath, runtimeDir, {
    manifestPath: prepared.manifestPath,
    env: { RELEASE_KEYRING_PATH: prepared.keyringPath },
  }), null);
});
