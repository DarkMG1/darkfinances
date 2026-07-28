'use strict';

const crypto = require('crypto');
const fs = require('fs');
const path = require('path');

const PACKAGE_NAME = 'eas-cli';
const CONTRACT_REL = 'ops/toolchain/eas-cli-runtime-closure.json';
const PUBLISHER_ROOT_REL = 'ops/publisher-toolchain';
const STANDALONE_INSTALL_COMMAND = `npm --prefix ${PUBLISHER_ROOT_REL} ci --workspaces=false`;
const DERIVATION_VERSION = 2;
const INTEGRITY_PATTERN = /^sha512-[A-Za-z0-9+/=]+$/;
const DIGEST_PATTERN = /^[a-f0-9]{64}$/;
const ALLOWED_NODE_MODULES_METADATA = new Set(['.bin', '.package-lock.json']);
const BOUND_PUBLISHER_PLATFORM = 'darwin';
const BOUND_PUBLISHER_ARCH = 'arm64';

const CONTRACT_TOP_KEYS = new Set([
  'arch',
  'derivationVersion',
  'fileCount',
  'integrity',
  'lockfilePath',
  'lockfileSha256',
  'package',
  'packageCount',
  'platform',
  'provenance',
  'runtimeClosureDigest',
  'schemaVersion',
  'standaloneInstallCommand',
  'version',
]);

function fail(message) {
  throw new Error(message);
}

function readJson(filePath) {
  return JSON.parse(fs.readFileSync(filePath, 'utf8'));
}

function resolvePublisherRoot(repoRoot) {
  return path.join(repoRoot, ...PUBLISHER_ROOT_REL.split('/'));
}

function hashFileSha256(filePath) {
  return crypto.createHash('sha256').update(fs.readFileSync(filePath)).digest('hex');
}

function normalizeModeFromInstall(statMode) {
  const bits = statMode & 0o777;
  if ((bits & 0o111) !== 0) return 0o755;
  return 0o644;
}

function canonicalFileEntry(relativePath, mode, contentHash) {
  return `${relativePath}\0${mode}\0${contentHash}`;
}

function digestFileEntries(entries) {
  const lines = entries
    .slice()
    .sort((left, right) => left.path.localeCompare(right.path))
    .map((entry) => canonicalFileEntry(entry.path, entry.mode, entry.contentHash));
  return crypto.createHash('sha256').update(lines.join('\n'), 'utf8').digest('hex');
}

function assertRealNonSymlinkDirectory(dirPath, label) {
  if (!fs.existsSync(dirPath)) fail(`${label} missing`);
  const stat = fs.lstatSync(dirPath);
  if (stat.isSymbolicLink()) fail(`${label} must not be a symlink`);
  if (!stat.isDirectory()) fail(`${label} must be a directory`);
  return fs.realpathSync(dirPath);
}

