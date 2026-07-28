#!/usr/bin/env node
'use strict';

const crypto = require('crypto');
const fs = require('fs');
const os = require('os');
const path = require('path');
const { URL } = require('url');
const { readDeclaredNpmVersion } = require('./package-manager');

const ROOT = path.resolve(__dirname, '..');
const DEFAULT_CONTRACT = path.join(ROOT, 'ops/toolchain/npm-bootstrap.json');
const DEFAULT_CACHE_DIR = path.join(os.homedir(), '.cache', 'darkfinances', 'npm-bootstrap');
const MAX_REDIRECTS = 5;
const MAX_BYTES = 64 * 1024 * 1024;

function fail(message) {
  throw new Error(message);
}

function readContract(contractPath = DEFAULT_CONTRACT) {
  const contract = JSON.parse(fs.readFileSync(contractPath, 'utf8'));
  if (contract.schemaVersion !== 1) fail(`unsupported npm-bootstrap schemaVersion: ${contract.schemaVersion}`);
  for (const key of [
    'package',
    'version',
    'registryHost',
    'tarballUrl',
    'integrity',
    'sha256',
    'provenance',
  ]) {
    if (typeof contract[key] !== 'string' || contract[key].length === 0) {
      fail(`npm-bootstrap contract missing ${key}`);
    }
  }
  if (!/^sha512-[A-Za-z0-9+/=]+$/.test(contract.integrity)) {
    fail('npm-bootstrap integrity must be an npm SRI sha512 digest');
  }
  if (!/^[a-f0-9]{64}$/.test(contract.sha256)) {
    fail('npm-bootstrap sha256 must be lowercase hex');
  }
  const tarballUrl = new URL(contract.tarballUrl);
  if (tarballUrl.protocol !== 'https:') fail('npm-bootstrap tarballUrl must use HTTPS');
  if (tarballUrl.hostname !== contract.registryHost) {
    fail(`npm-bootstrap tarballUrl host must match registryHost (${contract.registryHost})`);
  }
  return contract;
}

function defaultRunCommand(command, args, options = {}) {
  const { spawnSync } = require('child_process');
  return spawnSync(command, args, {
    encoding: 'utf8',
    ...options,
  });
}

function readActiveNpmVersion(runCommand = defaultRunCommand) {
  const result = runCommand('npm', ['--version']);
  if (result.status !== 0) {
    throw new Error(result.stderr || result.stdout || 'npm --version failed');
  }
  return result.stdout.trim();
}

function verifySri(buffer, integrity) {
  const [algorithm, encoded] = integrity.split('-', 2);
  if (algorithm !== 'sha512' || !encoded) fail(`unsupported SRI algorithm in ${integrity}`);
  const expected = Buffer.from(encoded, 'base64');
  const actual = crypto.createHash('sha512').update(buffer).digest();
  if (expected.length !== actual.length || !crypto.timingSafeEqual(expected, actual)) {
    fail('npm tarball SRI integrity mismatch');
  }
}

function verifySha256(buffer, sha256) {
  const actual = crypto.createHash('sha256').update(buffer).digest('hex');
  if (actual !== sha256) fail(`npm tarball SHA-256 mismatch: expected ${sha256}, got ${actual}`);
}

function requestBuffer(urlString, {
  registryHost,
  fetchImpl = globalThis.fetch,
  maxRedirects = MAX_REDIRECTS,
  maxBytes = MAX_BYTES,
} = {}) {
  if (!fetchImpl) fail('fetch implementation is required to download npm bootstrap tarball');
  return (async () => {
    let current = new URL(urlString);
    for (let redirectCount = 0; redirectCount <= maxRedirects; redirectCount += 1) {
      if (current.protocol !== 'https:') fail(`refusing insecure npm tarball URL: ${current.href}`);
      if (current.hostname !== registryHost) {
        fail(`refusing npm tarball redirect/host outside allowlist ${registryHost}: ${current.href}`);
      }
      const response = await fetchImpl(current.href, { redirect: 'manual' });
      if ([301, 302, 303, 307, 308].includes(response.status)) {
        const location = response.headers.get('location');
        if (!location) fail(`npm tarball redirect missing location from ${current.href}`);
        current = new URL(location, current);
        continue;
      }
      if (!response.ok) fail(`npm tarball download failed (${response.status}) from ${current.href}`);
      const reader = response.body?.getReader?.();
      if (!reader) {
        const arrayBuffer = await response.arrayBuffer();
        const buffer = Buffer.from(arrayBuffer);
        if (buffer.length > maxBytes) fail(`npm tarball exceeds size bound (${maxBytes} bytes)`);
        return buffer;
      }
      const chunks = [];
      let total = 0;
      while (true) {
        const { done, value } = await reader.read();
        if (done) break;
        total += value.length;
        if (total > maxBytes) fail(`npm tarball exceeds size bound (${maxBytes} bytes)`);
        chunks.push(Buffer.from(value));
      }
      return Buffer.concat(chunks);
    }
    fail('npm tarball download exceeded redirect limit');
    return Buffer.alloc(0);
  })();
}

