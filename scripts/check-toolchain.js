#!/usr/bin/env node
const path = require('path');
const { spawnSync } = require('child_process');
const { readDeclaredNpmVersion, readPackageJson } = require('./package-manager');

const root = path.resolve(__dirname, '..');

function fail(message) {
  console.error(`toolchain: ${message}`);
  process.exit(1);
}

function parseNodeEngineMinimum(enginesNode) {
  const match = String(enginesNode || '').match(/^>=(\d+)/);
  if (!match) {
    throw new Error(`unsupported engines.node value: ${enginesNode}`);
  }
  return Number(match[1]);
}

function readActiveNpmVersion() {
  if (process.env.npm_config_user_agent) {
    const match = process.env.npm_config_user_agent.match(/npm\/(\S+)/);
    if (match) return match[1];
  }
  if (process.env.npm_version) return process.env.npm_version;
  const result = spawnSync('npm', ['--version'], { encoding: 'utf8' });
  if (result.status !== 0) {
    throw new Error(result.stderr || result.stdout || 'npm --version failed');
  }
  return result.stdout.trim();
}

function checkToolchain({
  rootDir = root,
  nodeVersion = process.versions.node,
  npmVersion = readActiveNpmVersion(),
} = {}) {
  const pkg = readPackageJson(rootDir);
  const minimumMajor = parseNodeEngineMinimum(pkg.engines?.node);
  const [major] = nodeVersion.split('.').map(Number);
  if (major < minimumMajor) {
    throw new Error(`Node ${minimumMajor}+ required, got ${nodeVersion}`);
  }

  const declaredNpm = readDeclaredNpmVersion(rootDir);
  const activeNpm = npmVersion;
  if (!activeNpm) {
    throw new Error('unable to determine active npm version');
  }
  if (activeNpm !== declaredNpm) {
    throw new Error(
      `npm@${declaredNpm} required (packageManager); got npm@${activeNpm}. Run: npm install -g npm@${declaredNpm}`,
    );
  }

  return { nodeVersion, npmVersion: activeNpm, declaredNpm };
}

function main() {
  try {
    const result = checkToolchain();
    console.log(`toolchain: ok (node ${result.nodeVersion}, npm@${result.npmVersion})`);
  } catch (error) {
    fail(error.message);
  }
}

if (require.main === module) main();
module.exports = { checkToolchain, parseNodeEngineMinimum, readActiveNpmVersion };
