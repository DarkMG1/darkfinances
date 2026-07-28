#!/usr/bin/env node
'use strict';

const fs = require('fs');
const os = require('os');
const path = require('path');
const { spawnSync } = require('child_process');

const REPOSITORY_ROOT = path.resolve(__dirname, '..');
const SYSTEMD_DIR = path.join(REPOSITORY_ROOT, 'ops/systemd');

function writeFixtureFile(filePath, contents, mode = 0o644) {
  fs.mkdirSync(path.dirname(filePath), { recursive: true, mode: 0o700 });
  fs.writeFileSync(filePath, contents, { mode });
}

function systemdAnalyzeAvailable(spawn = spawnSync) {
  const result = spawn('systemd-analyze', ['--version'], { encoding: 'utf8' });
  return result.status === 0;
}

function checkSystemdUnits(options = {}) {
  const spawn = options.spawnSync || spawnSync;
  const sourceDir = options.systemdDir || SYSTEMD_DIR;
  if (!systemdAnalyzeAvailable(spawn)) {
    return { skipped: true, reason: 'systemd-analyze not installed' };
  }

  const fixtureRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'darkfinances-systemd-verify-'));
  try {
    const fixtureHome = path.join(fixtureRoot, 'home');
    const fixtureUnits = path.join(fixtureRoot, 'units');
    writeFixtureFile(path.join(fixtureHome, '.local/bin/actual-sync.sh'), '#!/bin/sh\nexit 0\n', 0o755);
    writeFixtureFile(
      path.join(fixtureHome, '.local/bin/finance-sync-alert.sh'),
      '#!/bin/sh\nexit 0\n',
      0o755,
    );
    writeFixtureFile(path.join(fixtureHome, 'finance-dashboard/server.js'), '');
    writeFixtureFile(path.join(fixtureHome, '.openclaw/finance-dashboard.env'), '');
    writeFixtureFile(path.join(fixtureHome, 'actual-tools/run.sh'), '#!/bin/sh\nexit 0\n', 0o755);

    const unitPaths = fs.readdirSync(sourceDir)
      .filter((name) => name.endsWith('.service') || name.endsWith('.timer'))
      .sort()
      .map((name) => {
        const target = path.join(fixtureUnits, name);
        const source = fs.readFileSync(path.join(sourceDir, name), 'utf8');
        writeFixtureFile(target, source.replaceAll('%h', fixtureHome));
        return target;
      });

    const result = spawn('systemd-analyze', ['--user', 'verify', ...unitPaths], {
      encoding: 'utf8',
      env: { ...process.env, HOME: fixtureHome },
    });
    if (result.status !== 0) {
      throw new Error(result.stderr || result.stdout || 'systemd-analyze verify failed');
    }
    return { skipped: false, unitCount: unitPaths.length };
  } finally {
    fs.rmSync(fixtureRoot, { recursive: true, force: true });
  }
}

function main() {
  try {
    const result = checkSystemdUnits();
    if (result.skipped) {
      process.stdout.write(`systemd-check: skipped (${result.reason})\n`);
      return;
    }
    process.stdout.write(`systemd-check: ok (${result.unitCount} units)\n`);
  } catch (error) {
    process.stderr.write(`systemd-check: ${error.message}\n`);
    process.exitCode = 1;
  }
}

if (require.main === module) main();

module.exports = {
  checkSystemdUnits,
  systemdAnalyzeAvailable,
};
