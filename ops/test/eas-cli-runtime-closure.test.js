'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const os = require('os');
const path = require('path');
const {
  assertBoundPublisherPlatformForClosureRegen,
  computeRuntimeClosureFromInstall,
  deriveClosureLockPaths,
  digestFileEntries,
  digestRuntimeClosure,
  readRuntimeClosureContract,
  verifyRuntimeClosure,
  verifyRuntimeClosureContractFreshness,
  walkPackagePayload,
} = require('../../finance-dashboard/lib/eas-cli-runtime-closure');
const { verifyPublisherToolchain } = require('../../finance-dashboard/lib/publisher-toolchain');

const repositoryRoot = path.resolve(__dirname, '..', '..');
const appRoot = path.join(repositoryRoot, 'finance-app');
const contract = readRuntimeClosureContract(repositoryRoot);
const BOUND_PLATFORM = process.platform === 'darwin' && process.arch === 'arm64';

test('readRuntimeClosureContract loads checked-in runtime closure metadata', () => {
  assert.equal(contract.package, 'eas-cli');
  assert.equal(contract.version, '21.3.0');
  assert.match(contract.integrity, /^sha512-/);
  assert.match(contract.runtimeClosureDigest, /^[a-f0-9]{64}$/);
  assert.equal(
    contract.standaloneInstallCommand,
    'npm --prefix ops/publisher-toolchain ci --workspaces=false --ignore-scripts',
  );
  assert.equal(contract.packageCount, 510);
  assert.ok(contract.fileCount > contract.packageCount);
});

test('runtime closure regeneration is restricted to darwin/arm64', () => {
  assert.doesNotThrow(() => assertBoundPublisherPlatformForClosureRegen({
    platform: 'darwin',
    arch: 'arm64',
  }));
  assert.throws(
    () => assertBoundPublisherPlatformForClosureRegen({ platform: 'linux', arch: 'x64' }),
    /requires darwin\/arm64/,
  );
});

test('verifyRuntimeClosureContractFreshness validates lock/pins on every platform', () => {
  assert.doesNotThrow(() => verifyRuntimeClosureContractFreshness(repositoryRoot, {
    platform: 'linux',
    arch: 'x64',
  }));
  const freshness = verifyRuntimeClosureContractFreshness(repositoryRoot);
  assert.ok(freshness.lockPaths.includes('node_modules/@oclif/core'));
  assert.equal(freshness.lockPaths.length, contract.packageCount);
});

test('verifyRuntimeClosure accepts standalone publisher-toolchain install on bound platform', { skip: !BOUND_PLATFORM }, () => {
  const publisherRoot = path.join(repositoryRoot, 'ops/publisher-toolchain');
  if (!fs.existsSync(path.join(publisherRoot, 'node_modules/eas-cli'))) {
    assert.fail(
      'standalone publisher-toolchain eas-cli install required; '
      + 'run npm --prefix ops/publisher-toolchain ci --workspaces=false --ignore-scripts',
    );
  }
  assert.doesNotThrow(() => verifyRuntimeClosure(publisherRoot, repositoryRoot, contract));
});

test('verifyRuntimeClosure rejects wrong platform before reading installed bytes', () => {
  assert.throws(
    () => verifyRuntimeClosure(appRoot, repositoryRoot, contract, { platform: 'linux', arch: 'x64' }),
    /runtime closure contract is bound to darwin\/arm64/,
  );
});

