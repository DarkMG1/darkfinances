#!/usr/bin/env node
'use strict';

const crypto = require('crypto');
const fs = require('fs');
const os = require('os');
const path = require('path');
const { spawnSync } = require('child_process');
const { extractZipArchive } = require('./toolchain-zip');
const { downloadBounded } = require('./toolchain-download');
const { extractTarMemberToFile } = require('./toolchain-tar');
const { acquireBootstrapLock } = require('./toolchain-bootstrap-lock');

const DEFAULT_LIMITS = Object.freeze({
  maxArchiveBytes: 64 * 1024 * 1024,
  maxUncompressedBytes: 512 * 1024 * 1024,
  maxMemberCount: 4096,
  maxMemberBytes: 128 * 1024 * 1024,
  maxCompressionRatio: 100,
});

const CONTRACT_TOP_KEYS = new Set([
  'allowedHosts',
  'artifactName',
  'binaryPath',
  'downloadUrl',
  'extractMode',
  'maxArchiveBytes',
  'maxCompressionRatio',
  'maxMemberBytes',
  'maxMemberCount',
  'maxUncompressedBytes',
  'platform',
  'provenance',
  'releaseTag',
  'schemaVersion',
  'sha256',
  'version',
]);

function fail(message) {
  throw new Error(message);
}

function assertSafeInteger(value, label, { min = 1, max = Number.MAX_SAFE_INTEGER } = {}) {
  if (!Number.isInteger(value) || value < min || value > max) {
    fail(`${label} must be an integer between ${min} and ${max}`);
  }
}

function assertHttpsAllowlisted(url, allowedHosts, label) {
  let parsed;
  try {
    parsed = new URL(url);
  } catch {
    fail(`${label} must be a valid URL`);
  }
  if (parsed.protocol !== 'https:') fail(`${label} must use HTTPS`);
  if (!allowedHosts.includes(parsed.hostname)) {
    fail(`${label} host ${parsed.hostname} is outside allowedHosts`);
  }
}

function normalizeBinaryPath(binaryPath) {
  const portable = binaryPath.replaceAll('\\', '/');
  if (portable.startsWith('/') || portable.startsWith('./') || portable.startsWith('../')) {
    fail('toolchain contract binaryPath must be a relative archive path');
  }
  if (portable.endsWith('/')) fail('toolchain contract binaryPath must not be a directory');
  const parts = portable.split('/');
  if (parts.some((part) => part === '' || part === '.' || part === '..')) {
    fail('toolchain contract binaryPath contains unsafe segments');
  }
  return portable;
}

function readContract(contractPath) {
  const contract = JSON.parse(fs.readFileSync(contractPath, 'utf8'));
  const unknown = Object.keys(contract).filter((key) => !CONTRACT_TOP_KEYS.has(key)).sort();
  if (unknown.length > 0) {
    fail(`toolchain contract contains unsupported field${unknown.length === 1 ? '' : 's'}: ${unknown.join(', ')}`);
  }
  if (contract.schemaVersion !== 2) fail(`unsupported toolchain contract schemaVersion: ${contract.schemaVersion}`);
  for (const key of ['version', 'artifactName', 'downloadUrl', 'sha256', 'binaryPath', 'extractMode']) {
    if (typeof contract[key] !== 'string' || contract[key].length === 0) {
      fail(`toolchain contract missing ${key}`);
    }
  }
  if (!Array.isArray(contract.allowedHosts) || contract.allowedHosts.length === 0) {
    fail('toolchain contract allowedHosts must be a non-empty array');
  }
  const hostSet = new Set();
  for (const host of contract.allowedHosts) {
    if (typeof host !== 'string' || !/^[a-z0-9.-]+$/i.test(host)) {
      fail(`toolchain contract allowedHosts entry is invalid: ${host}`);
    }
    if (hostSet.has(host)) fail(`toolchain contract allowedHosts contains duplicate host: ${host}`);
    hostSet.add(host);
  }
  if (!/^[a-f0-9]{64}$/.test(contract.sha256)) fail('toolchain contract sha256 must be lowercase hex');
  if (!['full-tree', 'single-member'].includes(contract.extractMode)) {
    fail(`unsupported extractMode: ${contract.extractMode}`);
  }
  contract.binaryPath = normalizeBinaryPath(contract.binaryPath);
  assertHttpsAllowlisted(contract.downloadUrl, contract.allowedHosts, 'toolchain contract downloadUrl');
  const limits = buildLimits(contract);
  assertSafeInteger(limits.maxArchiveBytes, 'maxArchiveBytes');
  assertSafeInteger(limits.maxUncompressedBytes, 'maxUncompressedBytes');
  assertSafeInteger(limits.maxMemberCount, 'maxMemberCount');
  assertSafeInteger(limits.maxMemberBytes, 'maxMemberBytes');
  assertSafeInteger(limits.maxCompressionRatio, 'maxCompressionRatio');
  if (limits.maxArchiveBytes > limits.maxUncompressedBytes) {
    fail('maxArchiveBytes must not exceed maxUncompressedBytes');
  }
  if (limits.maxMemberBytes > limits.maxUncompressedBytes) {
    fail('maxMemberBytes must not exceed maxUncompressedBytes');
  }
  if (contract.artifactName.endsWith('.zip') && contract.extractMode === 'single-member') {
    // allowed for single file zips
  } else if (contract.artifactName.endsWith('.zip') && contract.extractMode !== 'full-tree') {
    fail('zip artifacts require full-tree or single-member extractMode');
  }
  if (contract.artifactName.endsWith('.tar.xz') && contract.extractMode !== 'single-member') {
    fail('tar.xz artifacts require single-member extractMode');
  }
  if (!contract.artifactName.endsWith('.zip') && !contract.artifactName.endsWith('.tar.xz')) {
    fail(`unsupported artifact extension: ${contract.artifactName}`);
  }
  return contract;
}

