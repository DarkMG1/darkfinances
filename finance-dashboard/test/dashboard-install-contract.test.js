const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const path = require('path');
const {
  checkDashboardInstallContract,
  checkDashboardLockfileRepro,
} = require('../scripts/check-dashboard-install-contract');

test('finance-dashboard runtime lockfile remains present and runtime-only', () => {
  assert.doesNotThrow(() => checkDashboardInstallContract());
});

test('finance-dashboard runtime lockfile reproduces with npm ci', () => {
  assert.doesNotThrow(() => checkDashboardLockfileRepro());
});

test('finance-dashboard runtime lockfile contract rejects devDependency entries', () => {
  const nestedLockfile = path.join(__dirname, '..', 'package-lock.json');
  const original = fs.readFileSync(nestedLockfile, 'utf8');
  const nested = JSON.parse(original);
  nested.packages[''].devDependencies = { 'chart.js': '4.4.0' };
  fs.writeFileSync(nestedLockfile, `${JSON.stringify(nested, null, 2)}\n`);
  try {
    assert.throws(
      () => checkDashboardInstallContract(),
      /must remain runtime-only and exclude devDependencies/,
    );
  } finally {
    fs.writeFileSync(nestedLockfile, original);
    checkDashboardInstallContract();
  }
});