test('tampering hoisted @oclif/core fails verifyRuntimeClosure and verifyPublisherToolchain', { skip: !BOUND_PLATFORM }, () => {
  const publisherRoot = path.join(repositoryRoot, 'ops/publisher-toolchain');
  if (!fs.existsSync(path.join(publisherRoot, 'node_modules/@oclif/core/lib/index.js'))) {
    assert.fail('expected @oclif/core install under ops/publisher-toolchain/node_modules');
  }
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'runtime-closure-oclif-'));
  const fixturePublisher = path.join(root, 'ops/publisher-toolchain');
  fs.cpSync(publisherRoot, fixturePublisher, { recursive: true });
  fs.mkdirSync(path.join(root, 'finance-app'), { recursive: true });
  fs.copyFileSync(path.join(appRoot, 'eas.json'), path.join(root, 'finance-app/eas.json'));
  fs.mkdirSync(path.join(root, 'ops/toolchain'), { recursive: true });
  fs.writeFileSync(
    path.join(root, 'ops/toolchain/eas-cli-runtime-closure.json'),
    JSON.stringify(contract, null, 2),
  );

  const oclifIndex = path.join(fixturePublisher, 'node_modules/@oclif/core/lib/index.js');
  fs.appendFileSync(oclifIndex, '\n// tampered\n');

  assert.throws(
    () => verifyRuntimeClosure(fixturePublisher, root, contract),
    /installed runtime closure digest does not match checked-in contract/,
  );
  assert.throws(
    () => verifyPublisherToolchain(root, { verifyInstalled: true }),
    /installed runtime closure digest does not match checked-in contract/,
  );
});

test('deriveClosureLockPaths includes hoisted @oclif/core for publisher lockfile', () => {
  const lock = JSON.parse(fs.readFileSync(path.join(repositoryRoot, 'ops/publisher-toolchain/package-lock.json'), 'utf8'));
  const closure = deriveClosureLockPaths(lock);
  assert.ok(closure.includes('node_modules/@oclif/core'));
});

test('verifyRuntimeClosure rejects tampered eas-cli package.json version', () => {
  if (process.platform !== 'darwin' || process.arch !== 'arm64') return;
  const publisherRoot = path.join(repositoryRoot, 'ops/publisher-toolchain');
  if (!fs.existsSync(path.join(publisherRoot, 'node_modules/eas-cli'))) return;

  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'runtime-closure-version-'));
  const fixturePublisher = path.join(root, 'ops/publisher-toolchain');
  fs.cpSync(publisherRoot, fixturePublisher, { recursive: true });
  fs.mkdirSync(path.join(root, 'finance-app'), { recursive: true });
  fs.copyFileSync(path.join(appRoot, 'eas.json'), path.join(root, 'finance-app/eas.json'));
  fs.mkdirSync(path.join(root, 'ops/toolchain'), { recursive: true });
  fs.writeFileSync(
    path.join(root, 'ops/toolchain/eas-cli-runtime-closure.json'),
    JSON.stringify(contract, null, 2),
  );

  const pkgPath = path.join(fixturePublisher, 'node_modules/eas-cli/package.json');
  const pkg = JSON.parse(fs.readFileSync(pkgPath, 'utf8'));
  pkg.version = '21.3.1';
  fs.writeFileSync(pkgPath, JSON.stringify(pkg, null, 2));

  assert.throws(
    () => verifyRuntimeClosure(fixturePublisher, root, contract),
    /version mismatch|installed runtime closure digest/,
  );
});

test('walkPackagePayload rejects symlink members', () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'runtime-closure-symlink-'));
  const packageRoot = path.join(root, 'pkg');
  fs.mkdirSync(packageRoot, { recursive: true });
  fs.writeFileSync(path.join(packageRoot, 'package.json'), '{}');
  fs.symlinkSync('/etc/hosts', path.join(packageRoot, 'link.txt'));
  assert.throws(() => walkPackagePayload(packageRoot), /symlink/);
});

test('digestRuntimeClosure is order-independent', () => {
  const records = [
    { lockPath: 'node_modules/b', name: 'b', version: '1.0.0', packagePayloadDigest: 'b'.repeat(64) },
    { lockPath: 'node_modules/a', name: 'a', version: '1.0.0', packagePayloadDigest: 'a'.repeat(64) },
  ];
  assert.equal(
    digestRuntimeClosure(records.slice()),
    digestRuntimeClosure(records.reverse()),
  );
});

test('digestFileEntries is order-independent', () => {
  const entries = [
    { path: 'b.txt', mode: 0o644, contentHash: 'b'.repeat(64) },
    { path: 'a.txt', mode: 0o755, contentHash: 'a'.repeat(64) },
  ];
  assert.equal(digestFileEntries(entries.slice()), digestFileEntries(entries.reverse()));
});