function buildLimits(contract) {
  return {
    maxArchiveBytes: contract.maxArchiveBytes ?? DEFAULT_LIMITS.maxArchiveBytes,
    maxUncompressedBytes: contract.maxUncompressedBytes ?? DEFAULT_LIMITS.maxUncompressedBytes,
    maxMemberCount: contract.maxMemberCount ?? DEFAULT_LIMITS.maxMemberCount,
    maxMemberBytes: contract.maxMemberBytes ?? DEFAULT_LIMITS.maxMemberBytes,
    maxCompressionRatio: contract.maxCompressionRatio ?? DEFAULT_LIMITS.maxCompressionRatio,
  };
}

function verifyArchiveBuffer(buffer, expectedSha256) {
  const digest = crypto.createHash('sha256').update(buffer).digest('hex');
  if (digest !== expectedSha256) {
    fail(`archive SHA-256 mismatch: expected ${expectedSha256}, got ${digest}`);
  }
}

function assertNotSymlink(targetPath, label) {
  if (!fs.existsSync(targetPath)) return;
  if (fs.lstatSync(targetPath).isSymbolicLink()) {
    fail(`${label} must not be a symlink: ${targetPath}`);
  }
}

async function downloadArchive(contract, archivePath, dependencies = {}) {
  const buffer = await downloadBounded(contract.downloadUrl, {
    allowedHosts: contract.allowedHosts,
    fetchImpl: dependencies.fetchImpl,
    maxBytes: buildLimits(contract).maxArchiveBytes,
  });
  verifyArchiveBuffer(buffer, contract.sha256);
  fs.mkdirSync(path.dirname(archivePath), { recursive: true });
  assertNotSymlink(path.dirname(archivePath), 'archive parent directory');
  const tempPath = `${archivePath}.${process.pid}.${Date.now()}.tmp`;
  fs.writeFileSync(tempPath, buffer);
  fs.renameSync(tempPath, archivePath);
  return buffer;
}

function readVerifiedArchive(archivePath, expectedSha256) {
  assertNotSymlink(archivePath, 'cached archive');
  const buffer = fs.readFileSync(archivePath);
  verifyArchiveBuffer(buffer, expectedSha256);
  return buffer;
}

function publishStagingDirectory(stagingRoot, publishRoot) {
  assertNotSymlink(stagingRoot, 'staging root');
  const parent = path.dirname(publishRoot);
  fs.mkdirSync(parent, { recursive: true });
  assertNotSymlink(parent, 'publish parent directory');
  const backupRoot = `${publishRoot}.prev-${process.pid}-${Date.now()}`;
  const hadPrevious = fs.existsSync(publishRoot);
  if (hadPrevious) {
    assertNotSymlink(publishRoot, 'publish root');
    fs.renameSync(publishRoot, backupRoot);
  }
  try {
    fs.renameSync(stagingRoot, publishRoot);
    if (hadPrevious) fs.rmSync(backupRoot, { recursive: true, force: true });
  } catch (error) {
    if (hadPrevious && !fs.existsSync(publishRoot) && fs.existsSync(backupRoot)) {
      fs.renameSync(backupRoot, publishRoot);
    }
    throw error;
  }
}

