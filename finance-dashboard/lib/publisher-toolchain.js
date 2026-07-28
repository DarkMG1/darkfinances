'use strict';

const path = require('path');
const {
  INVOCATION_LABEL,
  PACKAGE_NAME,
  STANDALONE_INSTALL_COMMAND,
  resolvePinnedEas,
  runPinnedEas,
} = require('./pinned-eas-cli');
const {
  isBoundPublisherPlatform,
  readRuntimeClosureContract,
  verifyRuntimeClosureContractFreshness,
} = require('./eas-cli-runtime-closure');

function fail(message) {
  throw new Error(message);
}

function readEasCliPin(rootDir) {
  return resolvePinnedEas(path.join(rootDir, 'finance-app'), rootDir).version;
}

function readDeclaredDevDependency(rootDir) {
  return resolvePinnedEas(path.join(rootDir, 'finance-app'), rootDir).version;
}

function readInstalledVersion(rootDir) {
  return resolvePinnedEas(path.join(rootDir, 'finance-app'), rootDir, { verifyInstalled: true }).version;
}

function verifyPublisherToolchain(rootDir = path.resolve(__dirname, '..', '..'), options = {}) {
  const freshness = verifyRuntimeClosureContractFreshness(rootDir, options);
  const contract = freshness.contract;
  const appRoot = path.join(rootDir, 'finance-app');
  const bound = isBoundPublisherPlatform(contract, options);
  if (bound || options.verifyInstalled) {
    const resolved = resolvePinnedEas(appRoot, rootDir, { ...options, verifyInstalled: true });
    return {
      package: resolved.package,
      version: resolved.version,
      integrity: resolved.integrity,
      invocation: resolved.invocation,
      runtimeClosureDigest: resolved.runtimeClosureDigest,
      packageCount: resolved.packageCount,
      fileCount: resolved.fileCount,
      platform: resolved.platform,
      arch: resolved.arch,
      derivationVersion: resolved.derivationVersion,
      standaloneInstallCommand: resolved.standaloneInstallCommand,
    };
  }
  return {
    package: PACKAGE_NAME,
    version: contract.version,
    integrity: contract.integrity,
    invocation: INVOCATION_LABEL,
    runtimeClosureDigest: contract.runtimeClosureDigest,
    packageCount: contract.packageCount,
    fileCount: contract.fileCount,
    platform: contract.platform,
    arch: contract.arch,
    derivationVersion: contract.derivationVersion,
    standaloneInstallCommand: STANDALONE_INSTALL_COMMAND,
  };
}

function runPinnedEasCli(rootDir, args, options = {}) {
  return runPinnedEas(args, {
    ...options,
    appRoot: path.join(rootDir, 'finance-app'),
    repoRoot: rootDir,
  });
}

function normalizePublisherToolchain(value, { requireField = false } = {}) {
  const allowed = new Set([
    'arch',
    'derivationVersion',
    'fileCount',
    'integrity',
    'invocation',
    'package',
    'packageCount',
    'platform',
    'runtimeClosureDigest',
    'standaloneInstallCommand',
    'version',
  ]);
  if (value === undefined) {
    if (requireField) fail('publisherToolchain is required for OTA evidence');
    return undefined;
  }
  if (!value || typeof value !== 'object' || Array.isArray(value)) {
    fail('publisherToolchain must be an object');
  }
  const unknown = Object.keys(value).filter((key) => !allowed.has(key)).sort();
  if (unknown.length > 0) {
    fail(`publisherToolchain contains unsupported field${unknown.length === 1 ? '' : 's'}: ${unknown.join(', ')}`);
  }
  const pkg = String(value.package || '');
  const version = String(value.version || '');
  const invocation = String(value.invocation || '');
  const integrity = String(value.integrity || '');
  const runtimeClosureDigest = String(value.runtimeClosureDigest || '');
  const platform = String(value.platform || '');
  const arch = String(value.arch || '');
  const standaloneInstallCommand = String(value.standaloneInstallCommand || '');
  const derivationVersion = Number(value.derivationVersion);
  const packageCount = Number(value.packageCount);
  const fileCount = Number(value.fileCount);
  if (pkg !== PACKAGE_NAME) fail(`publisherToolchain.package must be ${PACKAGE_NAME}`);
  if (!/^\d+\.\d+\.\d+$/.test(version)) fail('publisherToolchain.version must be an exact x.y.z version');
  if (!/^sha512-[A-Za-z0-9+/=]+$/.test(integrity)) {
    fail('publisherToolchain.integrity must be npm SRI sha512');
  }
  if (!/^[a-f0-9]{64}$/.test(runtimeClosureDigest)) {
    fail('publisherToolchain.runtimeClosureDigest must be sha256 hex');
  }
  if (!Number.isInteger(packageCount) || packageCount <= 0) {
    fail('publisherToolchain.packageCount must be a positive integer');
  }
  if (!Number.isInteger(fileCount) || fileCount <= 0) {
    fail('publisherToolchain.fileCount must be a positive integer');
  }
  if (!Number.isInteger(derivationVersion) || derivationVersion <= 0) {
    fail('publisherToolchain.derivationVersion must be a positive integer');
  }
  if (typeof platform !== 'string' || platform.length === 0) {
    fail('publisherToolchain.platform is required');
  }
  if (typeof arch !== 'string' || arch.length === 0) {
    fail('publisherToolchain.arch is required');
  }
  if (standaloneInstallCommand !== STANDALONE_INSTALL_COMMAND) {
    fail(`publisherToolchain.standaloneInstallCommand must be ${STANDALONE_INSTALL_COMMAND}`);
  }
  if (invocation !== INVOCATION_LABEL) {
    fail(`publisherToolchain.invocation must be ${INVOCATION_LABEL}`);
  }
  return {
    arch,
    derivationVersion,
    fileCount,
    integrity,
    invocation,
    package: pkg,
    packageCount,
    platform,
    runtimeClosureDigest,
    standaloneInstallCommand,
    version,
  };
}

module.exports = {
  PACKAGE_NAME,
  STANDALONE_INSTALL_COMMAND,
  normalizePublisherToolchain,
  readDeclaredDevDependency,
  readEasCliPin,
  readInstalledVersion,
  runPinnedEasCli,
  verifyPublisherToolchain,
};