test('computeRuntimeClosureFromInstall rejects packages resolved outside publisher-toolchain/node_modules', () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'runtime-closure-outside-'));
  const fixturePublisher = path.join(root, 'ops/publisher-toolchain');
  const outsidePkg = path.join(root, 'outside-pkg');
  fs.mkdirSync(path.join(outsidePkg, 'bin'), { recursive: true });
  fs.writeFileSync(path.join(outsidePkg, 'package.json'), JSON.stringify({
    name: 'eas-cli',
    version: '21.3.0',
    bin: { eas: 'bin/run' },
  }));
  fs.writeFileSync(path.join(outsidePkg, 'bin/run'), '#!/usr/bin/env node\n');
  fs.mkdirSync(path.join(fixturePublisher, 'node_modules'), { recursive: true });
  fs.symlinkSync(outsidePkg, path.join(fixturePublisher, 'node_modules/eas-cli'));
  const lock = {
    lockfileVersion: 3,
    packages: {
      '': { name: 'publisher-toolchain', version: '1.0.0' },
      'node_modules/eas-cli': { version: '21.3.0', integrity: contract.integrity },
    },
  };
  assert.throws(
    () => computeRuntimeClosureFromInstall(fixturePublisher, lock),
    /contains symlink under node_modules|must not be a symlink|outside lock closure/,
  );
});

test('computeRuntimeClosureFromInstall rejects extra top-level package outside lock closure', { skip: !BOUND_PLATFORM }, () => {
  const publisherRoot = path.join(repositoryRoot, 'ops/publisher-toolchain');
  const lock = JSON.parse(fs.readFileSync(path.join(publisherRoot, 'package-lock.json'), 'utf8'));
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'runtime-closure-extra-top-'));
  const fixturePublisher = path.join(root, 'ops/publisher-toolchain');
  fs.cpSync(publisherRoot, fixturePublisher, { recursive: true });
  const evilDir = path.join(fixturePublisher, 'node_modules/evil');
  fs.mkdirSync(evilDir, { recursive: true });
  fs.writeFileSync(path.join(evilDir, 'package.json'), JSON.stringify({ name: 'evil', version: '1.0.0' }));
  assert.throws(
    () => computeRuntimeClosureFromInstall(fixturePublisher, lock),
    /outside lock closure: node_modules\/evil/,
  );
});

test('computeRuntimeClosureFromInstall rejects nested extra package outside lock closure', { skip: !BOUND_PLATFORM }, () => {
  const publisherRoot = path.join(repositoryRoot, 'ops/publisher-toolchain');
  const lock = JSON.parse(fs.readFileSync(path.join(publisherRoot, 'package-lock.json'), 'utf8'));
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'runtime-closure-extra-nested-'));
  const fixturePublisher = path.join(root, 'ops/publisher-toolchain');
  fs.cpSync(publisherRoot, fixturePublisher, { recursive: true });
  const nestedEvil = path.join(fixturePublisher, 'node_modules/eas-cli/node_modules/evil');
  fs.mkdirSync(nestedEvil, { recursive: true });
  fs.writeFileSync(path.join(nestedEvil, 'package.json'), JSON.stringify({ name: 'evil', version: '1.0.0' }));
  assert.throws(
    () => computeRuntimeClosureFromInstall(fixturePublisher, lock),
    /outside lock closure: node_modules\/eas-cli\/node_modules\/evil/,
  );
});

test('computeRuntimeClosureFromInstall allows npm metadata directories at node_modules root', { skip: !BOUND_PLATFORM }, () => {
  const publisherRoot = path.join(repositoryRoot, 'ops/publisher-toolchain');
  const lock = JSON.parse(fs.readFileSync(path.join(publisherRoot, 'package-lock.json'), 'utf8'));
  assert.doesNotThrow(() => computeRuntimeClosureFromInstall(publisherRoot, lock));
});
