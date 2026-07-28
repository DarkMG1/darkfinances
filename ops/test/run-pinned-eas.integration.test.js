'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const os = require('os');
const path = require('path');
const { spawnSync } = require('child_process');
const { runPinnedEas, resolveEasPackageRoot } = require('../../finance-dashboard/lib/pinned-eas-cli');
const {
  assertStandaloneEasInstall,
  computeRuntimeClosureFromInstall,
  readRuntimeClosureContract,
  STANDALONE_INSTALL_COMMAND,
} = require('../../finance-dashboard/lib/eas-cli-runtime-closure');

const crypto = require('crypto');

const repositoryRoot = path.resolve(__dirname, '..', '..');
const runtimeContract = readRuntimeClosureContract(repositoryRoot);
const expectedIntegrity = runtimeContract.integrity;

function writeMinimalRuntimeContract(root, lockBody) {
  const publisherLockPath = path.join(root, 'ops/publisher-toolchain/package-lock.json');
  const lockContents = `${JSON.stringify(lockBody, null, 2)}\n`;
  fs.writeFileSync(publisherLockPath, lockContents);
  const lockSha256 = crypto.createHash('sha256').update(lockContents).digest('hex');
  fs.mkdirSync(path.join(root, 'ops/toolchain'), { recursive: true });
  fs.writeFileSync(path.join(root, 'ops/toolchain/eas-cli-runtime-closure.json'), JSON.stringify({
    schemaVersion: 1,
    derivationVersion: 2,
    platform: 'darwin',
    arch: 'arm64',
    package: 'eas-cli',
    version: '21.3.0',
    integrity: expectedIntegrity,
    lockfilePath: 'ops/publisher-toolchain/package-lock.json',
    lockfileSha256: lockSha256,
    runtimeClosureDigest: 'a'.repeat(64),
    packageCount: 1,
    fileCount: 1,
    standaloneInstallCommand: STANDALONE_INSTALL_COMMAND,
    provenance: 'run-pinned-eas integration fixture',
  }, null, 2));
}

function copyRuntimeClosureContract(root) {
  fs.mkdirSync(path.join(root, 'ops/toolchain'), { recursive: true });
  fs.writeFileSync(
    path.join(root, 'ops/toolchain/eas-cli-runtime-closure.json'),
    JSON.stringify(runtimeContract, null, 2),
  );
}

function writeEasFixture(root, { local = true, hoisted = false } = {}) {
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
  const lockBody = {
    lockfileVersion: 3,
    packages: {
      '': { name: 'publisher-toolchain', version: '1.0.0' },
      'node_modules/eas-cli': {
        version: '21.3.0',
        integrity: expectedIntegrity,
      },
    },
  };
  writeMinimalRuntimeContract(root, lockBody);
  const copyFrom = path.join(repositoryRoot, 'ops/publisher-toolchain/node_modules/eas-cli');
  function copyPackage(targetRoot) {
    fs.cpSync(copyFrom, targetRoot, { recursive: true });
    const nested = path.join(targetRoot, 'node_modules');
    if (fs.existsSync(nested)) fs.rmSync(nested, { recursive: true, force: true });
  }

  if (local) copyPackage(path.join(publisherDir, 'node_modules', 'eas-cli'));
  if (hoisted) copyPackage(path.join(root, 'node_modules', 'eas-cli'));
}

