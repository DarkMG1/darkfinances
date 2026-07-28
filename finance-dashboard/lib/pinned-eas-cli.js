'use strict';

const fs = require('fs');
const os = require('os');
const path = require('path');
const { spawnSync } = require('child_process');
const {
  PACKAGE_NAME,
  PUBLISHER_ROOT_REL,
  STANDALONE_INSTALL_COMMAND,
  assertRealNonSymlinkDirectory,
  assertStandaloneEasInstall,
  isBoundPublisherPlatform,
  readRuntimeClosureContract,
  resolvePublisherRoot,
  verifyRuntimeClosure,
  verifyRuntimeClosureContractFreshness,
} = require('./eas-cli-runtime-closure');

const BIN_NAME = 'eas';
const INVOCATION_LABEL = 'node finance-app/scripts/run-pinned-eas.js';
const INTEGRITY_PATTERN = /^sha512-[A-Za-z0-9+/=]+$/;
const INJECTION_ENV_VARS = [
  'NODE_OPTIONS',
  'NODE_PATH',
  'LD_PRELOAD',
  'LD_LIBRARY_PATH',
  'DYLD_INSERT_LIBRARIES',
  'DYLD_LIBRARY_PATH',
  'DYLD_FRAMEWORK_PATH',
  'DYLD_FALLBACK_LIBRARY_PATH',
  'DYLD_FALLBACK_FRAMEWORK_PATH',
];

function fail(message) {
  throw new Error(message);
}

function readJson(filePath) {
  return JSON.parse(fs.readFileSync(filePath, 'utf8'));
}

function sanitizePublisherSpawnEnv(env) {
  const sanitized = { ...env };
  for (const key of INJECTION_ENV_VARS) {
    delete sanitized[key];
  }
  return sanitized;
}

function copyPublisherSnapshot(sourcePublisherRoot, destinationPublisherRoot, options = {}) {
  const copySync = options.copySync || fs.cpSync;
  copySync(sourcePublisherRoot, destinationPublisherRoot, { recursive: true, verbatimSymlinks: true });
}

function prepareVerifiedPublisherSnapshot(sourcePublisherRoot, repoRoot, contract, options = {}) {
  assertRealNonSymlinkDirectory(sourcePublisherRoot, `${PUBLISHER_ROOT_REL} source root`);
  const mkdtempSync = options.mkdtempSync || fs.mkdtempSync;
  const rmSync = options.rmSync || fs.rmSync;
  const snapshotRoot = mkdtempSync(path.join(os.tmpdir(), 'darkfinances-publisher-'));
  const snapshotPublisherRoot = path.join(snapshotRoot, 'publisher-toolchain');
  try {
    copyPublisherSnapshot(sourcePublisherRoot, snapshotPublisherRoot, options);
    assertRealNonSymlinkDirectory(snapshotPublisherRoot, 'publisher snapshot root');
    verifyRuntimeClosure(snapshotPublisherRoot, repoRoot, contract, {
      ...options,
      skipFreshness: true,
    });
    const packageRoot = assertStandaloneEasInstall(snapshotPublisherRoot);
    const binPath = resolveEasBinPath(packageRoot);
    const realSnapshotPublisherRoot = fs.realpathSync(snapshotPublisherRoot);
    if (!binPath.startsWith(`${realSnapshotPublisherRoot}${path.sep}`)) {
      fail('eas binary must resolve inside verified publisher snapshot');
    }
    return {
      snapshotRoot,
      snapshotPublisherRoot: realSnapshotPublisherRoot,
      packageRoot,
      binPath,
      cleanup: () => rmSync(snapshotRoot, { recursive: true, force: true }),
    };
  } catch (error) {
    rmSync(snapshotRoot, { recursive: true, force: true });
    throw error;
  }
}

function readEasCliPin(appRoot) {
  const easJson = readJson(path.join(appRoot, 'eas.json'));
  const version = easJson?.cli?.version;
  if (typeof version !== 'string' || !/^\d+\.\d+\.\d+$/.test(version)) {
    fail('finance-app/eas.json cli.version must be an exact x.y.z pin');
  }
  return version;
}

function readDeclaredDevDependency(publisherRoot) {
  const pkg = readJson(path.join(publisherRoot, 'package.json'));
  const version = pkg.devDependencies?.[PACKAGE_NAME];
  if (typeof version !== 'string' || !/^\d+\.\d+\.\d+$/.test(version)) {
    fail(`${PUBLISHER_ROOT_REL}/package.json must declare exact devDependency ${PACKAGE_NAME}@x.y.z`);
  }
  return version;
}

