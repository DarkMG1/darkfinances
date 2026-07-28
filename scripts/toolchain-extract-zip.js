#!/usr/bin/env node
'use strict';

const fs = require('fs');
const path = require('path');
const { extractZipArchive, normalizeMemberPath, validateZipArchive } = require('./toolchain-zip');

function parseArgs(argv) {
  const parsed = {};
  for (const arg of argv) {
    const match = arg.match(/^--([^=]+)=(.*)$/);
    if (!match) throw new Error(`unsupported argument: ${arg}`);
    parsed[match[1]] = match[2];
  }
  if (!parsed.archive || !parsed.dest) {
    throw new Error('usage: toolchain-extract-zip.js --archive=PATH --dest=DIR [--member=RELATIVE/PATH]');
  }
  return parsed;
}

const DEFAULT_LIMITS = {
  maxArchiveBytes: 512 * 1024 * 1024,
  maxUncompressedBytes: 1024 * 1024 * 1024,
  maxMemberCount: 4096,
  maxMemberBytes: 256 * 1024 * 1024,
  maxCompressionRatio: 100,
};

function extractZipArchiveFile(archivePath, destRoot, options = {}) {
  const buffer = fs.readFileSync(path.resolve(archivePath));
  const limits = { ...DEFAULT_LIMITS, ...options.limits };
  const members = extractZipArchive(buffer, path.resolve(destRoot), limits);
  if (options.member) {
    const normalized = normalizeMemberPath(options.member);
    if (!members.includes(normalized)) {
      throw new Error(`archive does not contain expected member ${normalized}`);
    }
  }
  return members;
}

function main() {
  const args = parseArgs(process.argv.slice(2));
  extractZipArchiveFile(args.archive, args.dest, { member: args.member });
}

if (require.main === module) {
  try {
    main();
  } catch (error) {
    console.error(`toolchain-extract-zip: ${error.message}`);
    process.exit(1);
  }
}

module.exports = {
  DEFAULT_LIMITS,
  extractZipArchiveFile,
  normalizeMemberPath: normalizeMemberPath,
  validateZipArchive,
};
