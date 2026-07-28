'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const crypto = require('crypto');
const fs = require('fs');
const os = require('os');
const path = require('path');
const {
  downloadVerifiedTarball,
  ensureDeclaredNpm,
  readContract,
  verifySha256,
  verifySri,
} = require('../../scripts/ensure-declared-npm');

const repositoryRoot = path.resolve(__dirname, '..', '..');
const contract = readContract(path.join(repositoryRoot, 'ops/toolchain/npm-bootstrap.json'));

async function downloadRealTarball(cacheDir) {
  const result = await downloadVerifiedTarball(contract, { cacheDir, forceDownload: true });
  return result.cachePath;
}

test('readContract loads npm 10.9.2 bootstrap metadata', () => {
  assert.equal(contract.version, '10.9.2');
  assert.equal(contract.registryHost, 'registry.npmjs.org');
  assert.match(contract.tarballUrl, /^https:\/\/registry\.npmjs\.org\//);
});

test('verifySri and verifySha256 accept matching digests', () => {
  const buffer = Buffer.from('npm-bootstrap-test');
  const sha256 = crypto.createHash('sha256').update(buffer).digest('hex');
  const integrity = `sha512-${crypto.createHash('sha512').update(buffer).digest('base64')}`;
  verifySri(buffer, integrity);
  verifySha256(buffer, sha256);
});

test('downloadVerifiedTarball rejects hash mismatch', async () => {
  await assert.rejects(
    () => downloadVerifiedTarball(contract, { tarballBuffer: Buffer.from('not-the-real-tarball') }),
    /integrity mismatch|SHA-256 mismatch/,
  );
});

test('downloadVerifiedTarball rejects redirect off allowlisted registry host', async () => {
  await assert.rejects(
    () => downloadVerifiedTarball(contract, {
      fetchImpl: async (url, options) => {
        if (options?.redirect === 'manual') {
          return {
            status: 302,
            headers: { get: () => 'https://evil.example/npm.tgz' },
            ok: false,
          };
        }
        throw new Error('unexpected fetch');
      },
    }),
    /refusing npm tarball redirect\/host outside allowlist/,
  );
});

test('downloadVerifiedTarball rejects oversized downloads', async () => {
  await assert.rejects(
    () => downloadVerifiedTarball(contract, {
      maxBytes: 8,
      fetchImpl: async () => ({
        ok: true,
        body: {
          getReader: () => {
            let sent = false;
            return {
              read: async () => {
                if (sent) return { done: true, value: undefined };
                sent = true;
                return { done: false, value: Buffer.alloc(16) };
              },
            };
          },
        },
      }),
    }),
    /exceeds size bound/,
  );
});

test('ensureDeclaredNpm installs from private temp tarball rather than cache path', async () => {
  const cacheDir = fs.mkdtempSync(path.join(os.tmpdir(), 'npm-bootstrap-'));
  const tarballPath = await downloadRealTarball(cacheDir);
  const calls = [];
  let versionChecks = 0;
  await ensureDeclaredNpm({
    declaredVersion: contract.version,
    contract,
    cacheDir,
    tarballBuffer: fs.readFileSync(tarballPath),
    corruptCache: true,
    runCommand: (command, args) => {
      calls.push([command, args]);
      if (command === 'npm' && args[0] === '--version') {
        versionChecks += 1;
        return { status: 0, stdout: versionChecks === 1 ? '11.0.0\n' : `${contract.version}\n` };
      }
      return { status: 0, stdout: '', stderr: '' };
    },
  });
  const installCall = calls.find(([, args]) => args[0] === 'install');
  assert.ok(installCall);
  const installPath = installCall[1].find((arg) => arg.endsWith('.tgz'));
  assert.ok(installPath);
  assert.notEqual(installPath, tarballPath);
  assert.match(installPath, /npm-bootstrap-install-/);
});

test('ensureDeclaredNpm installs only from verified tarball when npm drifts', async () => {
  const cacheDir = fs.mkdtempSync(path.join(os.tmpdir(), 'npm-bootstrap-'));
  const tarballPath = await downloadRealTarball(cacheDir);
  const calls = [];
  let versionChecks = 0;
  const result = await ensureDeclaredNpm({
    declaredVersion: contract.version,
    contract,
    cacheDir,
    tarballBuffer: fs.readFileSync(tarballPath),
    runCommand: (command, args) => {
      calls.push([command, args]);
      if (command === 'npm' && args[0] === '--version') {
        versionChecks += 1;
        return { status: 0, stdout: versionChecks === 1 ? '11.0.0\n' : `${contract.version}\n` };
      }
      return { status: 0, stdout: '', stderr: '' };
    },
  });
  assert.equal(result.changed, true);
  const installCall = calls.find(([, args]) => args[0] === 'install');
  assert.ok(installCall);
  assert.ok(installCall[1].includes('--offline'));
  assert.ok(installCall[1].some((arg) => arg.endsWith('.tgz')));
});

test('ensureDeclaredNpm fails when install leaves wrong npm version active', async () => {
  const cacheDir = fs.mkdtempSync(path.join(os.tmpdir(), 'npm-bootstrap-'));
  const tarballPath = await downloadRealTarball(cacheDir);
  await assert.rejects(
    () => ensureDeclaredNpm({
      declaredVersion: contract.version,
      contract,
      cacheDir,
      tarballBuffer: fs.readFileSync(tarballPath),
      runCommand: (command, args) => {
        if (command === 'npm' && args[0] === '--version') return { status: 0, stdout: '11.0.0\n' };
        return { status: 0, stdout: '', stderr: '' };
      },
    }),
    /expected npm@10\.9\.2 after install/,
  );
});

test('ensureDeclaredNpm fails closed on install command failure', async () => {
  const cacheDir = fs.mkdtempSync(path.join(os.tmpdir(), 'npm-bootstrap-'));
  const tarballPath = await downloadRealTarball(cacheDir);
  let versionChecks = 0;
  await assert.rejects(
    () => ensureDeclaredNpm({
      declaredVersion: contract.version,
      contract,
      cacheDir,
      tarballBuffer: fs.readFileSync(tarballPath),
      runCommand: (command, args) => {
        if (command === 'npm' && args[0] === '--version') {
          versionChecks += 1;
          return { status: 0, stdout: versionChecks === 1 ? '11.0.0\n' : `${contract.version}\n` };
        }
        if (command === 'npm' && args[0] === 'install') {
          return { status: 1, stdout: '', stderr: 'install failed' };
        }
        return { status: 0, stdout: '', stderr: '' };
      },
    }),
    /install failed/,
  );
});