function readLockfileEntry(lockfilePath) {
  if (!fs.existsSync(lockfilePath)) fail(`lockfile not found: ${lockfilePath}`);
  const lock = readJson(lockfilePath);
  const entry = lock.packages?.[`node_modules/${PACKAGE_NAME}`];
  if (!entry?.version || !entry?.integrity) {
    fail(`${lockfilePath} is missing node_modules/${PACKAGE_NAME} version/integrity`);
  }
  if (!INTEGRITY_PATTERN.test(entry.integrity)) {
    fail(`${lockfilePath} eas-cli integrity must be npm SRI sha512`);
  }
  return { version: entry.version, integrity: entry.integrity };
}

function readBoundIntegrities(repoRoot) {
  const publisherLock = path.join(resolvePublisherRoot(repoRoot), 'package-lock.json');
  return readLockfileEntry(publisherLock).integrity;
}

function resolveEasPackageRoot(publisherRoot) {
  return assertStandaloneEasInstall(publisherRoot);
}

function resolveEasBinPath(packageRoot) {
  const pkg = readJson(path.join(packageRoot, 'package.json'));
  const binEntry = pkg.bin?.[BIN_NAME];
  if (typeof binEntry !== 'string' || binEntry.length === 0) {
    fail(`${PACKAGE_NAME} package.json must declare bin.${BIN_NAME}`);
  }
  const absoluteBin = path.resolve(packageRoot, binEntry);
  const relative = path.relative(packageRoot, absoluteBin);
  if (relative.startsWith('..') || path.isAbsolute(relative)) {
    fail(`${PACKAGE_NAME} bin.${BIN_NAME} must resolve inside package root`);
  }
  let stat;
  try {
    stat = fs.lstatSync(absoluteBin);
  } catch (error) {
    if (error.code === 'ENOENT') fail(`eas binary missing at ${absoluteBin}`);
    throw error;
  }
  if (stat.isSymbolicLink()) fail(`eas binary must not be a symlink: ${absoluteBin}`);
  if (!stat.isFile()) fail(`eas binary must be a regular file: ${absoluteBin}`);
  const realBin = fs.realpathSync(absoluteBin);
  const realRoot = fs.realpathSync(packageRoot);
  if (!realBin.startsWith(`${realRoot}${path.sep}`)) {
    fail(`eas binary realpath escapes package root: ${realBin}`);
  }
  return realBin;
}

function verifyRuntimeClosureForPublisher(appRoot, repoRoot, options = {}) {
  const publisherRoot = resolvePublisherRoot(repoRoot);
  const freshness = verifyRuntimeClosureContractFreshness(repoRoot, options);
  const contract = freshness.contract;
  if (!isBoundPublisherPlatform(contract, options) && !options.verifyInstalled) {
    return {
      contract,
      runtimeClosureDigest: contract.runtimeClosureDigest,
      packageCount: contract.packageCount,
      fileCount: contract.fileCount,
      platform: contract.platform,
      arch: contract.arch,
      derivationVersion: contract.derivationVersion,
    };
  }
  const computed = verifyRuntimeClosure(publisherRoot, repoRoot, contract, {
    ...options,
    skipFreshness: true,
  });
  return {
    contract,
    runtimeClosureDigest: computed.runtimeClosureDigest,
    packageCount: computed.packageCount,
    fileCount: computed.fileCount,
    platform: contract.platform,
    arch: contract.arch,
    derivationVersion: contract.derivationVersion,
  };
}

