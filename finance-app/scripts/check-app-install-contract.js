#!/usr/bin/env node
const { spawnSync } = require('child_process');
const fs = require('fs');
const os = require('os');
const path = require('path');
const { sha256File } = require('../../scripts/check-lockfile-repro');

const APP_ROOT = path.resolve(__dirname, '..');

const EXPECTED_OVERRIDES = {
  postcss: '8.5.23',
  xcode: {
    uuid: '11.1.1',
  },
};

const WORKSPACE_ROOT_NAMES = new Set(['darkfinances', 'finance-dashboard', 'actual-tools']);

function resolveAppPaths(appRoot = APP_ROOT) {
  return {
    appRoot,
    packageJson: path.join(appRoot, 'package.json'),
    lockfile: path.join(appRoot, 'package-lock.json'),
  };
}

function readJson(filePath) {
  return JSON.parse(fs.readFileSync(filePath, 'utf8'));
}

function deepEqual(left, right) {
  return JSON.stringify(left) === JSON.stringify(right);
}

function checkPackageIdentity(pkg, lockRoot, lock) {
  if (lock.name && lock.name !== pkg.name) {
    throw new Error('finance-app lockfile top-level name must match package.json');
  }
  if (lockRoot.name !== pkg.name) {
    throw new Error('finance-app lockfile root package name must match package.json');
  }
  if (lockRoot.version !== pkg.version) {
    throw new Error('finance-app lockfile root package version must match package.json');
  }
}

function checkExpectedOverrides(pkg) {
  if (!deepEqual(pkg.overrides, EXPECTED_OVERRIDES)) {
    throw new Error('finance-app/package.json overrides do not match the expected install contract');
  }
}

function checkProductionDependencyParity(pkg, lockRoot) {
  for (const name of Object.keys(pkg.dependencies || {})) {
    if (!lockRoot.dependencies?.[name]) {
      throw new Error(`finance-app lockfile is missing production dependency ${name}`);
    }
  }

  for (const name of Object.keys(lockRoot.dependencies || {})) {
    if (!pkg.dependencies?.[name]) {
      throw new Error(`finance-app lockfile dependency ${name} is not listed under package.json dependencies`);
    }
  }
}

function checkDevDependencyParity(pkg, lockRoot) {
  for (const name of Object.keys(pkg.devDependencies || {})) {
    if (!lockRoot.devDependencies?.[name]) {
      throw new Error(`finance-app lockfile is missing devDependency ${name}`);
    }
  }

  for (const name of Object.keys(lockRoot.devDependencies || {})) {
    if (!pkg.devDependencies?.[name]) {
      throw new Error(`finance-app lockfile devDependency ${name} is not listed under package.json devDependencies`);
    }
  }
}

function checkOverrideResolution(lock) {
  const postcss = lock.packages?.['node_modules/postcss'];
  const uuid = lock.packages?.['node_modules/uuid'];
  if (!postcss || postcss.version !== '8.5.23') {
    throw new Error('finance-app lockfile must resolve postcss@8.5.23 via overrides');
  }
  if (!uuid || uuid.version !== '11.1.1') {
    throw new Error('finance-app lockfile must resolve uuid@11.1.1 via xcode override');
  }
}

function checkNoEasCliInApp(pkg, lock) {
  if (pkg.dependencies?.['eas-cli'] || pkg.devDependencies?.['eas-cli']) {
    throw new Error('finance-app must not declare eas-cli; publisher toolchain lives in ops/publisher-toolchain');
  }
  if (lock.packages?.['node_modules/eas-cli']) {
    throw new Error('finance-app/package-lock.json must not contain eas-cli');
  }
}

function checkNoWorkspaceFallback(lock, lockfilePath) {
  if (Array.isArray(lock.workspaces) && lock.workspaces.length > 0) {
    throw new Error('finance-app lockfile must not declare workspaces');
  }

  const lockRoot = lock.packages?.[''];
  if (!lockRoot || lockRoot.name !== 'finance-app') {
    throw new Error('finance-app lockfile root package must be finance-app');
  }

  for (const [pkgPath, entry] of Object.entries(lock.packages || {})) {
    if (!entry || typeof entry !== 'object') {
      continue;
    }
    if (entry.link === true || entry.workspace) {
      throw new Error(`finance-app lockfile must not use workspace links (${pkgPath})`);
    }
    if (WORKSPACE_ROOT_NAMES.has(entry.name)) {
      throw new Error(`finance-app lockfile must not fall back to workspace root package ${entry.name}`);
    }
  }

  const raw = fs.readFileSync(lockfilePath, 'utf8');
  if (/"\.\.\/\.\.\/|"file:\.\./.test(raw)) {
    throw new Error('finance-app lockfile must not reference parent workspace paths');
  }
}

function checkAppInstallContractAt(appRoot = APP_ROOT) {
  const { packageJson, lockfile } = resolveAppPaths(appRoot);
  if (!fs.existsSync(lockfile)) {
    throw new Error('finance-app/package-lock.json is required');
  }

  const pkg = readJson(packageJson);
  const lock = readJson(lockfile);
  const lockRoot = lock.packages?.[''];
  if (!lockRoot) {
    throw new Error('finance-app/package-lock.json is missing the root package entry');
  }

  checkPackageIdentity(pkg, lockRoot, lock);
  checkExpectedOverrides(pkg);
  checkProductionDependencyParity(pkg, lockRoot);
  checkDevDependencyParity(pkg, lockRoot);
  checkOverrideResolution(lock);
  checkNoEasCliInApp(pkg, lock);
  checkNoWorkspaceFallback(lock, lockfile);
}

function checkAppInstallContract() {
  checkAppInstallContractAt(APP_ROOT);
}

function checkAppLockfileReproAt(appRoot = APP_ROOT, { runNpm = spawnSync } = {}) {
  const { packageJson, lockfile } = resolveAppPaths(appRoot);
  const tempRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'app-lock-repro-'));
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
      throw new Error('finance-app/package-lock.json changed after package-lock-only regeneration');
    }
    return before;
  } finally {
    fs.rmSync(tempRoot, { recursive: true, force: true });
  }
}

function checkAppLockfileRepro(options = {}) {
  return checkAppLockfileReproAt(APP_ROOT, options);
}

function main() {
  try {
    checkAppInstallContractAt();
    const digest = checkAppLockfileReproAt();
    console.log(`app-install-contract: ok (standalone lockfile, repro ${digest.slice(0, 12)}…)`);
  } catch (error) {
    console.error(`app-install-contract: ${error.message}`);
    process.exit(1);
  }
}

if (require.main === module) main();
module.exports = {
  EXPECTED_OVERRIDES,
  checkAppInstallContract,
  checkAppInstallContractAt,
  checkAppLockfileRepro,
  checkAppLockfileReproAt,
  checkNoEasCliInApp,
};
