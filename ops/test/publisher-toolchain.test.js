'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const os = require('os');
const path = require('path');
const {
  INVOCATION_LABEL,
  STANDALONE_INSTALL_COMMAND,
  INJECTION_ENV_VARS,
  prepareVerifiedPublisherSnapshot,
  resolveEasPackageRoot,
  resolvePinnedEas,
  runPinnedEas,
  sanitizePublisherSpawnEnv,
} = require('../../finance-dashboard/lib/pinned-eas-cli');
const {
  normalizePublisherToolchain,
  readDeclaredDevDependency,
  readEasCliPin,
  verifyPublisherToolchain,
} = require('../../finance-dashboard/lib/publisher-toolchain');
const {
  assertStandaloneEasInstall,
  readRuntimeClosureContract,
  verifyRuntimeClosureContractFreshness,
} = require('../../finance-dashboard/lib/eas-cli-runtime-closure');
const { validateManifestContent } = require('../../finance-dashboard/lib/release-schema');

const repositoryRoot = path.resolve(__dirname, '..', '..');
const appRoot = path.join(repositoryRoot, 'finance-app');
const runtimeContract = readRuntimeClosureContract(repositoryRoot);
const expectedIntegrity = runtimeContract.integrity;
const BOUND_PLATFORM = process.platform === 'darwin' && process.arch === 'arm64';

function basePublisherToolchain(overrides = {}) {
  return {
    package: 'eas-cli',
    version: runtimeContract.version,
    integrity: expectedIntegrity,
    invocation: INVOCATION_LABEL,
    runtimeClosureDigest: runtimeContract.runtimeClosureDigest,
    packageCount: runtimeContract.packageCount,
    fileCount: runtimeContract.fileCount,
    platform: runtimeContract.platform,
    arch: runtimeContract.arch,
    derivationVersion: runtimeContract.derivationVersion,
    standaloneInstallCommand: STANDALONE_INSTALL_COMMAND,
    ...overrides,
  };
}

function baseManifest(overrides = {}) {
  return {
    mode: 'ota',
    repository: {
      commit: 'a'.repeat(40),
      dirty: false,
      source: {
        algorithm: 'sha256',
        digest: 'b'.repeat(64),
        state: 'clean',
        trackedDirty: false,
        untrackedSource: false,
      },
    },
    lockfile: { path: 'package-lock.json', sha256: 'c'.repeat(64) },
    actual: { serverImage: '26.7.0', dashboardApi: '26.7.0', toolsApi: '26.7.0' },
    contract: { fingerprint: 'e92dd64e2bba333f' },
    app: {
      variant: 'full',
      releaseProfile: 'production',
      version: '1.2.0',
      runtimeVersion: '1.2.0',
      updateChannel: 'production',
      iosBuildNumber: '5',
    },
    ota: {
      groupId: '00000000-0000-0000-0000-000000000001',
      updates: [{ id: '11111111-1111-1111-1111-111111111111', platform: 'ios' }],
      runtimeVersion: '1.2.0',
      channel: 'production',
      branch: 'production',
      profile: 'production',
      environment: 'production',
    },
    publisherToolchain: basePublisherToolchain(),
    ...overrides,
  };
}

test('verifyRuntimeClosureContractFreshness passes when simulating linux CI', () => {
  assert.doesNotThrow(() => verifyRuntimeClosureContractFreshness(repositoryRoot, {
    platform: 'linux',
    arch: 'x64',
  }));
});

test('verifyPublisherToolchain returns contract evidence on non-bound platforms', () => {
  const evidence = verifyPublisherToolchain(repositoryRoot, { platform: 'linux', arch: 'x64' });
  assert.equal(evidence.package, 'eas-cli');
  assert.equal(evidence.version, runtimeContract.version);
  assert.equal(evidence.runtimeClosureDigest, runtimeContract.runtimeClosureDigest);
  assert.equal(evidence.packageCount, runtimeContract.packageCount);
  assert.equal(evidence.platform, 'darwin');
  assert.equal(evidence.arch, 'arm64');
});

test('verifyPublisherToolchain binds eas.json, package.json, lockfiles, and direct local bin', { skip: !BOUND_PLATFORM }, () => {
  const evidence = verifyPublisherToolchain(repositoryRoot, { verifyInstalled: true });
  assert.equal(evidence.package, 'eas-cli');
  assert.equal(evidence.version, readEasCliPin(repositoryRoot));
  assert.equal(evidence.version, readDeclaredDevDependency(repositoryRoot));
  assert.equal(evidence.integrity, expectedIntegrity);
  assert.equal(evidence.runtimeClosureDigest, runtimeContract.runtimeClosureDigest);
  assert.equal(evidence.packageCount, runtimeContract.packageCount);
  assert.equal(evidence.fileCount, runtimeContract.fileCount);
  assert.equal(evidence.invocation, INVOCATION_LABEL);

  const resolved = resolvePinnedEas(appRoot, repositoryRoot, { verifyInstalled: true });
  assert.match(resolved.binPath, /ops\/publisher-toolchain\/node_modules\/eas-cli\/bin\/run$/);
  assert.doesNotMatch(resolved.binPath, /finance-app\/node_modules\/eas-cli/);
  assert.doesNotMatch(resolved.binPath, /npm exec|npx/);
});