function resolvePinnedEas(appRoot, repoRoot, options = {}) {
  const publisherRoot = resolvePublisherRoot(repoRoot);
  const pinned = readEasCliPin(appRoot);
  const declared = readDeclaredDevDependency(publisherRoot);
  if (pinned !== declared) {
    fail(`eas-cli pin mismatch: eas.json=${pinned}, ${PUBLISHER_ROOT_REL}/package.json=${declared}`);
  }
  const integrity = readBoundIntegrities(repoRoot);
  const runtime = verifyRuntimeClosureForPublisher(appRoot, repoRoot, options);
  const contract = runtime.contract;
  const bound = isBoundPublisherPlatform(contract, options);
  if (bound || options.verifyInstalled) {
    const packageRoot = resolveEasPackageRoot(publisherRoot);
    const installed = readJson(path.join(packageRoot, 'package.json')).version;
    if (installed !== pinned) {
      fail(`installed eas-cli@${installed} does not match pinned ${pinned}`);
    }
    if (contract.version !== pinned || contract.integrity !== integrity) {
      fail('runtime closure contract does not match pinned eas-cli lock metadata');
    }
    const binPath = resolveEasBinPath(packageRoot);
    return {
      appRoot,
      repoRoot,
      publisherRoot,
      packageRoot,
      binPath,
      package: PACKAGE_NAME,
      version: pinned,
      integrity,
      runtimeClosureDigest: runtime.runtimeClosureDigest,
      packageCount: runtime.packageCount,
      fileCount: runtime.fileCount,
      platform: runtime.platform,
      arch: runtime.arch,
      derivationVersion: runtime.derivationVersion,
      standaloneInstallCommand: STANDALONE_INSTALL_COMMAND,
      invocation: INVOCATION_LABEL,
    };
  }
  return {
    appRoot,
    repoRoot,
    publisherRoot,
    packageRoot: null,
    binPath: null,
    package: PACKAGE_NAME,
    version: pinned,
    integrity,
    runtimeClosureDigest: runtime.runtimeClosureDigest,
    packageCount: runtime.packageCount,
    fileCount: runtime.fileCount,
    platform: runtime.platform,
    arch: runtime.arch,
    derivationVersion: runtime.derivationVersion,
    standaloneInstallCommand: STANDALONE_INSTALL_COMMAND,
    invocation: INVOCATION_LABEL,
  };
}

function runPinnedEas(args, options = {}) {
  const appRoot = options.appRoot;
  const repoRoot = options.repoRoot;
  if (!appRoot || !repoRoot) fail('runPinnedEas requires appRoot and repoRoot');
  const resolved = resolvePinnedEas(appRoot, repoRoot, { ...options, verifyInstalled: true });
  if (!resolved.binPath) {
    fail('runPinnedEas requires the bound publisher platform with standalone publisher-toolchain install');
  }
  const contract = readRuntimeClosureContract(repoRoot);
  const snapshot = prepareVerifiedPublisherSnapshot(resolved.publisherRoot, repoRoot, contract, options);
  try {
    const spawn = options.spawnSync || spawnSync;
    const capture = options.capture === true;
    const spawnOptions = {
      cwd: options.cwd || appRoot,
      env: sanitizePublisherSpawnEnv(options.env || process.env),
    };
    if (capture) {
      spawnOptions.encoding = options.encoding || 'utf8';
      spawnOptions.stdio = options.input != null ? ['pipe', 'pipe', 'pipe'] : ['inherit', 'pipe', 'pipe'];
      spawnOptions.input = options.input;
    } else {
      spawnOptions.stdio = options.stdio || 'inherit';
      if (options.input != null) {
        spawnOptions.stdio = ['pipe', 'inherit', 'inherit'];
        spawnOptions.input = options.input;
      }
    }
    const invocationEvidence = {
      ...resolved,
      binPath: snapshot.binPath,
      packageRoot: snapshot.packageRoot,
      publisherRoot: snapshot.snapshotPublisherRoot,
      snapshotRoot: snapshot.snapshotRoot,
    };
    const result = spawn(process.execPath, [snapshot.binPath, ...args], spawnOptions);
    if (result.error) fail(`eas invocation failed: ${result.error.message}`);
    if (!options.allowNonZero && result.status !== 0) {
      if (capture) {
        fail(result.stderr || result.stdout || `eas ${args.join(' ')} failed`);
      }
      return { evidence: invocationEvidence, result };
    }
    return { evidence: invocationEvidence, result };
  } finally {
    snapshot.cleanup();
  }
}

module.exports = {
  BIN_NAME,
  INJECTION_ENV_VARS,
  INVOCATION_LABEL,
  PACKAGE_NAME,
  STANDALONE_INSTALL_COMMAND,
  copyPublisherSnapshot,
  prepareVerifiedPublisherSnapshot,
  resolveEasBinPath,
  resolveEasPackageRoot,
  resolvePinnedEas,
  runPinnedEas,
  sanitizePublisherSpawnEnv,
  verifyRuntimeClosureForPublisher,
};