function atomicWriteFile(targetPath, buffer) {
  const directory = path.dirname(targetPath);
  fs.mkdirSync(directory, { recursive: true });
  const tempPath = path.join(directory, `.${path.basename(targetPath)}.${process.pid}.${Date.now()}.tmp`);
  fs.writeFileSync(tempPath, buffer);
  fs.renameSync(tempPath, targetPath);
  return targetPath;
}

function writePrivateInstallTarball(buffer) {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'npm-bootstrap-install-'), { mode: 0o700 });
  const filePath = path.join(directory, 'npm.tgz');
  fs.writeFileSync(filePath, buffer, { mode: 0o600 });
  return { directory, filePath };
}

async function downloadVerifiedTarball(contract, dependencies = {}) {
  const cacheDir = dependencies.cacheDir || DEFAULT_CACHE_DIR;
  const cachePath = path.join(cacheDir, `${contract.package}-${contract.version}.tgz`);
  const fetchImpl = dependencies.fetchImpl || globalThis.fetch;
  let buffer;
  if (dependencies.tarballBuffer) {
    buffer = dependencies.tarballBuffer;
  } else if (fs.existsSync(cachePath) && !dependencies.forceDownload) {
    buffer = fs.readFileSync(cachePath);
  } else {
    buffer = await requestBuffer(contract.tarballUrl, {
      registryHost: contract.registryHost,
      fetchImpl,
      maxRedirects: dependencies.maxRedirects,
      maxBytes: dependencies.maxBytes,
    });
    atomicWriteFile(cachePath, buffer);
  }
  verifySri(buffer, contract.integrity);
  verifySha256(buffer, contract.sha256);
  if (dependencies.corruptCache) {
    const corrupted = Buffer.from(buffer);
    corrupted[0] ^= 0xff;
    fs.writeFileSync(cachePath, corrupted);
  }
  return { buffer, cachePath };
}

async function ensureDeclaredNpm({
  runCommand = defaultRunCommand,
  declaredVersion = readDeclaredNpmVersion(),
  contractPath = DEFAULT_CONTRACT,
  contract = readContract(contractPath),
  cacheDir = DEFAULT_CACHE_DIR,
  fetchImpl,
  tarballBuffer,
  forceDownload = false,
  skipInstall = false,
} = {}) {
  if (contract.version !== declaredVersion) {
    fail(`npm bootstrap contract version ${contract.version} does not match packageManager ${declaredVersion}`);
  }

  const active = readActiveNpmVersion(runCommand);
  if (active === declaredVersion) {
    return { declaredVersion, activeVersion: active, changed: false, contract };
  }

  const { buffer, cachePath } = await downloadVerifiedTarball(contract, {
    cacheDir,
    fetchImpl,
    tarballBuffer,
    forceDownload,
  });

  if (skipInstall) {
    return { declaredVersion, activeVersion: active, changed: false, contract, cachePath, wouldInstall: true };
  }

  const installSource = writePrivateInstallTarball(buffer);
  let install;
  try {
    install = runCommand('npm', ['install', '-g', '--offline', '--no-audit', '--no-fund', installSource.filePath]);
  } finally {
    fs.rmSync(installSource.directory, { recursive: true, force: true });
  }
  if (install.status !== 0) {
    fail(install.stderr || install.stdout || `failed to install npm@${declaredVersion} from verified tarball`);
  }

  const verified = readActiveNpmVersion(runCommand);
  if (verified !== declaredVersion) {
    fail(`expected npm@${declaredVersion} after install, got npm@${verified}`);
  }

  return { declaredVersion, activeVersion: verified, changed: true, contract, cachePath };
}

function main() {
  ensureDeclaredNpm()
    .then((result) => {
      const suffix = result.changed ? ' (installed from verified tarball)' : '';
      console.log(`ensure-declared-npm: ok (npm@${result.activeVersion}${suffix})`);
    })
    .catch((error) => {
      console.error(`ensure-declared-npm: ${error.message}`);
      process.exit(1);
    });
}

if (require.main === module) main();
module.exports = {
  DEFAULT_CACHE_DIR,
  atomicWriteFile,
  downloadVerifiedTarball,
  ensureDeclaredNpm,
  readActiveNpmVersion,
  readContract,
  requestBuffer,
  verifySha256,
  verifySri,
  writePrivateInstallTarball,
};
