'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const os = require('os');
const path = require('path');
const { spawnSync } = require('child_process');
const { normalizeMember } = require('../../scripts/toolchain-extract-tar');
const { normalizeMemberPath } = require('../../scripts/toolchain-zip');
const { readContract, readVerifiedArchive } = require('../../scripts/toolchain-bootstrap');

const repositoryRoot = path.resolve(__dirname, '..', '..');
const shellcheckContract = JSON.parse(fs.readFileSync(
  path.join(repositoryRoot, 'ops/toolchain/shellcheck-bootstrap.json'),
  'utf8',
));
const maestroContract = JSON.parse(fs.readFileSync(
  path.join(repositoryRoot, 'ops/toolchain/maestro-bootstrap.json'),
  'utf8',
));

test('shellcheck bootstrap contract pins linux x86_64 release artifact', () => {
  assert.equal(shellcheckContract.schemaVersion, 2);
  assert.equal(shellcheckContract.version, '0.11.0');
  assert.match(shellcheckContract.downloadUrl, /shellcheck-v0\.11\.0\.linux\.x86_64\.tar\.xz$/);
  assert.match(shellcheckContract.sha256, /^[a-f0-9]{64}$/);
  assert.deepEqual(shellcheckContract.allowedHosts, ['github.com', 'release-assets.githubusercontent.com']);
  assert.equal(shellcheckContract.extractMode, 'single-member');
});

test('maestro bootstrap contract pins macOS release artifact', () => {
  assert.equal(maestroContract.schemaVersion, 2);
  assert.equal(maestroContract.version, '2.7.0');
  assert.match(maestroContract.downloadUrl, /\/cli-2\.7\.0\/maestro\.zip$/);
  assert.match(maestroContract.sha256, /^[a-f0-9]{64}$/);
  assert.equal(maestroContract.extractMode, 'full-tree');
});

test('ensure-shellcheck skips on unsupported local platform', () => {
  if (process.platform === 'linux' && process.arch === 'x64') {
    assert.ok(true, 'linux x86_64 uses bootstrap path covered elsewhere');
    return;
  }
  const result = spawnSync('bash', [path.join(repositoryRoot, 'scripts/ensure-shellcheck.sh')], {
    encoding: 'utf8',
    env: { ...process.env, CI: '', GITHUB_ACTIONS: '' },
  });
  assert.equal(result.status, 0);
  assert.match(result.stdout, /skipped/);
});

test('ensure-maestro skips on unsupported local platform', () => {
  if (process.platform === 'darwin') {
    assert.ok(true, 'macOS uses bootstrap path covered elsewhere');
    return;
  }
  const result = spawnSync('bash', [path.join(repositoryRoot, 'scripts/ensure-maestro.sh')], {
    encoding: 'utf8',
    env: { ...process.env, CI: '', GITHUB_ACTIONS: '' },
  });
  assert.equal(result.status, 0);
  assert.match(result.stdout, /skipped/);
});

test('readVerifiedArchive rejects corrupted cache files on cache hit', () => {
  const contract = readContract(path.join(repositoryRoot, 'ops/toolchain/shellcheck-bootstrap.json'));
  const cacheDir = fs.mkdtempSync(path.join(os.tmpdir(), 'toolchain-cache-'));
  const archivePath = path.join(cacheDir, contract.version, contract.artifactName);
  fs.mkdirSync(path.dirname(archivePath), { recursive: true });
  fs.writeFileSync(archivePath, Buffer.from('tampered archive bytes'));
  assert.throws(
    () => readVerifiedArchive(archivePath, contract.sha256),
    /SHA-256 mismatch/,
  );
});

test('tar and zip extractors reject path traversal members', () => {
  assert.throws(() => normalizeMember('../shellcheck'), /unsafe archive member path/);
  assert.throws(() => normalizeMemberPath('../maestro/bin/maestro'), /traversal|unsafe/);
});

test('check-shell.sh uses ensure-shellcheck bootstrap on Linux CI', () => {
  const source = fs.readFileSync(path.join(repositoryRoot, 'scripts/check-shell.sh'), 'utf8');
  assert.match(source, /ensure-shellcheck\.sh/);
  assert.match(source, /skipped \(not installed; Linux CI bootstraps the pinned binary/);
});
