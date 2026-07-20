#!/usr/bin/env node
const { spawnSync } = require('child_process');
const { readDeclaredNpmVersion } = require('./package-manager');

function spawnCommand(command, args, options = {}) {
  return spawnSync(command, args, {
    encoding: 'utf8',
    ...options,
  });
}

function readActiveNpmVersion(runCommand = spawnCommand) {
  const result = runCommand('npm', ['--version']);
  if (result.status !== 0) {
    throw new Error(result.stderr || result.stdout || 'npm --version failed');
  }
  return result.stdout.trim();
}

function ensureDeclaredNpm({ runCommand = spawnCommand, declaredVersion = readDeclaredNpmVersion() } = {}) {
  const active = readActiveNpmVersion(runCommand);
  if (active === declaredVersion) {
    return { declaredVersion, activeVersion: active, changed: false };
  }

  const install = runCommand('npm', ['install', '-g', `npm@${declaredVersion}`]);
  if (install.status !== 0) {
    throw new Error(install.stderr || install.stdout || `failed to install npm@${declaredVersion}`);
  }

  const verified = readActiveNpmVersion(runCommand);
  if (verified !== declaredVersion) {
    throw new Error(`expected npm@${declaredVersion} after install, got npm@${verified}`);
  }

  return { declaredVersion, activeVersion: verified, changed: true };
}

function main() {
  try {
    const result = ensureDeclaredNpm();
    const suffix = result.changed ? ' (installed)' : '';
    console.log(`ensure-declared-npm: ok (npm@${result.activeVersion}${suffix})`);
  } catch (error) {
    console.error(`ensure-declared-npm: ${error.message}`);
    process.exit(1);
  }
}

if (require.main === module) main();
module.exports = { ensureDeclaredNpm, readActiveNpmVersion };
