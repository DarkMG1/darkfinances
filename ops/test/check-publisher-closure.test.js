'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const { spawnSync } = require('child_process');
const path = require('path');
const { verifyRuntimeClosureContractFreshness } = require('../../finance-dashboard/lib/eas-cli-runtime-closure');
const { verifyPublisherToolchain } = require('../../finance-dashboard/lib/publisher-toolchain');

const repositoryRoot = path.resolve(__dirname, '..', '..');
const BOUND_PLATFORM = process.platform === 'darwin' && process.arch === 'arm64';

test('linux-simulated freshness and contract evidence pass without installed-byte verification', () => {
  const linux = { platform: 'linux', arch: 'x64' };
  assert.doesNotThrow(() => verifyRuntimeClosureContractFreshness(repositoryRoot, linux));
  const evidence = verifyPublisherToolchain(repositoryRoot, linux);
  assert.equal(evidence.packageCount, 510);
  assert.equal(evidence.fileCount, 15211);
  assert.match(evidence.runtimeClosureDigest, /^[a-f0-9]{64}$/);
});

test('check-publisher-closure validates installed bytes on bound platform only', { skip: !BOUND_PLATFORM }, () => {
  const result = spawnSync(process.execPath, [
    path.join(repositoryRoot, 'scripts/check-publisher-closure.js'),
  ], {
    cwd: repositoryRoot,
    encoding: 'utf8',
  });
  assert.equal(result.status, 0, result.stderr || result.stdout);
  assert.match(result.stdout, /publisher-closure: ok 510 packages 15211 files [a-f0-9]{64}/);
});