function collectPhysicalPackageLockPaths(modulesDir, lockPrefix = 'node_modules') {
  if (!fs.existsSync(modulesDir)) return [];
  assertRealNonSymlinkDirectory(modulesDir, lockPrefix);
  const paths = [];

  for (const name of fs.readdirSync(modulesDir).sort()) {
    if (ALLOWED_NODE_MODULES_METADATA.has(name)) {
      continue;
    }
    const absolute = path.join(modulesDir, name);
    const stat = fs.lstatSync(absolute);
    if (stat.isSymbolicLink()) {
      fail(`runtime install contains symlink under ${lockPrefix}: ${name}`);
    }
    if (stat.isSocket() || stat.isFIFO() || stat.isBlockDevice() || stat.isCharacterDevice()) {
      fail(`runtime install contains special file under ${lockPrefix}: ${name}`);
    }
    if (!stat.isDirectory()) {
      fail(`runtime install unexpected non-directory under ${lockPrefix}: ${name}`);
    }

    if (name.startsWith('@')) {
      for (const subName of fs.readdirSync(absolute).sort()) {
        const subAbs = path.join(absolute, subName);
        const subStat = fs.lstatSync(subAbs);
        if (subStat.isSymbolicLink()) {
          fail(`runtime install contains symlink under ${lockPrefix}/${name}: ${subName}`);
        }
        if (!subStat.isDirectory()) {
          fail(`runtime install invalid scoped entry under ${lockPrefix}/${name}: ${subName}`);
        }
        const scopedLock = `${lockPrefix}/${name}/${subName}`;
        if (!fs.existsSync(path.join(subAbs, 'package.json'))) {
          fail(`runtime scoped package missing package.json: ${scopedLock}`);
        }
        paths.push(scopedLock);
        const nestedModules = path.join(subAbs, 'node_modules');
        if (fs.existsSync(nestedModules)) {
          paths.push(...collectPhysicalPackageLockPaths(nestedModules, `${scopedLock}/node_modules`));
        }
      }
      continue;
    }

    const childLock = `${lockPrefix}/${name}`;
    if (!fs.existsSync(path.join(absolute, 'package.json'))) {
      fail(`runtime package missing package.json: ${childLock}`);
    }
    paths.push(childLock);
    const nestedModules = path.join(absolute, 'node_modules');
    if (fs.existsSync(nestedModules)) {
      paths.push(...collectPhysicalPackageLockPaths(nestedModules, `${childLock}/node_modules`));
    }
  }

  return paths;
}

function assertPhysicalInstallMatchesLockPaths(publisherRoot, lockPaths) {
  const modulesDir = path.join(publisherRoot, 'node_modules');
  if (!fs.existsSync(modulesDir)) {
    fail(`runtime install missing node_modules; run ${STANDALONE_INSTALL_COMMAND}`);
  }
  const physical = collectPhysicalPackageLockPaths(modulesDir).sort();
  const expected = [...lockPaths].sort();
  if (physical.length === expected.length && physical.every((value, index) => value === expected[index])) {
    return;
  }
  const extra = physical.filter((entry) => !expected.includes(entry));
  const missing = expected.filter((entry) => !physical.includes(entry));
  if (extra.length > 0) {
    fail(`runtime install contains packages outside lock closure: ${extra.join(', ')}`);
  }
  if (missing.length > 0) {
    fail(`runtime install missing lock closure packages: ${missing.join(', ')}`);
  }
  fail('runtime install physical package set does not match lock closure');
}

function assertBoundPublisherPlatformForClosureRegen(options = {}) {
  const platform = options.platform ?? process.platform;
  const arch = options.arch ?? process.arch;
  if (platform !== BOUND_PUBLISHER_PLATFORM || arch !== BOUND_PUBLISHER_ARCH) {
    fail(
      `runtime closure regeneration requires ${BOUND_PUBLISHER_PLATFORM}/${BOUND_PUBLISHER_ARCH}; current ${platform}/${arch}`,
    );
  }
}

function walkPackagePayload(packageRoot) {
  const entries = [];
  const seen = new Set();
  const seenLower = new Set();
  const resolvedRoot = fs.realpathSync(packageRoot);

  function walk(currentDir, relativePrefix = '') {
    for (const name of fs.readdirSync(currentDir).sort()) {
      if (name === 'node_modules') continue;
      const relativePath = relativePrefix ? `${relativePrefix}/${name}` : name;
      const absolutePath = path.join(currentDir, name);
      let stat;
      try {
        stat = fs.lstatSync(absolutePath);
      } catch (error) {
        if (error.code === 'ENOENT') continue;
        throw error;
      }
      if (stat.isSymbolicLink()) fail(`runtime package contains symlink: ${relativePath}`);
      if (stat.isSocket() || stat.isFIFO() || stat.isBlockDevice() || stat.isCharacterDevice()) {
        fail(`runtime package contains special file: ${relativePath}`);
      }
      const realPath = fs.realpathSync(absolutePath);
      const relativeToRoot = path.relative(resolvedRoot, realPath);
      if (relativeToRoot.startsWith('..') || path.isAbsolute(relativeToRoot)) {
        fail(`runtime package path escapes package root: ${relativePath}`);
      }
      if (seen.has(relativePath)) fail(`runtime package duplicate path: ${relativePath}`);
      if (seenLower.has(relativePath.toLowerCase())) {
        fail(`runtime package case-colliding path: ${relativePath}`);
      }
      seen.add(relativePath);
      seenLower.add(relativePath.toLowerCase());
      if (stat.isDirectory()) {
        walk(absolutePath, relativePath);
        continue;
      }
      if (!stat.isFile()) fail(`runtime package unexpected entry type: ${relativePath}`);
      entries.push({
        path: relativePath.replaceAll('\\', '/'),
        mode: normalizeModeFromInstall(stat.mode),
        contentHash: crypto.createHash('sha256').update(fs.readFileSync(absolutePath)).digest('hex'),
      });
    }
  }

  walk(resolvedRoot);
  return entries;
}

