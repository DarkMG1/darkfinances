#!/usr/bin/env node
'use strict';

const fs = require('fs');
const path = require('path');
const { spawnSync } = require('child_process');

function parseArgs(argv) {
  const parsed = {};
  for (const arg of argv) {
    const match = arg.match(/^--([^=]+)=(.*)$/);
    if (!match) throw new Error(`unsupported argument: ${arg}`);
    parsed[match[1]] = match[2];
  }
  if (!parsed.archive || !parsed.dest || !parsed.member) {
    throw new Error('usage: toolchain-extract-tar.js --archive=PATH --dest=DIR --member=RELATIVE/PATH');
  }
  return parsed;
}

function normalizeMember(member) {
  const portable = member.replaceAll('\\', '/');
  const parts = portable.split('/');
  if (parts.some((part) => part === '' || part === '.' || part === '..')) {
    throw new Error(`unsafe archive member path: ${member}`);
  }
  return portable;
}

function extractTarMember(archivePath, member, destRoot) {
  const normalized = normalizeMember(member);
  const destPath = path.resolve(destRoot, ...normalized.split('/'));
  const resolvedRoot = path.resolve(destRoot);
  const relative = path.relative(resolvedRoot, destPath);
  if (relative.startsWith('..') || path.isAbsolute(relative)) {
    throw new Error(`archive member escapes destination: ${member}`);
  }

  const list = spawnSync('tar', ['-tJf', archivePath], { encoding: 'utf8' });
  if (list.status !== 0) throw new Error(list.stderr || list.stdout || 'tar listing failed');
  const entries = list.stdout.split('\n').filter(Boolean);
  if (!entries.includes(normalized)) {
    throw new Error(`archive does not contain expected member ${normalized}`);
  }
  for (const entry of entries) {
    const entryNormalized = normalizeMember(entry);
    if (entryNormalized.includes('..')) throw new Error(`unsafe tar entry: ${entry}`);
    if (entry.endsWith('/')) continue;
    const entryPath = path.resolve(destRoot, ...entryNormalized.split('/'));
    const entryRelative = path.relative(resolvedRoot, entryPath);
    if (entryRelative.startsWith('..') || path.isAbsolute(entryRelative)) {
      throw new Error(`tar entry escapes destination: ${entry}`);
    }
  }

  fs.mkdirSync(resolvedRoot, { recursive: true });
  const extract = spawnSync('tar', ['-xJf', archivePath, '-C', resolvedRoot, normalized], { encoding: 'utf8' });
  if (extract.status !== 0) throw new Error(extract.stderr || extract.stdout || 'tar extraction failed');

  let stat;
  try {
    stat = fs.lstatSync(destPath);
  } catch (error) {
    if (error.code === 'ENOENT') throw new Error(`extracted member missing: ${normalized}`);
    throw error;
  }
  if (stat.isSymbolicLink()) throw new Error(`refusing symlink member: ${normalized}`);
  if (!stat.isFile()) throw new Error(`expected regular file member: ${normalized}`);
  fs.chmodSync(destPath, 0o755);
}

function main() {
  const args = parseArgs(process.argv.slice(2));
  extractTarMember(path.resolve(args.archive), args.member, path.resolve(args.dest));
}

if (require.main === module) {
  try {
    main();
  } catch (error) {
    console.error(`toolchain-extract-tar: ${error.message}`);
    process.exit(1);
  }
}

module.exports = {
  extractTarMember,
  normalizeMember,
  parseArgs,
};