test('runPinnedEas uses verified snapshot path, sanitized env, finance-app cwd, and cleans up', { skip: !BOUND_PLATFORM }, () => {
  const calls = [];
  const spawnOptions = [];
  const snapshotPaths = [];
  const sourcePublisher = path.join(repositoryRoot, 'ops/publisher-toolchain');
  const resolved = resolvePinnedEas(appRoot, repositoryRoot, { verifyInstalled: true });
  runPinnedEas(['--version'], {
    appRoot,
    repoRoot: repositoryRoot,
    capture: true,
    mkdtempSync: (prefix) => {
      const dir = fs.mkdtempSync(prefix);
      snapshotPaths.push(dir);
      return dir;
    },
    spawnSync: (command, args, options) => {
      calls.push([command, args]);
      spawnOptions.push(options);
      return { status: 0, stdout: `${resolved.version}\n`, stderr: '' };
    },
  });
  assert.equal(calls.length, 1);
  assert.equal(calls[0][0], process.execPath);
  assert.match(calls[0][1][0], /darkfinances-publisher-/);
  assert.doesNotMatch(calls[0][1][0], new RegExp(`${sourcePublisher}/node_modules/eas-cli/bin/run`));
  assert.equal(calls[0][1][1], '--version');
  assert.equal(spawnOptions[0].cwd, appRoot);
  for (const key of INJECTION_ENV_VARS) {
    assert.equal(key in (spawnOptions[0].env || {}), false);
  }
  assert.equal(snapshotPaths.length, 1);
  assert.equal(fs.existsSync(snapshotPaths[0]), false);
});

test('prepareVerifiedPublisherSnapshot rejects tampered copied tree before spawn', { skip: !BOUND_PLATFORM }, () => {
  const sourcePublisher = path.join(repositoryRoot, 'ops/publisher-toolchain');
  const contract = readRuntimeClosureContract(repositoryRoot);
  let copiedDestination = null;
  assert.throws(
    () => prepareVerifiedPublisherSnapshot(sourcePublisher, repositoryRoot, contract, {
      copySync: (source, destination) => {
        copiedDestination = destination;
        fs.cpSync(source, destination, { recursive: true });
        fs.mkdirSync(path.join(destination, 'node_modules/evil'), { recursive: true });
        fs.writeFileSync(path.join(destination, 'node_modules/evil/package.json'), JSON.stringify({
          name: 'evil',
          version: '1.0.0',
        }));
      },
    }),
    /outside lock closure: node_modules\/evil/,
  );
  if (copiedDestination) {
    assert.equal(fs.existsSync(path.dirname(copiedDestination)), false);
  }
});

test('sanitizePublisherSpawnEnv removes code injection variables only', () => {
  const env = sanitizePublisherSpawnEnv({
    HOME: '/tmp/home',
    PATH: '/usr/bin',
    NODE_OPTIONS: '--require evil',
    EXPO_TOKEN: 'secret',
    NODE_PATH: '/evil',
  });
  assert.equal(env.HOME, '/tmp/home');
  assert.equal(env.EXPO_TOKEN, 'secret');
  assert.equal(env.NODE_OPTIONS, undefined);
  assert.equal(env.NODE_PATH, undefined);
});

test('assertStandaloneEasInstall rejects hoisted repository-root install layout on any platform', () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'hoisted-eas-'));
  const publisherDir = path.join(root, 'ops/publisher-toolchain');
  fs.mkdirSync(publisherDir, { recursive: true });
  if (fs.existsSync(path.join(repositoryRoot, 'ops/publisher-toolchain/node_modules/eas-cli'))) {
    fs.cpSync(
      path.join(repositoryRoot, 'ops/publisher-toolchain/node_modules/eas-cli'),
      path.join(root, 'node_modules/eas-cli'),
      { recursive: true },
    );
  }
  assert.throws(
    () => assertStandaloneEasInstall(publisherDir),
    /standalone eas-cli install/,
  );
  assert.throws(
    () => resolveEasPackageRoot(publisherDir),
    /standalone eas-cli install/,
  );
});