test('runPinnedEas subprocess streams stdout/stderr/stdin and propagates exit code', () => {
  if (process.platform !== 'darwin' || process.arch !== 'arm64') {
    return;
  }
  const sourcePublisher = path.join(repositoryRoot, 'ops/publisher-toolchain/node_modules/eas-cli');
  if (!fs.existsSync(sourcePublisher)) {
    return;
  }

  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'eas-cli-stream-'));
  const appDir = path.join(root, 'finance-app');
  const publisherDir = path.join(root, 'ops/publisher-toolchain');
  fs.mkdirSync(appDir, { recursive: true });
  fs.mkdirSync(publisherDir, { recursive: true });
  fs.cpSync(
    path.join(repositoryRoot, 'ops/publisher-toolchain/node_modules'),
    path.join(publisherDir, 'node_modules'),
    { recursive: true },
  );
  fs.writeFileSync(path.join(appDir, 'eas.json'), JSON.stringify({ cli: { version: '21.3.0' } }));
  fs.writeFileSync(path.join(publisherDir, 'package.json'), JSON.stringify({
    name: 'publisher-toolchain',
    version: '1.0.0',
    devDependencies: { 'eas-cli': '21.3.0' },
  }));
  fs.copyFileSync(
    path.join(repositoryRoot, 'ops/publisher-toolchain/package-lock.json'),
    path.join(publisherDir, 'package-lock.json'),
  );
  copyRuntimeClosureContract(root);

  const packageRoot = path.join(publisherDir, 'node_modules/eas-cli');
  const binPath = path.join(packageRoot, 'bin/run');
  const originalBin = fs.readFileSync(binPath, 'utf8');
  const binSource = `#!/usr/bin/env node
const fs = require('fs');
const input = fs.readFileSync(0, 'utf8');
process.stdout.write('OUT:' + (process.argv[2] || '') + ':' + input);
process.stderr.write('ERR:done');
process.exit(Number(process.argv[3] || 0));
`;
  fs.writeFileSync(binPath, binSource, { mode: 0o755 });

  const lock = JSON.parse(fs.readFileSync(path.join(publisherDir, 'package-lock.json'), 'utf8'));
  const computed = computeRuntimeClosureFromInstall(publisherDir, lock);
  const localContract = {
    ...readRuntimeClosureContract(root),
    runtimeClosureDigest: computed.runtimeClosureDigest,
    packageCount: computed.packageCount,
    fileCount: computed.fileCount,
  };
  fs.writeFileSync(
    path.join(root, 'ops/toolchain/eas-cli-runtime-closure.json'),
    JSON.stringify(localContract, null, 2),
  );

  const { result } = runPinnedEas(['hello', '7'], {
    appRoot: appDir,
    repoRoot: root,
    capture: true,
    allowNonZero: true,
    input: 'stdin-payload',
  });
  fs.writeFileSync(binPath, originalBin, { mode: 0o755 });
  assert.equal(result.status, 7);
  assert.match(result.stdout, /OUT:hello:stdin-payload/);
  assert.match(result.stderr, /ERR:done/);
});

test('assertStandaloneEasInstall rejects hoisted repository-root install layout on any platform', () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'eas-cli-hoist-'));
  writeEasFixture(root, { local: false, hoisted: true });
  const publisherDir = path.join(root, 'ops/publisher-toolchain');
  assert.throws(
    () => assertStandaloneEasInstall(publisherDir),
    /standalone eas-cli install/,
  );
  assert.throws(
    () => resolveEasPackageRoot(publisherDir),
    /standalone eas-cli install/,
  );
});

test('assertStandaloneEasInstall rejects symlinked eas-cli installs on any platform', () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'eas-cli-outside-'));
  writeEasFixture(root, { local: true, hoisted: false });
  const publisherDir = path.join(root, 'ops/publisher-toolchain');
  const outside = path.join(root, 'outside', 'eas-cli');
  fs.mkdirSync(outside, { recursive: true });
  fs.cpSync(path.join(publisherDir, 'node_modules/eas-cli'), outside, { recursive: true });
  fs.rmSync(path.join(publisherDir, 'node_modules/eas-cli'), { recursive: true, force: true });
  fs.symlinkSync(outside, path.join(publisherDir, 'node_modules/eas-cli'));
  assert.throws(
    () => assertStandaloneEasInstall(publisherDir),
    /must not be a symlink/,
  );
});

test('CLI run-pinned-eas.js propagates child stdout for --version', () => {
  if (process.platform !== 'darwin' || process.arch !== 'arm64') {
    return;
  }
  const result = spawnSync(process.execPath, [
    path.join(repositoryRoot, 'finance-app/scripts/run-pinned-eas.js'),
    '--version',
  ], { encoding: 'utf8' });
  assert.equal(result.status, 0);
  assert.match(result.stdout, /eas-cli\/21\.3\.0/);
});
