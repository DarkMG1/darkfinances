'use strict';

const fs = require('fs');
const path = require('path');
const { spawnSync } = require('child_process');
const { normalizeMember } = require('./toolchain-extract-tar');

const DEFAULT_MAX_BUFFER = 64 * 1024 * 1024;
const TAR_ENTRY_TYPES = new Set(['-', 'd', 'l', 'h', 'b', 'c', 'p', 's']);

function fail(message) {
  throw new Error(message);
}

function findVerboseLine(lines, memberName) {
  return lines.find((line) => (
    line.endsWith(` ${memberName}`)
    || line.endsWith(memberName)
    || line.includes(` ${memberName} -> `)
  ));
}

function parseVerboseTarLine(line) {
  if (/[\x00-\x08\x0b\x0c\x0e-\x1f\x7f]/.test(line)) {
    fail('unsafe tar verbose line: control characters are forbidden');
  }
  const trimmed = line.replace(/\r$/, '');
  const type = trimmed[0];
  if (!TAR_ENTRY_TYPES.has(type) || trimmed.length < 10) {
    fail(`unable to parse tar verbose line: ${line}`);
  }
  if (!/^[rwx-]{9}$/.test(trimmed.slice(1, 10))) {
    fail(`unable to parse tar verbose permissions: ${line}`);
  }

  const rest = trimmed.slice(10).trimStart();
  const datePath = rest.match(/^([\s\S]+?) \d{4}-\d{2}-\d{2} \d{2}:\d{2}(?::\d{2})? ([\s\S]+)$/)
    || rest.match(/^([\s\S]+?) [A-Za-z]{3} +\d{1,2} +(?:\d{2}:\d{2}|\d{4}) ([\s\S]+)$/);
  if (!datePath) fail(`unable to parse tar verbose date/path: ${line}`);

  const sizeTokens = datePath[1].trim().split(/\s+/);
  const sizeToken = [...sizeTokens].reverse().find((token) => /^\d+$/.test(token));
  if (!sizeToken) fail(`unable to parse tar verbose size: ${line}`);
  let name = datePath[2];
  if (type === 'l' && name.includes(' -> ')) name = name.slice(0, name.indexOf(' -> '));
  if (type === 'h' && name.includes(' link to ')) name = name.slice(0, name.indexOf(' link to '));
  if (!name || /[\x00-\x1f\x7f]/.test(name)) fail(`unsafe tar verbose path: ${line}`);

  return {
    type,
    size: Number(sizeToken),
    name: name.replace(/^\.\//, ''),
  };
}

function listTarArchive(archivePath, limits) {
  const names = spawnSync('tar', ['-tJf', archivePath], {
    encoding: 'utf8',
    maxBuffer: DEFAULT_MAX_BUFFER,
  });
  if (names.status !== 0) fail(names.stderr || names.stdout || 'tar name listing failed');
  const members = names.stdout.split('\n').filter(Boolean);
  if (members.length > limits.maxMemberCount) {
    fail(`tar archive exceeds member count bound (${limits.maxMemberCount})`);
  }

  const verbose = spawnSync('tar', ['-tvJf', archivePath], {
    encoding: 'utf8',
    maxBuffer: DEFAULT_MAX_BUFFER,
  });
  if (verbose.status !== 0) fail(verbose.stderr || verbose.stdout || 'tar verbose listing failed');
  const verboseLines = verbose.stdout.split('\n').filter(Boolean);

  const entries = [];
  let totalBytes = 0;
  for (const member of members) {
    const normalized = normalizeMember(member);
    if (normalized.includes('\0')) fail(`tar entry contains NUL: ${member}`);
    const line = findVerboseLine(verboseLines, member);
    if (!line) fail(`tar verbose listing missing member ${member}`);
    const parsed = parseVerboseTarLine(line);
    if (parsed.name !== member && parsed.name !== normalized) {
      fail(`tar verbose name mismatch for ${member}`);
    }
    if (parsed.type === 'h') fail(`tar archive contains hard link member: ${normalized}`);
    if (parsed.type === 'l') fail(`tar archive contains symlink member: ${normalized}`);
    if (parsed.type === 'd' || member.endsWith('/')) {
      entries.push({ name: normalized, kind: 'directory', size: 0 });
      continue;
    }
    if (parsed.type !== '-') fail(`tar archive contains unsupported member type for ${normalized}`);
    if (parsed.size > limits.maxMemberBytes) {
      fail(`tar member ${normalized} exceeds per-file bound (${limits.maxMemberBytes})`);
    }
    totalBytes += parsed.size;
    if (totalBytes > limits.maxUncompressedBytes) {
      fail(`tar archive exceeds total uncompressed bound (${limits.maxUncompressedBytes})`);
    }
    entries.push({ name: normalized, kind: 'file', size: parsed.size });
  }
  return entries;
}

function extractTarMemberToFile(archivePath, member, destPath, limits) {
  const normalized = normalizeMember(member);
  const entries = listTarArchive(archivePath, limits);
  const target = entries.find((entry) => entry.name === normalized);
  if (!target) fail(`tar archive does not contain expected member ${normalized}`);
  if (target.kind !== 'file') fail(`tar archive member ${normalized} is not a regular file`);
  const stdout = spawnSync('tar', ['-xOJf', archivePath, normalized], {
    encoding: 'buffer',
    maxBuffer: Math.min(limits.maxMemberBytes + 1, DEFAULT_MAX_BUFFER),
  });
  if (stdout.status !== 0) fail(stdout.stderr?.toString() || stdout.stdout?.toString() || 'tar stdout extraction failed');
  if (stdout.stdout.length !== target.size) {
    fail(`tar member ${normalized} extracted size mismatch (${stdout.stdout.length} vs ${target.size})`);
  }
  fs.mkdirSync(path.dirname(destPath), { recursive: true });
  fs.writeFileSync(destPath, stdout.stdout, { mode: 0o644 });
  const stat = fs.lstatSync(destPath);
  if (stat.isSymbolicLink()) fail(`refusing symlink after tar extraction: ${normalized}`);
  if (!stat.isFile()) fail(`expected regular file after tar extraction: ${normalized}`);
  fs.chmodSync(destPath, 0o755);
  return destPath;
}

module.exports = {
  extractTarMemberToFile,
  findVerboseLine,
  listTarArchive,
  parseVerboseTarLine,
};
