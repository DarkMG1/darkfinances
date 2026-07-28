#!/usr/bin/env node
'use strict';

const fs = require('fs');
const path = require('path');
const { createRequire } = require('module');

const APP_ROOT = path.resolve(__dirname, '..');

function resolveExpoBin(appRoot = APP_ROOT) {
  const localBin = path.join(appRoot, 'node_modules', 'expo', 'bin', 'cli');
  if (fs.existsSync(localBin)) {
    assertRegularFile(localBin);
    return localBin;
  }
  const requireFrom = createRequire(path.join(appRoot, 'package.json'));
  const packageRoot = path.dirname(requireFrom.resolve('expo/package.json'));
  const pkg = JSON.parse(fs.readFileSync(path.join(packageRoot, 'package.json'), 'utf8'));
  const binEntry = pkg.bin?.expo;
  if (typeof binEntry !== 'string' || binEntry.length === 0) {
    throw new Error('expo package.json must declare bin.expo');
  }
  const absoluteBin = path.resolve(packageRoot, binEntry);
  const relative = path.relative(packageRoot, absoluteBin);
  if (relative.startsWith('..') || path.isAbsolute(relative)) {
    throw new Error('expo bin.expo must resolve inside package root');
  }
  assertRegularFile(absoluteBin);
  return absoluteBin;
}

function assertRegularFile(filePath) {
  let stat;
  try {
    stat = fs.lstatSync(filePath);
  } catch (error) {
    if (error.code === 'ENOENT') throw new Error(`expo binary missing at ${filePath}`);
    throw error;
  }
  if (stat.isSymbolicLink()) throw new Error(`expo binary must not be a symlink: ${filePath}`);
  if (!stat.isFile()) throw new Error(`expo binary must be a regular file: ${filePath}`);
}

function main() {
  try {
    process.stdout.write(`${resolveExpoBin()}\n`);
  } catch (error) {
    console.error(`resolve-expo-bin: ${error.message}`);
    process.exit(1);
  }
}

if (require.main === module) main();
module.exports = {
  resolveExpoBin,
};
