#!/usr/bin/env node
'use strict';

const fs = require('fs');
const os = require('os');
const path = require('path');
const { lintDeploymentEnv } = require('../lib/finance-runtime-config');

function usage() {
  process.stderr.write(
    'Usage: node scripts/check-dashboard-deployment-env.js [--file=PATH]\n',
  );
}

function expandHomePath(filePath, homeDir = process.env.HOME || os.homedir()) {
  if (!filePath.startsWith('~')) return filePath;
  if (!homeDir) {
    throw new Error('deployment env file path uses ~ but HOME is unset');
  }
  if (filePath === '~') return homeDir;
  if (filePath.startsWith('~/')) return path.join(homeDir, filePath.slice(2));
  throw new Error('deployment env file path uses unsupported ~ expansion form');
}

function resolveDeploymentEnvFile(argv = process.argv, env = process.env) {
  const fileArg = argv.find((arg) => arg.startsWith('--file='));
  const rawPath = fileArg
    ? fileArg.slice('--file='.length)
    : path.join(__dirname, '..', '.env.example');
  return path.resolve(expandHomePath(rawPath, env.HOME || os.homedir()));
}

function main({ argv = process.argv, env = process.env } = {}) {
  const envFile = resolveDeploymentEnvFile(argv, env);
  if (!fs.existsSync(envFile)) {
    throw new Error(`deployment env file not found: ${envFile}`);
  }
  lintDeploymentEnv(fs.readFileSync(envFile, 'utf8'));
  process.stdout.write(`dashboard-deployment-env: ok (${path.basename(envFile)})\n`);
}

if (require.main === module) {
  try {
    if (process.argv.includes('--help') || process.argv.includes('-h')) {
      usage();
      process.exit(0);
    }
    main();
  } catch (error) {
    process.stderr.write(`${error.message}\n`);
    process.exit(1);
  }
}

module.exports = {
  expandHomePath,
  main,
  resolveDeploymentEnvFile,
};
