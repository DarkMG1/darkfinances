#!/usr/bin/env node
const { spawnSync } = require('child_process');
const fs = require('fs');
const os = require('os');
const path = require('path');
const { sha256File } = require('./check-lockfile-repro');
const { PACKAGE_NAME, PUBLISHER_ROOT_REL } = require('../finance-dashboard/lib/eas-cli-runtime-closure');

const REPO_ROOT = path.resolve(__dirname, '..');
const PUBLISHER_ROOT = path.join(REPO_ROOT, ...PUBLISHER_ROOT_REL.split('/'));
const EXPECTED_TYPESCRIPT_OVERRIDE = '5.9.3';

const WORKSPACE_ROOT_NAMES = new Set(['darkfinances', 'finance-dashboard', 'finance-app', 'actual-tools']);

function resolvePublisherPaths(publisherRoot = PUBLISHER_ROOT) {
  return {
    publisherRoot,
    packageJson: path.join(publisherRoot, 'package.json'),
    lockfile: path.join(publisherRoot, 'package-lock.json'),
  };
}

function readJson(filePath) {
  return JSON.parse(fs.readFileSync(filePath, 'utf8'));
}

function normalizeRootWorkspaces(workspaces) {
  if (workspaces == null) return [];
  if (Array.isArray(workspaces)) {
    return workspaces.map((entry) => String(entry));
  }
  if (typeof workspaces === 'object' && !Array.isArray(workspaces)) {
    if (Array.isArray(workspaces.packages)) {
      return workspaces.packages.map((entry) => String(entry));
    }
    throw new Error('root package.json workspaces object must declare a packages array');
  }
  throw new Error('root package.json workspaces must be an array or { packages: [] } object');
}

