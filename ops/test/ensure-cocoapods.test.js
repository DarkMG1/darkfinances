'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const os = require('os');
const path = require('path');
const { spawnSync } = require('child_process');

const repositoryRoot = path.resolve(__dirname, '..', '..');
const ensureScript = path.join(repositoryRoot, 'scripts/ensure-cocoapods.sh');
const contractPath = path.join(repositoryRoot, 'ops/toolchain/cocoapods-contract.json');
const expectedVersion = '1.17.0';

function runEnsureCocoapods(env = {}) {
  return spawnSync('/bin/bash', [ensureScript], {
    cwd: repositoryRoot,
    encoding: 'utf8',
    env: { ...process.env, ...env },
  });
}

function locateExecutable(name, pathValue = process.env.PATH || '') {
  for (const dir of pathValue.split(':').filter(Boolean)) {
    const candidate = path.join(dir, name);
    try {
      fs.accessSync(candidate, fs.constants.X_OK);
      return candidate;
    } catch {
      // continue
    }
  }
  return null;
}

function writeFakePod(t, { stdoutLines = [], stderrLines = [], exitCode = 0 } = {}) {
  const binDir = fs.mkdtempSync(path.join(os.tmpdir(), 'darkfinances-fake-pod-'));
  t.after(() => fs.rmSync(binDir, { recursive: true, force: true }));
  const fake = path.join(binDir, 'pod');
  const body = [
    '#!/usr/bin/env bash',
    'if [[ "$1" == "--version" ]]; then',
    ...stderrLines.map((line) => `  printf '%s\\n' ${JSON.stringify(line)} >&2`),
    ...stdoutLines.map((line) => `  printf '%s\\n' ${JSON.stringify(line)}`),
    `  exit ${exitCode}`,
    'fi',
    'exit 0',
  ].join('\n');
  fs.writeFileSync(fake, `${body}\n`);
  fs.chmodSync(fake, 0o755);
  return fake;
}

function combinedOutput(result) {
  return `${result.stderr || ''}\n${result.stdout || ''}`;
}

test('cocoapods contract pins macOS CLI version 1.17.0 with verify-only policy and runner-image baseline', () => {
  const contract = JSON.parse(fs.readFileSync(contractPath, 'utf8'));
  assert.equal(contract.schemaVersion, 1);
  assert.equal(contract.package, 'cocoapods');
  assert.equal(contract.version, expectedVersion);
  assert.equal(contract.platform, 'macos');
  assert.equal(contract.command, 'pod');
  assert.match(contract.provenance, /rubygems\.org\/gems\/cocoapods\/versions\/1\.17\.0/);
  assert.equal(contract.policy.mode, 'verify-only');
  assert.equal(contract.policy.autoInstall, false);
  assert.equal(contract.policy.ciPlatform, 'macos');
  assert.equal(contract.policy.runnerImage.label, 'macos-26');
  assert.deepEqual(contract.policy.runnerImage.verifiedBaselines, [
    'actions/runner-images macos-26/20260720.0390',
  ]);
  assert.match(contract.policy.runnerImage.driftBehavior, /fail closed/i);
});

test('ensure-cocoapods script does not auto-install gems', () => {
  const source = fs.readFileSync(ensureScript, 'utf8');
  assert.doesNotMatch(source, /gem install/);
  assert.doesNotMatch(source, /brew install/);
  assert.match(source, /cocoapods-contract\.json/);
});