function enumerateNodeModulesRoots(fromLockPath) {
  if (!fromLockPath) return [''];
  const roots = [fromLockPath];
  let current = fromLockPath;
  while (true) {
    const index = current.lastIndexOf('/node_modules/');
    if (index >= 0) {
      current = current.slice(0, index);
      roots.push(current);
      continue;
    }
    if (current.startsWith('node_modules/')) {
      roots.push('');
    }
    break;
  }
  return roots;
}

function resolveLockDependencyCandidates(fromLockPath, depName) {
  const seen = new Set();
  const candidates = [];
  for (const root of enumerateNodeModulesRoots(fromLockPath)) {
    const candidate = root ? `${root}/node_modules/${depName}` : `node_modules/${depName}`;
    if (seen.has(candidate)) continue;
    seen.add(candidate);
    candidates.push(candidate);
  }
  return candidates;
}

function resolveLockDependency(fromLockPath, depName, lock) {
  for (const candidate of resolveLockDependencyCandidates(fromLockPath, depName)) {
    if (lock.packages?.[candidate]) return candidate;
  }
  return null;
}

function deriveClosureLockPaths(lock, rootLockPath = `node_modules/${PACKAGE_NAME}`) {
  if (!lock.packages?.[rootLockPath]) fail(`lockfile missing ${rootLockPath}`);
  const seen = new Set();
  const queue = [rootLockPath];
  while (queue.length > 0) {
    const lockPath = queue.shift();
    if (seen.has(lockPath)) continue;
    seen.add(lockPath);
    const pkg = lock.packages[lockPath];
    if (!pkg) fail(`lockfile missing package entry ${lockPath}`);
    for (const depName of Object.keys(pkg.dependencies || {})) {
      const resolved = resolveLockDependency(lockPath, depName, lock);
      if (!resolved) {
        fail(`required dependency ${depName} of ${lockPath} is unresolved in lockfile`);
      }
      queue.push(resolved);
    }
    for (const section of ['optionalDependencies', 'peerDependencies']) {
      const deps = pkg[section] || {};
      for (const depName of Object.keys(deps)) {
        const resolved = resolveLockDependency(lockPath, depName, lock);
        if (resolved) queue.push(resolved);
      }
    }
  }
  return [...seen].sort();
}

function lockPathToAbsolute(publisherRoot, lockPath) {
  return path.join(publisherRoot, ...lockPath.split('/'));
}

function assertUnderPublisherNodeModules(publisherRoot, absolutePath) {
  const modulesRoot = fs.realpathSync(path.join(publisherRoot, 'node_modules'));
  const realPath = fs.realpathSync(absolutePath);
  if (realPath !== modulesRoot && !realPath.startsWith(`${modulesRoot}${path.sep}`)) {
    fail(`runtime package resolves outside ${PUBLISHER_ROOT_REL}/node_modules: ${realPath}`);
  }
  return realPath;
}

function packageRecordLine(record) {
  return `${record.lockPath}\0${record.name}\0${record.version}\0${record.packagePayloadDigest}`;
}

