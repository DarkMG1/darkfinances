#!/usr/bin/env node
const { spawnSync } = require('child_process');
const path = require('path');
const { sha256File } = require('./release-manifest');

const root = path.resolve(__dirname, '..');
const lockfile = path.join(root, 'package-lock.json');

function fail(message) {
  console.error(`lockfile-repro: ${message}`);
  process.exit(1);
}

const before = sha256File(lockfile);
const install = spawnSync('npm', ['ci', '--ignore-scripts'], {
  cwd: root,
  encoding: 'utf8',
  env: { ...process.env, npm_config_audit: 'false', npm_config_fund: 'false' },
});
if (install.status !== 0) {
  fail(install.stderr || install.stdout || 'npm ci failed');
}
const after = sha256File(lockfile);
if (before !== after) {
  fail('package-lock.json changed after npm ci');
}
console.log(`lockfile-repro: ok (${before.slice(0, 12)}…)`);