test('verifyPublisherToolchain rejects lockfile integrity mismatch', () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'eas-integrity-'));
  const appDir = path.join(root, 'finance-app');
  const publisherDir = path.join(root, 'ops/publisher-toolchain');
  fs.mkdirSync(appDir, { recursive: true });
  fs.mkdirSync(publisherDir, { recursive: true });
  fs.writeFileSync(path.join(appDir, 'eas.json'), JSON.stringify({ cli: { version: '21.3.0' } }));
  fs.writeFileSync(path.join(publisherDir, 'package.json'), JSON.stringify({
    name: 'publisher-toolchain',
    version: '1.0.0',
    devDependencies: { 'eas-cli': '21.3.0' },
  }));
  const publisherLock = {
    lockfileVersion: 3,
    packages: {
      '': { name: 'publisher-toolchain', version: '1.0.0' },
      'node_modules/eas-cli': {
        version: '21.3.0',
        integrity: 'sha512-AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA==',
      },
    },
  };
  fs.writeFileSync(path.join(publisherDir, 'package-lock.json'), JSON.stringify(publisherLock, null, 2));
  fs.mkdirSync(path.join(root, 'ops/toolchain'), { recursive: true });
  fs.writeFileSync(path.join(root, 'ops/toolchain/eas-cli-runtime-closure.json'), fs.readFileSync(
    path.join(repositoryRoot, 'ops/toolchain/eas-cli-runtime-closure.json'),
  ));
  const localPkg = path.join(publisherDir, 'node_modules', 'eas-cli');
  fs.mkdirSync(path.join(localPkg, 'bin'), { recursive: true });
  fs.writeFileSync(path.join(localPkg, 'package.json'), JSON.stringify({
    name: 'eas-cli',
    version: '21.3.0',
    bin: { eas: 'bin/run' },
  }));
  fs.writeFileSync(path.join(localPkg, 'bin', 'run'), '#!/usr/bin/env node\n');
  assert.throws(
    () => verifyPublisherToolchain(root),
    /runtime closure contract eas-cli version\/integrity does not match lockfiles and pins/,
  );
});

test('assertStandaloneEasInstall fails when local eas-cli package is missing on any platform', () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'missing-eas-'));
  const publisherDir = path.join(root, 'ops/publisher-toolchain');
  fs.mkdirSync(publisherDir, { recursive: true });
  assert.throws(
    () => assertStandaloneEasInstall(publisherDir),
    /standalone eas-cli install/,
  );
});

test('normalizePublisherToolchain rejects unknown fields and bad integrity', () => {
  const complete = basePublisherToolchain();
  assert.throws(
    () => normalizePublisherToolchain({ ...complete, extra: 'nope' }),
    /unsupported field/,
  );
  assert.throws(
    () => normalizePublisherToolchain({ ...complete, integrity: 'bad' }),
    /integrity must be npm SRI sha512/,
  );
  assert.throws(
    () => normalizePublisherToolchain({ ...complete, runtimeClosureDigest: 'bad' }),
    /runtimeClosureDigest must be sha256 hex/,
  );
  assert.throws(
    () => normalizePublisherToolchain({ ...complete, packageCount: 0 }),
    /packageCount must be a positive integer/,
  );
  assert.throws(
    () => normalizePublisherToolchain({ ...complete, invocation: 'npm exec -- eas-cli' }),
    /invocation must be/,
  );
  assert.throws(
    () => normalizePublisherToolchain({ ...complete, standaloneInstallCommand: 'npm ci' }),
    /standaloneInstallCommand must be/,
  );
});

test('validateManifestContent rejects missing runtime closure evidence fields', () => {
  const content = baseManifest();
  delete content.publisherToolchain.runtimeClosureDigest;
  assert.throws(() => validateManifestContent(content), /runtimeClosureDigest must be sha256 hex/);
});

test('validateManifestContent rejects publisherToolchain digest mismatch', () => {
  const content = baseManifest();
  content.publisherToolchain.packageCount = '78';
  assert.throws(() => validateManifestContent(content), /must use normalized fields/);
});

test('validateManifestContent requires publisherToolchain for ota mode', () => {
  const content = baseManifest();
  delete content.publisherToolchain;
  assert.throws(() => validateManifestContent(content), /requires publisherToolchain evidence/);
});

test('validateManifestContent forbids publisherToolchain outside ota mode', () => {
  const content = baseManifest({ mode: 'source' });
  delete content.ota;
  assert.throws(() => validateManifestContent(content), /publisherToolchain evidence is only valid for ota mode/);
});

test('ota-publish shell contract verifies installed publisher toolchain and uses direct wrapper', () => {
  const source = fs.readFileSync(path.join(repositoryRoot, 'finance-app/scripts/ota-publish.sh'), 'utf8');
  assert.match(source, /verifyPublisherToolchain\('\$REPO_ROOT', \{ verifyInstalled: true \}\)/);
  assert.match(source, /run-pinned-eas\.js update/);
  assert.doesNotMatch(source, /npm exec/);
  assert.doesNotMatch(source, /npx eas-cli/);
});