function digestRuntimeClosure(packageRecords) {
  const lines = packageRecords
    .slice()
    .sort((left, right) => left.lockPath.localeCompare(right.lockPath))
    .map((record) => packageRecordLine(record));
  return crypto.createHash('sha256').update(lines.join('\n'), 'utf8').digest('hex');
}

function computeRuntimeClosureFromInstall(publisherRoot, lock, options = {}) {
  const rootLockPath = `node_modules/${PACKAGE_NAME}`;
  const lockPaths = deriveClosureLockPaths(lock, rootLockPath);
  assertPhysicalInstallMatchesLockPaths(publisherRoot, lockPaths);
  const packageRecords = [];
  let fileCount = 0;

  for (const lockPath of lockPaths) {
    const lockEntry = lock.packages[lockPath];
    const absolutePath = lockPathToAbsolute(publisherRoot, lockPath);
    if (!fs.existsSync(path.join(absolutePath, 'package.json'))) {
      fail(`runtime closure package missing on disk: ${lockPath}; run ${STANDALONE_INSTALL_COMMAND}`);
    }
    if (fs.lstatSync(absolutePath).isSymbolicLink()) {
      fail(`runtime closure package path must not be a symlink: ${lockPath}`);
    }
    const packageRoot = assertUnderPublisherNodeModules(publisherRoot, absolutePath);
    const installed = readJson(path.join(packageRoot, 'package.json'));
    const installedName = installed.name || path.basename(lockPath.split('/node_modules/').pop());
    if (lockEntry.version && installed.version !== lockEntry.version) {
      fail(`runtime package ${lockPath} version mismatch: installed ${installed.version}, lock ${lockEntry.version}`);
    }
    const fileEntries = walkPackagePayload(packageRoot);
    fileCount += fileEntries.length;
    packageRecords.push({
      lockPath,
      name: installedName,
      version: installed.version,
      packagePayloadDigest: digestFileEntries(fileEntries),
      fileCount: fileEntries.length,
    });
  }

  return {
    packageRecords,
    packageCount: packageRecords.length,
    fileCount,
    runtimeClosureDigest: digestRuntimeClosure(packageRecords),
  };
}

function readRuntimeClosureContract(repoRoot) {
  const contractPath = path.join(repoRoot, CONTRACT_REL);
  const contract = readJson(contractPath);
  const unknown = Object.keys(contract).filter((key) => !CONTRACT_TOP_KEYS.has(key)).sort();
  if (unknown.length > 0) {
    fail(`runtime closure contract contains unsupported field${unknown.length === 1 ? '' : 's'}: ${unknown.join(', ')}`);
  }
  if (contract.schemaVersion !== 1) fail(`unsupported runtime closure schemaVersion: ${contract.schemaVersion}`);
  if (contract.derivationVersion !== DERIVATION_VERSION) {
    fail(`unsupported runtime closure derivationVersion: ${contract.derivationVersion}`);
  }
  if (contract.package !== PACKAGE_NAME) fail(`runtime closure contract package must be ${PACKAGE_NAME}`);
  if (!/^\d+\.\d+\.\d+$/.test(contract.version)) fail('runtime closure contract version must be x.y.z');
  if (!INTEGRITY_PATTERN.test(contract.integrity)) fail('runtime closure contract integrity must be npm SRI sha512');
  if (!DIGEST_PATTERN.test(contract.runtimeClosureDigest)) fail('runtime closure contract runtimeClosureDigest must be sha256 hex');
  if (!DIGEST_PATTERN.test(contract.lockfileSha256)) fail('runtime closure contract lockfileSha256 must be sha256 hex');
  if (!Number.isInteger(contract.packageCount) || contract.packageCount <= 0) {
    fail('runtime closure contract packageCount must be a positive integer');
  }
  if (!Number.isInteger(contract.fileCount) || contract.fileCount <= 0) {
    fail('runtime closure contract fileCount must be a positive integer');
  }
  if (contract.standaloneInstallCommand !== STANDALONE_INSTALL_COMMAND) {
    fail(`runtime closure contract standaloneInstallCommand must be ${STANDALONE_INSTALL_COMMAND}`);
  }
  if (typeof contract.platform !== 'string' || typeof contract.arch !== 'string') {
    fail('runtime closure contract platform and arch are required');
  }
  const expectedLockfilePath = `${PUBLISHER_ROOT_REL}/package-lock.json`;
  if (contract.lockfilePath !== expectedLockfilePath) {
    fail(`runtime closure contract lockfilePath must be ${expectedLockfilePath}`);
  }
  if (typeof contract.provenance !== 'string' || contract.provenance.length === 0) {
    fail('runtime closure contract provenance is required');
  }
  return contract;
}