function extractArchiveToStaging(buffer, contract, stagingRoot) {
  const limits = buildLimits(contract);
  fs.mkdirSync(stagingRoot, { recursive: true });
  if (contract.artifactName.endsWith('.zip')) {
    const members = extractZipArchive(buffer, stagingRoot, limits);
    const fileMembers = members.filter((member) => !member.endsWith('/'));
    if (contract.extractMode === 'single-member') {
      if (!fileMembers.includes(contract.binaryPath)) {
        fail(`zip archive missing expected member ${contract.binaryPath}`);
      }
      if (fileMembers.length !== 1) {
        fail(`single-member zip contract expected one file, found ${fileMembers.length}`);
      }
    } else if (!fileMembers.includes(contract.binaryPath)) {
      fail(`zip archive missing expected binary member ${contract.binaryPath}`);
    }
    return;
  }
  if (contract.artifactName.endsWith('.tar.xz')) {
    const tempArchive = path.join(stagingRoot, contract.artifactName);
    fs.writeFileSync(tempArchive, buffer);
    const destPath = path.join(stagingRoot, ...contract.binaryPath.split('/'));
    extractTarMemberToFile(tempArchive, contract.binaryPath, destPath, limits);
    fs.rmSync(tempArchive, { force: true });
    return;
  }
  fail(`unsupported archive type: ${contract.artifactName}`);
}

function assertPublishedBinary(publishRoot, binaryRel) {
  assertNotSymlink(publishRoot, 'publish root');
  const binaryPath = path.resolve(publishRoot, binaryRel);
  const relative = path.relative(path.resolve(publishRoot), binaryPath);
  if (relative.startsWith('..') || path.isAbsolute(relative)) {
    fail(`binary path escapes publish root: ${binaryRel}`);
  }
  let stat;
  try {
    stat = fs.lstatSync(binaryPath);
  } catch (error) {
    if (error.code === 'ENOENT') fail(`published binary missing at ${binaryPath}`);
    throw error;
  }
  if (stat.isSymbolicLink()) fail(`published binary must not be a symlink: ${binaryPath}`);
  if (!stat.isFile()) fail(`published binary must be a regular file: ${binaryPath}`);
  fs.chmodSync(binaryPath, 0o755);
  return binaryPath;
}

function createStagingRoot(installRoot) {
  return path.join(installRoot, `.staging-${process.pid}-${Date.now()}-${crypto.randomBytes(4).toString('hex')}`);
}

async function bootstrapToolchain({
  contractPath,
  cacheRoot = path.join(os.homedir(), '.cache', 'darkfinances', 'toolchain'),
  forceDownload = false,
  fetchImpl,
  acquireLock = acquireBootstrapLock,
} = {}) {
  if (!contractPath) fail('contractPath is required');
  const contract = readContract(contractPath);
  assertNotSymlink(cacheRoot, 'cache root');
  const installRoot = path.join(cacheRoot, contract.version);
  const archivePath = path.join(installRoot, contract.artifactName);
  const publishRoot = path.join(installRoot, 'extracted');
  fs.mkdirSync(installRoot, { recursive: true });
  assertNotSymlink(installRoot, 'install root');

  const lock = acquireLock(installRoot);
  try {
    let buffer;
    if (forceDownload || !fs.existsSync(archivePath)) {
      buffer = await downloadArchive(contract, archivePath, { fetchImpl });
    } else {
      buffer = readVerifiedArchive(archivePath, contract.sha256);
    }

    const stagingRoot = createStagingRoot(installRoot);
    fs.rmSync(stagingRoot, { recursive: true, force: true });
    try {
      extractArchiveToStaging(buffer, contract, stagingRoot);
      publishStagingDirectory(stagingRoot, publishRoot);
    } catch (error) {
      fs.rmSync(stagingRoot, { recursive: true, force: true });
      throw error;
    }
    const binaryPath = assertPublishedBinary(publishRoot, contract.binaryPath);
    return { binaryPath, contract, installRoot, publishRoot };
  } finally {
    lock.release();
  }
}

function parseArgs(argv) {
  const parsed = {};
  for (const arg of argv) {
    const match = arg.match(/^--([^=]+)=(.*)$/);
    if (!match) fail(`unsupported argument: ${arg}`);
    parsed[match[1]] = match[2];
  }
  if (!parsed.contract) fail('usage: toolchain-bootstrap.js --contract=PATH [--cache-root=DIR] [--force-download=1]');
  return parsed;
}

async function main() {
  const args = parseArgs(process.argv.slice(2));
  const result = await bootstrapToolchain({
    contractPath: path.resolve(args.contract),
    cacheRoot: args['cache-root'] ? path.resolve(args['cache-root']) : undefined,
    forceDownload: args['force-download'] === '1',
  });
  process.stdout.write(`${result.binaryPath}\n`);
}

if (require.main === module) {
  main().catch((error) => {
    console.error(`toolchain-bootstrap: ${error.message}`);
    process.exit(1);
  });
}

module.exports = {
  DEFAULT_LIMITS,
  assertNotSymlink,
  acquireBootstrapLock,
  bootstrapToolchain,
  createStagingRoot,
  extractArchiveToStaging,
  publishStagingDirectory,
  readContract,
  readVerifiedArchive,
  verifyArchiveBuffer,
};