function workspacePatternCouldMatchPublisherToolchain(pattern) {
  const raw = String(pattern).replace(/^\.\//, '');
  const normalized = path.posix.normalize(raw).replace(/\/+$/, '');
  if (normalized.length === 0) {
    throw new Error('root workspaces must not contain empty patterns');
  }
  // Keep the workspace boundary closed-world. Reimplementing npm's brace,
  // bracket, and extglob semantics here would create bypasses as npm evolves.
  if (/[*?[\]{}()\\]/.test(raw) || raw.startsWith('!')) return true;
  if (normalized === PUBLISHER_ROOT_REL) return true;
  if (normalized === 'publisher-toolchain' || normalized.endsWith('/publisher-toolchain')) return true;
  return false;
}

function checkPublisherNotWorkspaceMember(repoRoot = REPO_ROOT) {
  const rootPkg = readJson(path.join(repoRoot, 'package.json'));
  const patterns = normalizeRootWorkspaces(rootPkg.workspaces);
  const rootLockPath = path.join(repoRoot, 'package-lock.json');
  if (!fs.existsSync(rootLockPath)) {
    throw new Error('root package-lock.json is required');
  }
  const rootLock = readJson(rootLockPath);
  const lockPatterns = normalizeRootWorkspaces(rootLock.packages?.['']?.workspaces);
  if (JSON.stringify(patterns) !== JSON.stringify(lockPatterns)) {
    throw new Error('root package.json and package-lock.json workspace lists must match exactly');
  }
  for (const pattern of patterns) {
    if (workspacePatternCouldMatchPublisherToolchain(pattern)) {
      throw new Error(
        `root workspaces pattern "${pattern}" can include ${PUBLISHER_ROOT_REL}; publisher toolchain must remain isolated`,
      );
    }
  }
}

function checkNoEasCliAtRoot(repoRoot = REPO_ROOT) {
  const rootPkg = readJson(path.join(repoRoot, 'package.json'));
  if (rootPkg.dependencies?.[PACKAGE_NAME] || rootPkg.devDependencies?.[PACKAGE_NAME]) {
    throw new Error(`root package.json must not declare ${PACKAGE_NAME}; use ${PUBLISHER_ROOT_REL}`);
  }
  const rootLockPath = path.join(repoRoot, 'package-lock.json');
  if (!fs.existsSync(rootLockPath)) {
    throw new Error('root package-lock.json is required');
  }
  const rootLock = readJson(rootLockPath);
  if (rootLock.packages?.[`node_modules/${PACKAGE_NAME}`]) {
    throw new Error(`root package-lock.json must not contain node_modules/${PACKAGE_NAME}`);
  }
}

function checkExactEasDevDependency(pkg) {
  const version = pkg.devDependencies?.[PACKAGE_NAME];
  if (typeof version !== 'string' || !/^\d+\.\d+\.\d+$/.test(version)) {
    throw new Error(`${PUBLISHER_ROOT_REL}/package.json must declare exact devDependency ${PACKAGE_NAME}@x.y.z`);
  }
}

function checkTypescriptOverrideContract(pkg, lock) {
  const override = pkg.overrides?.typescript;
  if (override !== EXPECTED_TYPESCRIPT_OVERRIDE) {
    throw new Error(
      `${PUBLISHER_ROOT_REL}/package.json must override typescript@${EXPECTED_TYPESCRIPT_OVERRIDE} for reproducible npm 10 peer resolution`,
    );
  }
  const typescriptEntry = lock.packages?.['node_modules/typescript'];
  if (!typescriptEntry || typescriptEntry.version !== EXPECTED_TYPESCRIPT_OVERRIDE) {
    throw new Error(
      `${PUBLISHER_ROOT_REL}/package-lock.json must resolve typescript@${EXPECTED_TYPESCRIPT_OVERRIDE} via overrides`,
    );
  }
}

function checkLockEasEntry(lock) {
  const entry = lock.packages?.[`node_modules/${PACKAGE_NAME}`];
  if (!entry?.version || !entry?.integrity) {
    throw new Error(`${PUBLISHER_ROOT_REL}/package-lock.json must contain node_modules/${PACKAGE_NAME} version/integrity`);
  }
  if (!/^sha512-[A-Za-z0-9+/=]+$/.test(entry.integrity)) {
    throw new Error(`${PUBLISHER_ROOT_REL}/package-lock.json eas-cli integrity must be npm SRI sha512`);
  }
}

function checkNoWorkspaceFallback(lock, lockfilePath) {
  if (Array.isArray(lock.workspaces) && lock.workspaces.length > 0) {
    throw new Error(`${PUBLISHER_ROOT_REL} lockfile must not declare workspaces`);
  }

  const lockRoot = lock.packages?.[''];
  if (!lockRoot || lockRoot.name !== 'publisher-toolchain') {
    throw new Error(`${PUBLISHER_ROOT_REL} lockfile root package must be publisher-toolchain`);
  }

  for (const [pkgPath, entry] of Object.entries(lock.packages || {})) {
    if (!entry || typeof entry !== 'object') {
      continue;
    }
    if (entry.link === true || entry.workspace) {
      throw new Error(`${PUBLISHER_ROOT_REL} lockfile must not use workspace links (${pkgPath})`);
    }
    if (WORKSPACE_ROOT_NAMES.has(entry.name)) {
      throw new Error(`${PUBLISHER_ROOT_REL} lockfile must not fall back to workspace root package ${entry.name}`);
    }
  }

  const raw = fs.readFileSync(lockfilePath, 'utf8');
  if (/"\.\.\/\.\.\/|"file:\.\./.test(raw)) {
    throw new Error(`${PUBLISHER_ROOT_REL} lockfile must not reference parent workspace paths`);
  }
}

function checkPublisherInstallContractAt(publisherRoot = PUBLISHER_ROOT, repoRoot = REPO_ROOT) {
  const { packageJson, lockfile } = resolvePublisherPaths(publisherRoot);
  if (!fs.existsSync(lockfile)) {
    throw new Error(`${PUBLISHER_ROOT_REL}/package-lock.json is required`);
  }

  checkPublisherNotWorkspaceMember(repoRoot);
  checkNoEasCliAtRoot(repoRoot);
  const pkg = readJson(packageJson);
  const lock = readJson(lockfile);
  checkExactEasDevDependency(pkg);
  checkTypescriptOverrideContract(pkg, lock);
  checkLockEasEntry(lock);
  checkNoWorkspaceFallback(lock, lockfile);
}

function checkPublisherInstallContract(options = {}) {
  checkPublisherInstallContractAt(options.publisherRoot, options.repoRoot);
}

function checkPublisherLockfileReproAt(publisherRoot = PUBLISHER_ROOT, { runNpm = spawnSync } = {}) {
  const { packageJson, lockfile } = resolvePublisherPaths(publisherRoot);
  const tempRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'publisher-lock-repro-'));
  try {
    fs.copyFileSync(packageJson, path.join(tempRoot, 'package.json'));
    fs.copyFileSync(lockfile, path.join(tempRoot, 'package-lock.json'));
    const tempLockfile = path.join(tempRoot, 'package-lock.json');
    const before = sha256File(tempLockfile);
    const install = runNpm('npm', ['install', '--package-lock-only', '--ignore-scripts', '--no-workspaces'], {
      cwd: tempRoot,
      encoding: 'utf8',
      env: { ...process.env, npm_config_audit: 'false', npm_config_fund: 'false' },
    });
    if (install.status !== 0) {
      throw new Error(install.stderr || install.stdout || 'npm install --package-lock-only failed');
    }
    const after = sha256File(tempLockfile);
    if (before !== after) {
      throw new Error(`${PUBLISHER_ROOT_REL}/package-lock.json changed after package-lock-only regeneration`);
    }
    return before;
  } finally {
    fs.rmSync(tempRoot, { recursive: true, force: true });
  }
}

function checkPublisherLockfileRepro(options = {}) {
  return checkPublisherLockfileReproAt(options.publisherRoot, options);
}

function main() {
  try {
    checkPublisherInstallContractAt();
    const digest = checkPublisherLockfileReproAt();
    console.log(`publisher-install-contract: ok (isolated lockfile, repro ${digest.slice(0, 12)}…)`);
  } catch (error) {
    console.error(`publisher-install-contract: ${error.message}`);
    process.exit(1);
  }
}

if (require.main === module) main();
module.exports = {
  EXPECTED_TYPESCRIPT_OVERRIDE,
  checkPublisherInstallContract,
  checkPublisherInstallContractAt,
  checkPublisherLockfileRepro,
  checkPublisherLockfileReproAt,
  checkPublisherNotWorkspaceMember,
  checkNoEasCliAtRoot,
  normalizeRootWorkspaces,
  workspacePatternCouldMatchPublisherToolchain,
};