function assertStandaloneEasInstall(publisherRoot) {
  const localRoot = path.join(publisherRoot, 'node_modules', PACKAGE_NAME);
  const packageJson = path.join(localRoot, 'package.json');
  if (!fs.existsSync(packageJson)) {
    fail(
      `publisher requires standalone eas-cli install at ${PUBLISHER_ROOT_REL}/node_modules/${PACKAGE_NAME}; run ${STANDALONE_INSTALL_COMMAND}`,
    );
  }
  if (fs.lstatSync(localRoot).isSymbolicLink()) {
    fail(`${PUBLISHER_ROOT_REL}/node_modules/${PACKAGE_NAME} must not be a symlink`);
  }
  return fs.realpathSync(localRoot);
}

function readEasCliPinFromApp(appRoot) {
  const easJson = readJson(path.join(appRoot, 'eas.json'));
  const version = easJson?.cli?.version;
  if (typeof version !== 'string' || !/^\d+\.\d+\.\d+$/.test(version)) {
    fail('finance-app/eas.json cli.version must be an exact x.y.z pin');
  }
  return version;
}

function readDeclaredEasDevDependency(publisherRoot) {
  const pkg = readJson(path.join(publisherRoot, 'package.json'));
  const version = pkg.devDependencies?.[PACKAGE_NAME];
  if (typeof version !== 'string' || !/^\d+\.\d+\.\d+$/.test(version)) {
    fail(`${PUBLISHER_ROOT_REL}/package.json must declare exact devDependency ${PACKAGE_NAME}@x.y.z`);
  }
  return version;
}

function readBoundEasLockIntegrities(repoRoot) {
  const publisherRoot = resolvePublisherRoot(repoRoot);
  const publisherLock = path.join(publisherRoot, 'package-lock.json');
  if (!fs.existsSync(publisherLock)) {
    fail(`lockfile not found: ${publisherLock}`);
  }
  const publisherLockJson = readJson(publisherLock);
  const publisherEntry = publisherLockJson.packages?.[`node_modules/${PACKAGE_NAME}`];
  if (!publisherEntry?.version || !publisherEntry?.integrity) {
    fail(`${publisherLock} is missing node_modules/${PACKAGE_NAME} version/integrity`);
  }
  if (!INTEGRITY_PATTERN.test(publisherEntry.integrity)) {
    fail('eas-cli integrity must be npm SRI sha512 in publisher lockfile');
  }
  return {
    version: publisherEntry.version,
    integrity: publisherEntry.integrity,
    publisherLock: publisherLockJson,
  };
}

