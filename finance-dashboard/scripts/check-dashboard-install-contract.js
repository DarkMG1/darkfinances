#!/usr/bin/env node
const fs = require('fs');
const os = require('os');
const path = require('path');
const { checkLockfileRepro } = require('../../scripts/check-lockfile-repro');

const DASHBOARD_ROOT = path.resolve(__dirname, '..');
const NESTED_LOCKFILE = path.join(DASHBOARD_ROOT, 'package-lock.json');
const PACKAGE_JSON = path.join(DASHBOARD_ROOT, 'package.json');

function readJson(filePath) {
  return JSON.parse(fs.readFileSync(filePath, 'utf8'));
}

function checkDashboardInstallContract() {
  if (!fs.existsSync(NESTED_LOCKFILE)) {
    throw new Error('finance-dashboard/package-lock.json is required');
  }

  const pkg = readJson(PACKAGE_JSON);
  const nested = readJson(NESTED_LOCKFILE);
  const nestedRoot = nested.packages?.[''];
  if (!nestedRoot) {
    throw new Error('finance-dashboard/package-lock.json is missing the root package entry');
  }
  if (nestedRoot.devDependencies) {
    throw new Error('finance-dashboard/package-lock.json must remain runtime-only and exclude devDependencies');
  }

  for (const name of Object.keys(pkg.dependencies || {})) {
    if (!nestedRoot.dependencies?.[name]) {
      throw new Error(`nested runtime lockfile is missing production dependency ${name}`);
    }
  }

  for (const name of Object.keys(nestedRoot.dependencies || {})) {
    if (!pkg.dependencies?.[name]) {
      throw new Error(`nested lockfile dependency ${name} is not listed under package.json dependencies`);
    }
  }

  if (nested.packages?.['node_modules/chart.js']) {
    throw new Error('runtime lockfile must not include chart.js; browser vendoring uses the root lockfile entry');
  }
}

function checkDashboardLockfileRepro() {
  const tempRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'dashboard-lock-repro-'));
  try {
    const pkg = readJson(PACKAGE_JSON);
    delete pkg.devDependencies;
    fs.writeFileSync(path.join(tempRoot, 'package.json'), `${JSON.stringify(pkg, null, 2)}\n`);
    fs.copyFileSync(NESTED_LOCKFILE, path.join(tempRoot, 'package-lock.json'));
    return checkLockfileRepro({ root: tempRoot });
  } finally {
    fs.rmSync(tempRoot, { recursive: true, force: true });
  }
}

function main() {
  try {
    checkDashboardInstallContract();
    const digest = checkDashboardLockfileRepro();
    console.log(`dashboard-install-contract: ok (runtime lockfile, repro ${digest.slice(0, 12)}…)`);
  } catch (error) {
    console.error(`dashboard-install-contract: ${error.message}`);
    process.exit(1);
  }
}

if (require.main === module) main();
module.exports = {
  checkDashboardInstallContract,
  checkDashboardLockfileRepro,
};
