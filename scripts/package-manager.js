#!/usr/bin/env node
const fs = require('fs');
const path = require('path');

const defaultRoot = path.resolve(__dirname, '..');

function readPackageJson(root = defaultRoot) {
  const file = path.join(root, 'package.json');
  return JSON.parse(fs.readFileSync(file, 'utf8'));
}

function parsePackageManager(value) {
  if (typeof value !== 'string' || value.length === 0) {
    throw new Error('packageManager must be a non-empty string');
  }
  const match = value.match(/^([a-z0-9+.-]+)@(\d+\.\d+\.\d+(?:[-+][0-9A-Za-z.-]+)?)$/);
  if (!match) {
    throw new Error(`packageManager has unsupported format: ${value}`);
  }
  const [, name, versionWithSuffix] = match;
  const version = versionWithSuffix.split(/[-+]/, 1)[0];
  return { name, version, raw: value };
}

function readDeclaredPackageManager(root = defaultRoot) {
  const { packageManager } = readPackageJson(root);
  return parsePackageManager(packageManager);
}

function readDeclaredNpmVersion(root = defaultRoot) {
  const parsed = readDeclaredPackageManager(root);
  if (parsed.name !== 'npm') {
    throw new Error(`unsupported packageManager tool: ${parsed.name}`);
  }
  return parsed.version;
}

module.exports = {
  readPackageJson,
  parsePackageManager,
  readDeclaredPackageManager,
  readDeclaredNpmVersion,
};
