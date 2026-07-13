#!/usr/bin/env node
const { spawnSync } = require('child_process');
const crypto = require('crypto');
const fs = require('fs');
const path = require('path');

const defaultRoot = path.resolve(__dirname, '..');

function sha256File(file) {
  const hash = crypto.createHash('sha256');
  hash.update(fs.readFileSync(file));
  return hash.digest('hex');
}

function fail(message) {
  console.error(`lockfile-repro: ${message}`);
  process.exit(1);
}

function checkLockfileRepro({ root = defaultRoot, runNpm = spawnSync } = {}) {
  const lockfile = path.join(root, 'package-lock.json');
  const before = sha256File(lockfile);
  const install = runNpm('npm', ['ci', '--ignore-scripts'], {
    cwd: root,
    encoding: 'utf8',
    env: { ...process.env, npm_config_audit: 'false', npm_config_fund: 'false' },
  });
  if (install.status !== 0) {
    throw new Error(install.stderr || install.stdout || 'npm ci failed');
  }
  const after = sha256File(lockfile);
  if (before !== after) {
    throw new Error('package-lock.json changed after npm ci');
  }
  return before;
}

function main() {
  try {
    const before = checkLockfileRepro();
    console.log(`lockfile-repro: ok (${before.slice(0, 12)}…)`);
  } catch (error) {
    fail(error.message);
  }
}

if (require.main === module) main();
module.exports = { checkLockfileRepro, sha256File };
