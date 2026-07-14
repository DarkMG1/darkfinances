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

function readFromDisk(manifest, runtimeDir, expectedFiles = ['server.js']) {
  const manifestPath = path.join(runtimeDir, 'release-manifest.json');
  fs.writeFileSync(manifestPath, `${JSON.stringify(manifest)}\n`);
  return readReleaseIdentity(manifestPath, runtimeDir, { expectedFiles });
}

test('release identity preserves schema-v1 /ping compatibility', () => {
  assert.deepEqual(releaseIdentityFromManifest({
    schemaVersion: 1,
    builtAt: '2026-01-01T00:00:00.000Z',
    repository: { commitShort: 'abcdef0', dirty: true },
    lockfile: { sha256: 'lock-v1' },
    contract: { fingerprint: 'contract-v1' },
    app: { version: '1.0.0' },
  }), {
    commit: 'abcdef0',
    dirty: true,
    lockSha256: 'lock-v1',
    contract: 'contract-v1',
    appVersion: '1.0.0',
    builtAt: '2026-01-01T00:00:00.000Z',
  });
});

test('release identity maps schema-v2 content to the unchanged /ping shape', () => {
  const runtimeDir = createRuntime();
  assert.deepEqual(releaseIdentityFromManifest(manifestFor(runtimeDir), {
    runtimeDir,
    expectedFiles: ['server.js'],
  }), {
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
  const manifest = manifestFor(runtimeDir);
  manifest.content.app.version = 'tampered';
  assert.equal(releaseIdentityFromManifest(manifest, {
    runtimeDir,
    expectedFiles: ['server.js'],
  }), null);
});

test('release identity rejects rehashed but structurally invalid schema-v2 content', () => {
  const runtimeDir = createRuntime();
  const unknown = manifestFor(runtimeDir);
  unknown.content.repository.extra = true;
  resign(unknown);
  assert.equal(releaseIdentityFromManifest(unknown, {
    runtimeDir,
    expectedFiles: ['server.js'],
  }), null);

  const misaligned = manifestFor(runtimeDir);
  misaligned.content.actual.toolsApi = '26.7.1';
  resign(misaligned);
  assert.equal(releaseIdentityFromManifest(misaligned, {
    runtimeDir,
    expectedFiles: ['server.js'],
  }), null);

  const unknownEnvelope = manifestFor(runtimeDir);
  unknownEnvelope.extra = true;
  assert.equal(releaseIdentityFromManifest(unknownEnvelope, {
    runtimeDir,
    expectedFiles: ['server.js'],
  }), null);

  const unknownDigest = manifestFor(runtimeDir);
  unknownDigest.contentDigest.extra = true;
  assert.equal(releaseIdentityFromManifest(unknownDigest, {
    runtimeDir,
    expectedFiles: ['server.js'],
  }), null);
});

test('release identity rejects non-dashboard schema-v2 manifests', () => {
  const runtimeDir = createRuntime();
  const manifest = manifestFor(runtimeDir);
  manifest.content.mode = 'source';
  resign(manifest);
  assert.equal(releaseIdentityFromManifest(manifest, {
    runtimeDir,
    expectedFiles: ['server.js'],
  }), null);
});

test('deployed runtime mutation invalidates schema-v2 /ping identity', () => {
  const runtimeDir = createRuntime();
  const manifest = manifestFor(runtimeDir);
  assert.ok(readFromDisk(manifest, runtimeDir));
  fs.writeFileSync(path.join(runtimeDir, 'server.js'), 'server-v2\n');
  assert.equal(readFromDisk(manifest, runtimeDir), null);
});

test('deployed runtime verification rejects missing files, directories, and symlinks', () => {
  const missingRuntime = createRuntime();
  const missingManifest = manifestFor(missingRuntime);
  fs.unlinkSync(path.join(missingRuntime, 'server.js'));
  assert.equal(readFromDisk(missingManifest, missingRuntime), null);

  const directoryRuntime = createRuntime();
  const directoryManifest = manifestFor(directoryRuntime);
  fs.unlinkSync(path.join(directoryRuntime, 'server.js'));
  fs.mkdirSync(path.join(directoryRuntime, 'server.js'));
  assert.equal(readFromDisk(directoryManifest, directoryRuntime), null);

  const symlinkRuntime = createRuntime();
  const symlinkManifest = manifestFor(symlinkRuntime);
  fs.renameSync(path.join(symlinkRuntime, 'server.js'), path.join(symlinkRuntime, 'real-server.js'));
  fs.symlinkSync('real-server.js', path.join(symlinkRuntime, 'server.js'));
  assert.equal(readFromDisk(symlinkManifest, symlinkRuntime), null);

  const nestedRuntime = createRuntime({ 'lib/runtime.js': 'nested\n' });
  const nestedManifest = manifestFor(nestedRuntime, ['lib/runtime.js']);
  const outside = createRuntime({ 'runtime.js': 'nested\n' });
  fs.rmSync(path.join(nestedRuntime, 'lib'), { recursive: true });
  fs.symlinkSync(outside, path.join(nestedRuntime, 'lib'));
  assert.equal(readFromDisk(nestedManifest, nestedRuntime, ['lib/runtime.js']), null);
});

test('deployed runtime verification rejects FIFOs before opening them', {
  skip: process.platform === 'win32',
}, () => {
  const runtimeDir = createRuntime();
  const manifest = manifestFor(runtimeDir);
  fs.unlinkSync(path.join(runtimeDir, 'server.js'));
  execFileSync('mkfifo', [path.join(runtimeDir, 'server.js')]);
  assert.equal(readFromDisk(manifest, runtimeDir), null);
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
  const traversal = manifestFor(runtimeDir);
  traversal.content.deployedFiles[0].path = '../server.js';
  resign(traversal);
  assert.equal(readFromDisk(traversal, runtimeDir), null);

  for (const field of ['bytes', 'sha256', 'executable']) {
    const invalid = manifestFor(runtimeDir);
    if (field === 'bytes') invalid.content.deployedFiles[0].bytes += 1;
    if (field === 'sha256') invalid.content.deployedFiles[0].sha256 = '0'.repeat(64);
    if (field === 'executable') invalid.content.deployedFiles[0].executable = !invalid.content.deployedFiles[0].executable;
    resign(invalid);
    assert.equal(readFromDisk(invalid, runtimeDir), null, field);
  }

  const duplicate = manifestFor(runtimeDir);
  duplicate.content.deployedFiles.push({ ...duplicate.content.deployedFiles[0] });
  resign(duplicate);
  assert.equal(readFromDisk(duplicate, runtimeDir), null);

  const unsorted = manifestFor(runtimeDir, ['a.js', 'b.js']);
  unsorted.content.deployedFiles.reverse();
  resign(unsorted);
  assert.equal(readFromDisk(unsorted, runtimeDir, ['a.js', 'b.js']), null);
});

test('release identity returns null for missing or malformed manifests', () => {
  assert.equal(readReleaseIdentity('/missing', '/runtime', { readFile: () => {
    throw new Error('missing');
  } }), null);
  assert.equal(readReleaseIdentity('/invalid', '/runtime', { readFile: () => '{not-json' }), null);
  assert.equal(releaseIdentityFromManifest({ schemaVersion: 2 }), null);
  assert.equal(releaseIdentityFromManifest({ schemaVersion: 99, repository: {} }), null);
});