test('ensure-cocoapods skips on unsupported local platform', () => {
  if (process.platform === 'darwin') {
    assert.ok(true, 'macOS verification covered by dedicated tests');
    return;
  }
  const result = runEnsureCocoapods({ CI: '', GITHUB_ACTIONS: '' });
  assert.equal(result.status, 0, combinedOutput(result));
  assert.match(result.stdout, /skipped \(unsupported platform/);
});

test('ensure-cocoapods fails in CI on unsupported platform', () => {
  if (process.platform === 'darwin') {
    assert.ok(true, 'macOS is the supported CI platform');
    return;
  }
  const result = runEnsureCocoapods({ CI: 'true', GITHUB_ACTIONS: 'true' });
  assert.notEqual(result.status, 0);
  assert.match(result.stderr, /required macOS CI runner/);
});

test('ensure-cocoapods fails on version mismatch with diagnostic output', (t) => {
  if (process.platform !== 'darwin') {
    assert.ok(true, 'fake pod injection requires macOS branch');
    return;
  }
  const fakePod = writeFakePod(t, { stdoutLines: ['1.15.0'] });
  const result = runEnsureCocoapods({ ENSURE_COCOAPODS_POD: fakePod, CI: '', GITHUB_ACTIONS: '' });
  const output = combinedOutput(result);
  assert.notEqual(result.status, 0);
  assert.match(output, /expected CocoaPods 1\.17\.0, got 1\.15\.0/);
  assert.match(output, /1\.15\.0/);
});

test('ensure-cocoapods accepts injected pod binary on version match', (t) => {
  if (process.platform !== 'darwin') {
    assert.ok(true, 'fake pod injection requires macOS branch');
    return;
  }
  const fakePod = writeFakePod(t, { stdoutLines: [expectedVersion] });
  const result = runEnsureCocoapods({ ENSURE_COCOAPODS_POD: fakePod, CI: '', GITHUB_ACTIONS: '' });
  assert.equal(result.status, 0, combinedOutput(result));
  assert.equal(result.stdout.trim(), fakePod);
});

test('ensure-cocoapods rejects nonzero pod exit even when output contains expected semver', (t) => {
  if (process.platform !== 'darwin') {
    assert.ok(true, 'fake pod injection requires macOS branch');
    return;
  }
  const fakePod = writeFakePod(t, { stdoutLines: [expectedVersion], exitCode: 1 });
  const result = runEnsureCocoapods({ ENSURE_COCOAPODS_POD: fakePod, CI: '', GITHUB_ACTIONS: '' });
  const output = combinedOutput(result);
  assert.notEqual(result.status, 0);
  assert.match(output, /pod --version exited 1/);
  assert.match(output, new RegExp(expectedVersion));
});

test('ensure-cocoapods rejects stderr noise without canonical semver line', (t) => {
  if (process.platform !== 'darwin') {
    assert.ok(true, 'fake pod injection requires macOS branch');
    return;
  }
  const fakePod = writeFakePod(t, {
    stdoutLines: [],
    stderrLines: ['warning: rubygems mirror unavailable'],
  });
  const result = runEnsureCocoapods({ ENSURE_COCOAPODS_POD: fakePod, CI: '', GITHUB_ACTIONS: '' });
  const output = combinedOutput(result);
  assert.notEqual(result.status, 0);
  assert.match(output, /no canonical x\.y\.z version line/);
  assert.match(output, /rubygems mirror unavailable/);
});

test('ensure-cocoapods rejects prerelease semver output', (t) => {
  if (process.platform !== 'darwin') {
    assert.ok(true, 'fake pod injection requires macOS branch');
    return;
  }
  const fakePod = writeFakePod(t, { stdoutLines: ['1.17.0-beta.1'] });
  const result = runEnsureCocoapods({ ENSURE_COCOAPODS_POD: fakePod, CI: '', GITHUB_ACTIONS: '' });
  const output = combinedOutput(result);
  assert.notEqual(result.status, 0);
  assert.match(output, /prerelease semver/);
  assert.match(output, /1\.17\.0-beta\.1/);
});

test('ensure-cocoapods rejects multiple canonical semver lines', (t) => {
  if (process.platform !== 'darwin') {
    assert.ok(true, 'fake pod injection requires macOS branch');
    return;
  }
  const fakePod = writeFakePod(t, { stdoutLines: ['1.16.2', expectedVersion] });
  const result = runEnsureCocoapods({ ENSURE_COCOAPODS_POD: fakePod, CI: '', GITHUB_ACTIONS: '' });
  const output = combinedOutput(result);
  assert.notEqual(result.status, 0);
  assert.match(output, /ambiguous pod --version output/);
  assert.match(output, /1\.16\.2/);
  assert.match(output, new RegExp(expectedVersion));
});

test('ensure-cocoapods rejects embedded semver substrings without whole-line match', (t) => {
  if (process.platform !== 'darwin') {
    assert.ok(true, 'fake pod injection requires macOS branch');
    return;
  }
  const fakePod = writeFakePod(t, { stdoutLines: [`CocoaPods ${expectedVersion} (build 42)`] });
  const result = runEnsureCocoapods({ ENSURE_COCOAPODS_POD: fakePod, CI: '', GITHUB_ACTIONS: '' });
  const output = combinedOutput(result);
  assert.notEqual(result.status, 0);
  assert.match(output, /no canonical x\.y\.z version line/);
});

test('ensure-cocoapods fails when pod is missing on macOS', () => {
  if (process.platform !== 'darwin') {
    assert.ok(true, 'missing pod path requires macOS branch');
    return;
  }
  const podLocation = locateExecutable('pod');
  if (!podLocation) {
    assert.ok(true, 'host pod already missing');
    return;
  }
  const podDir = path.dirname(podLocation);
  const pathEntries = (process.env.PATH || '').split(':').filter((entry) => entry && entry !== podDir);
  const result = runEnsureCocoapods({
    CI: '',
    GITHUB_ACTIONS: '',
    PATH: pathEntries.join(':'),
  });
  const output = combinedOutput(result);
  assert.notEqual(result.status, 0);
  assert.match(output, /pod not found on PATH/);
  assert.match(output, /expected CocoaPods 1\.17\.0/);
});