function verifyRuntimeClosureContractFreshness(repoRoot, options = {}) {
  const contract = readRuntimeClosureContract(repoRoot);
  const appRoot = path.join(repoRoot, 'finance-app');
  const publisherRoot = resolvePublisherRoot(repoRoot);
  const pinned = readEasCliPinFromApp(appRoot);
  const declared = readDeclaredEasDevDependency(publisherRoot);
  if (pinned !== declared) {
    fail(`eas-cli pin mismatch: eas.json=${pinned}, ${PUBLISHER_ROOT_REL}/package.json=${declared}`);
  }
  const { version, integrity, publisherLock } = readBoundEasLockIntegrities(repoRoot);
  if (version !== contract.version || integrity !== contract.integrity) {
    fail('runtime closure contract eas-cli version/integrity does not match lockfiles and pins');
  }
  if (pinned !== contract.version) {
    fail('runtime closure contract eas-cli version does not match eas.json/package.json pins');
  }
  const lockPath = path.join(repoRoot, contract.lockfilePath);
  const lockSha256 = hashFileSha256(lockPath);
  if (lockSha256 !== contract.lockfileSha256) {
    fail(`${contract.lockfilePath} SHA-256 does not match runtime closure contract`);
  }
  const lockPaths = deriveClosureLockPaths(publisherLock);
  if (lockPaths.length !== contract.packageCount) {
    fail(`runtime closure lock-derived package count ${lockPaths.length} does not match contract ${contract.packageCount}`);
  }
  const rootEntry = publisherLock.packages?.[`node_modules/${PACKAGE_NAME}`];
  if (!rootEntry?.integrity || rootEntry.integrity !== contract.integrity) {
    fail('runtime closure contract eas-cli integrity does not match publisher lockfile');
  }
  if (rootEntry.version !== contract.version) {
    fail('runtime closure contract eas-cli version does not match publisher lockfile');
  }
  return { contract, lockPaths, publisherLock };
}

function isBoundPublisherPlatform(contract, options = {}) {
  const platform = options.platform || process.platform;
  const arch = options.arch || process.arch;
  return platform === contract.platform && arch === contract.arch;
}

function verifyRuntimeClosure(publisherRoot, repoRoot, contract, options = {}) {
  if (!options.skipFreshness) {
    verifyRuntimeClosureContractFreshness(repoRoot, options);
  }
  if (!isBoundPublisherPlatform(contract, options) && !options.allowPlatformMismatch) {
    fail(
      `runtime closure contract is bound to ${contract.platform}/${contract.arch}; current publisher is ${options.platform || process.platform}/${options.arch || process.arch}. OTA publishing requires the supported standalone install on the bound platform.`,
    );
  }

  assertStandaloneEasInstall(publisherRoot);
  const lock = readJson(path.join(repoRoot, contract.lockfilePath));

  const computed = computeRuntimeClosureFromInstall(publisherRoot, lock);
  if (computed.packageCount !== contract.packageCount) {
    fail(`runtime closure package count ${computed.packageCount} does not match contract ${contract.packageCount}`);
  }
  if (computed.fileCount !== contract.fileCount) {
    fail(`runtime closure file count ${computed.fileCount} does not match contract ${contract.fileCount}`);
  }
  if (computed.runtimeClosureDigest !== contract.runtimeClosureDigest) {
    fail('installed runtime closure digest does not match checked-in contract');
  }
  return computed;
}

module.exports = {
  ALLOWED_NODE_MODULES_METADATA,
  BOUND_PUBLISHER_ARCH,
  BOUND_PUBLISHER_PLATFORM,
  CONTRACT_REL,
  DERIVATION_VERSION,
  PACKAGE_NAME,
  PUBLISHER_ROOT_REL,
  STANDALONE_INSTALL_COMMAND,
  assertBoundPublisherPlatformForClosureRegen,
  assertPhysicalInstallMatchesLockPaths,
  assertRealNonSymlinkDirectory,
  assertStandaloneEasInstall,
  assertUnderPublisherNodeModules,
  collectPhysicalPackageLockPaths,
  computeRuntimeClosureFromInstall,
  deriveClosureLockPaths,
  digestFileEntries,
  digestRuntimeClosure,
  enumerateNodeModulesRoots,
  hashFileSha256,
  isBoundPublisherPlatform,
  lockPathToAbsolute,
  readBoundEasLockIntegrities,
  readDeclaredEasDevDependency,
  readEasCliPinFromApp,
  readRuntimeClosureContract,
  resolveLockDependency,
  resolveLockDependencyCandidates,
  resolvePublisherRoot,
  verifyRuntimeClosure,
  verifyRuntimeClosureContractFreshness,
  walkPackagePayload,
};
