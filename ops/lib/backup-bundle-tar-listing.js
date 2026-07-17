'use strict';

const { spawnSync } = require('child_process');

const TAR_ENTRY_TYPES = new Set(['-', 'd', 'l', 'h', 'b', 'c', 'p', 's']);

function assertSingleLineListingLine(line, label = 'tar listing line') {
  if (line.includes('\0')) {
    throw new Error(`unsafe ${label}: NUL bytes are forbidden`);
  }
  if (/[\x01-\x08\x0b\x0c\x0e-\x1f\x7f]/.test(line)) {
    throw new Error(`unsafe ${label}: control characters are forbidden`);
  }
}

function splitTarVerboseDatePath(rest, line) {
  const gnu = rest.match(/^([\s\S]+?) (\d{4}-\d{2}-\d{2}) (\d{2}:\d{2}) ([\s\S]+)$/);
  if (gnu) {
    return { prefix: gnu[1], path: gnu[4] };
  }

  const bsdTime = rest.match(/^([\s\S]+?) ([A-Za-z]{3} +(?:\d{1,2}| +\d{1,2})) (\d{2}:\d{2}) ([\s\S]+)$/);
  if (bsdTime) {
    return { prefix: bsdTime[1], path: bsdTime[4] };
  }

  const bsdYear = rest.match(/^([\s\S]+?) ([A-Za-z]{3} +\d{1,2}) +(\d{4}) ([\s\S]+)$/);
  if (bsdYear) {
    return { prefix: bsdYear[1], path: bsdYear[4] };
  }

  throw new Error(`unable to parse tar listing line: ${line}`);
}

function lastIntegerToken(prefix, line) {
  const tokens = prefix.trim().split(/\s+/);
  for (let index = tokens.length - 1; index >= 0; index -= 1) {
    if (/^\d+$/.test(tokens[index])) {
      return Number(tokens[index]);
    }
  }
  throw new Error(`unable to parse tar listing size: ${line}`);
}

function parseTarVerboseLine(line) {
  assertSingleLineListingLine(line);
  const trimmed = line.replace(/\r$/, '');
  if (!trimmed.trim()) {
    return null;
  }

  const type = trimmed[0];
  if (!TAR_ENTRY_TYPES.has(type)) {
    throw new Error(`unsupported tar entry type ${type} in listing line: ${line}`);
  }
  if (trimmed.length < 10) {
    throw new Error(`unable to parse tar listing line: ${line}`);
  }

  const mode = trimmed.slice(1, 10);
  if (!/^[rwx-]{9}$/.test(mode)) {
    throw new Error(`unable to parse tar listing permissions: ${line}`);
  }

  const rest = trimmed.slice(10).trimStart();
  const { prefix, path: rawPath } = splitTarVerboseDatePath(rest, line);
  if (!rawPath) {
    throw new Error(`unable to parse tar listing path: ${line}`);
  }
  let memberPath = rawPath;
  if (type === 'l') {
    const arrow = ' -> ';
    const arrowIndex = memberPath.indexOf(arrow);
    if (arrowIndex !== -1) {
      memberPath = memberPath.slice(0, arrowIndex);
    }
  }
  if (/[\x00-\x1f\x7f]/.test(memberPath)) {
    throw new Error(`unsafe tar listing path: control characters are forbidden`);
  }

  return {
    type,
    size: lastIntegerToken(prefix, line),
    path: memberPath,
  };
}

function parseTarVerboseListingText(text) {
  const entries = [];
  const lines = text.split('\n');
  for (const line of lines) {
    const entry = parseTarVerboseLine(line);
    if (entry) entries.push(entry);
  }
  return entries;
}

function listTarMemberNames(archivePath) {
  const listing = spawnSync('tar', ['-tzf', archivePath], { encoding: 'utf8' });
  if (listing.status !== 0) {
    throw new Error(listing.stderr || 'tar listing failed');
  }
  return listing.stdout.trim().split('\n').filter(Boolean);
}

function listTarVerboseEntries(archivePath) {
  const listing = spawnSync('tar', ['-tvf', archivePath], { encoding: 'utf8' });
  if (listing.status !== 0) {
    throw new Error(listing.stderr || 'tar verbose listing failed');
  }
  return parseTarVerboseListingText(listing.stdout);
}

module.exports = {
  parseTarVerboseLine,
  parseTarVerboseListingText,
  listTarMemberNames,
  listTarVerboseEntries,
};
