'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const os = require('os');
const path = require('path');
const { spawnSync } = require('child_process');
const { DASHBOARD_RUNTIME_FILES } = require('../../finance-dashboard/lib/release-files');
const { signaturePathFor } = require('../../finance-dashboard/lib/release-signing');
const { createEphemeralSigningMaterial } = require('./helpers/release-signing-fixtures');
const { writeProductionDashboard } = require('./fixtures/backup-bundle-dashboard-fixtures');

const REPOSITORY_ROOT = path.resolve(__dirname, '..', '..');
const SCRIPT = path.join(REPOSITORY_ROOT, 'ops/bin/write-dashboard-release-manifest.sh');
const temporaryDirectories = [];

test.after(() => {
  for (const directory of temporaryDirectories) {
    fs.rmSync(directory, { recursive: true, force: true });
  }
});

function tempDir(prefix) {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), prefix));
  temporaryDirectories.push(directory);
  return directory;
}

function deployDashboard(root, dashboardDir) {
  writeProductionDashboard(dashboardDir);
  for (const relative of DASHBOARD_RUNTIME_FILES) {
    const source = path.join(REPOSITORY_ROOT, 'finance-dashboard', relative);
    const destination = path.join(dashboardDir, relative);
    if (!fs.existsSync(source)) continue;
    fs.mkdirSync(path.dirname(destination), { recursive: true });
    fs.copyFileSync(source, destination);
    fs.chmodSync(destination, fs.statSync(source).mode & 0o777);
  }
}

function runScript(env, expectedStatus = 0) {
  const result = spawnSync('bash', [SCRIPT], {
    encoding: 'utf8',
    env,
  });
  assert.equal(result.status, expectedStatus, result.stderr || result.stdout);
  return result;
}

test('write-dashboard-release-manifest.sh fails without signing env and succeeds with ephemeral keys', () => {
  const root = tempDir('dashboard-release-manifest-shell-');
  const dashboard = path.join(root, 'dashboard');
  deployDashboard(root, dashboard);
  const destination = path.join(dashboard, 'release-manifest.json');
  const unsignedEnv = {
    ...process.env,
    DARKFINANCES_REPO_ROOT: REPOSITORY_ROOT,
    FINANCE_DASHBOARD_DIR: dashboard,
    RELEASE_MANIFEST_PATH: destination,
  };
  delete unsignedEnv.RELEASE_SIGNING_KEY_PATH;
  delete unsignedEnv.RELEASE_KEYRING_PATH;
  runScript(unsignedEnv, 1);

  const signing = createEphemeralSigningMaterial(root);
  const signedEnv = {
    ...unsignedEnv,
    ...signing.signingEnv,
  };
  runScript(signedEnv, 0);
  assert.equal(fs.existsSync(destination), true);
  assert.equal(fs.existsSync(signaturePathFor(destination)), true);
  const verify = spawnSync(process.execPath, [
    path.join(REPOSITORY_ROOT, 'scripts/release-manifest.js'),
    `--verify=${destination}`,
    `--keyring-path=${signing.keyringPath}`,
  ], { encoding: 'utf8', env: signedEnv });
  assert.equal(verify.status, 0, verify.stderr);
});

test('ios-build and ota-publish invoke production release-manifest generation and verification', () => {
  const iosBuild = fs.readFileSync(path.join(REPOSITORY_ROOT, 'finance-app/scripts/ios-build.sh'), 'utf8');
  assert.match(iosBuild, /--mode=ipa/);
  assert.match(iosBuild, /scripts\/release-manifest\.js/);
  assert.match(iosBuild, /--verify=/);
  assert.doesNotMatch(iosBuild, /--allow-unsigned/);
  assert.ok(iosBuild.indexOf('--source-digest') < iosBuild.lastIndexOf('release-manifest.js'));

  const otaPublish = fs.readFileSync(path.join(REPOSITORY_ROOT, 'finance-app/scripts/ota-publish.sh'), 'utf8');
  assert.match(otaPublish, /--mode=ota/);
  assert.match(otaPublish, /scripts\/release-manifest\.js/);
  assert.match(otaPublish, /--verify=/);
  assert.doesNotMatch(otaPublish, /--allow-unsigned/);
  assert.ok(otaPublish.indexOf('--source-digest') < otaPublish.lastIndexOf('eas-cli'));
});
