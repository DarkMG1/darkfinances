'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const path = require('path');
const { assertAllowedHost, downloadBounded } = require('../../scripts/toolchain-download');
const {
  PREFERRED_DEVICES,
  collectIphoneDevices,
  selectDevice,
} = require('../../scripts/ci-ios-simulator');

const repositoryRoot = path.resolve(__dirname, '..', '..');
const workflowsDir = path.join(repositoryRoot, '.github/workflows');

const NATIVE_STRESS_WORKFLOWS = [
  {
    name: 'ios-pr-smoke.yml',
    firstExecutionMarker: 'ci-ios-simulator.js',
    pathFiltered: true,
  },
  {
    name: 'maestro-full-suite.yml',
    firstExecutionMarker: 'ci-ios-simulator.js',
    pathFiltered: false,
  },
  {
    name: 'android-compile-smoke.yml',
    firstExecutionMarker: 'prebuild -p android',
    pathFiltered: true,
  },
  {
    name: 'shutdown-stress.yml',
    firstExecutionMarker: 'check:shutdown-stress',
    pathFiltered: false,
  },
];

const SUPPLY_CHAIN_PATH_TRIGGERS = [
  'ops/publisher-toolchain/**',
  'ops/vulnerability-exceptions.json',
  'scripts/check-github-action-pins.js',
  'scripts/check-vulnerability-gate.js',
  'docs/vulnerability-policy.md',
];

function readWorkflow(name) {
  return fs.readFileSync(path.join(workflowsDir, name), 'utf8');
}

function assertSupplyChainPreflightOrder(workflow, { name, firstExecutionMarker }) {
  const npmCiIndex = workflow.indexOf('- run: npm ci');
  const preflightIndex = workflow.indexOf('Supply-chain preflight (pinned actions + vulnerability gate)');
  const upstreamIndex = workflow.indexOf('check:action-pins:upstream');
  const vulnerabilityIndex = workflow.indexOf('check:vulnerabilities');
  const executionIndex = workflow.indexOf(firstExecutionMarker);

  assert.ok(npmCiIndex >= 0, `${name} must run npm ci`);
  assert.ok(preflightIndex >= 0, `${name} must declare supply-chain preflight step`);
  assert.ok(upstreamIndex >= 0, `${name} must run check:action-pins:upstream`);
  assert.ok(vulnerabilityIndex >= 0, `${name} must run check:vulnerabilities`);
  assert.ok(executionIndex >= 0, `${name} must run ${firstExecutionMarker}`);
  assert.ok(npmCiIndex < preflightIndex, `${name} must run npm ci before supply-chain preflight`);
  assert.ok(
    preflightIndex < upstreamIndex && upstreamIndex < vulnerabilityIndex,
    `${name} must run upstream pin check before vulnerability gate inside preflight`,
  );
  assert.ok(
    vulnerabilityIndex < executionIndex,
    `${name} must finish supply-chain preflight before ${firstExecutionMarker}`,
  );
  assert.doesNotMatch(workflow, /actions\/cache@/);
}

test('toolchain download rejects off-host redirects', async () => {
  await assert.rejects(
    () => downloadBounded('https://github.com/example/example/releases/download/v1/file.tgz', {
      allowedHosts: ['github.com'],
      fetchImpl: async (url, options) => {
        if (options?.redirect === 'manual') {
          return {
            status: 302,
            headers: { get: () => 'https://evil.example/file.tgz' },
            ok: false,
          };
        }
        throw new Error('unexpected fetch');
      },
    }),
    /outside allowlist/,
  );
});

test('toolchain download rejects insecure redirects', async () => {
  await assert.rejects(
    () => downloadBounded('https://github.com/example/example/releases/download/v1/file.tgz', {
      allowedHosts: ['github.com'],
      fetchImpl: async (url, options) => {
        if (options?.redirect === 'manual') {
          return {
            status: 302,
            headers: { get: () => 'http://github.com/file.tgz' },
            ok: false,
          };
        }
        throw new Error('unexpected fetch');
      },
    }),
    /refusing insecure URL/,
  );
});

test('assertAllowedHost enforces exact host allowlist', () => {
  assert.doesNotThrow(() => assertAllowedHost('github.com', ['github.com']));
  assert.throws(() => assertAllowedHost('evil.example', ['github.com']), /outside allowlist/);
});

test('iOS simulator selection prefers current hardware on the newest available runtime', () => {
  assert.deepEqual(PREFERRED_DEVICES.slice(0, 5), [
    'iPhone 17 Pro',
    'iPhone 17',
    'iPhone 17 Pro Max',
    'iPhone 17e',
    'iPhone Air',
  ]);
  const devices = collectIphoneDevices({
    devices: {
      'com.apple.CoreSimulator.SimRuntime.iOS-26-2': [
        { name: 'iPhone 17 Pro', udid: 'older-pro', isAvailable: true },
      ],
      'com.apple.CoreSimulator.SimRuntime.iOS-26-4': [
        { name: 'iPhone 17', udid: 'current-standard', isAvailable: true },
        { name: 'iPhone 17 Pro', udid: 'current-pro', isAvailable: true },
      ],
    },
  });

  const selected = selectDevice(devices);
  assert.equal(selected.udid, 'current-pro');
  assert.equal(selected.runtime, 'com.apple.CoreSimulator.SimRuntime.iOS-26-4');
});

test('native and stress workflows run supply-chain preflight after npm ci and before execution', () => {
  for (const workflowSpec of NATIVE_STRESS_WORKFLOWS) {
    assertSupplyChainPreflightOrder(readWorkflow(workflowSpec.name), workflowSpec);
  }
});

test('path-filtered native workflows trigger on supply-chain checker and policy files', () => {
  for (const workflowSpec of NATIVE_STRESS_WORKFLOWS.filter((item) => item.pathFiltered)) {
    const workflow = readWorkflow(workflowSpec.name);
    for (const triggerPath of SUPPLY_CHAIN_PATH_TRIGGERS) {
      const escaped = triggerPath.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
      assert.match(workflow, new RegExp(`- '${escaped}'`));
    }
  }
});

test('iOS workflows use dynamic simulator, locked expo, metro, DEVICE on Maestro, and GITHUB_PATH wiring', () => {
  for (const name of ['ios-pr-smoke.yml', 'maestro-full-suite.yml']) {
    const workflow = readWorkflow(name);
    assert.match(workflow, /ci-ios-simulator\.js/);
    assert.match(workflow, /steps\.simulator\.outputs\.device/);
    assert.match(workflow, /resolve-expo-bin\.js/);
    assert.match(workflow, /GITHUB_PATH/);
    assert.match(workflow, /ci-metro\.pid/);
    assert.match(workflow, /retention-days:\s*3/);
    assert.match(workflow, /DEVICE:\s*\$\{\{\s*steps\.simulator\.outputs\.device\s*\}\}/);
    assert.doesNotMatch(workflow, /iPhone 16'/);
    assert.doesNotMatch(workflow, /actions:\s*write/);
  }
  assert.match(readWorkflow('ios-pr-smoke.yml'), /push:[\s\S]*branches:[\s\S]*- main/);
});

test('iOS workflows verify pinned CocoaPods immediately after supply-chain preflight and before simulator boot', () => {
  for (const name of ['ios-pr-smoke.yml', 'maestro-full-suite.yml']) {
    const workflow = readWorkflow(name);
    const preflightIndex = workflow.indexOf('Supply-chain preflight (pinned actions + vulnerability gate)');
    const vulnerabilityIndex = workflow.indexOf('check:vulnerabilities');
    const ensureIndex = workflow.indexOf('ensure-cocoapods.sh');
    const simulatorIndex = workflow.indexOf('ci-ios-simulator.js');
    const prebuildIndex = workflow.indexOf('prebuild -p ios');
    assert.ok(preflightIndex >= 0, `${name} must declare supply-chain preflight`);
    assert.ok(ensureIndex >= 0, `${name} must call ensure-cocoapods.sh`);
    assert.ok(simulatorIndex >= 0, `${name} must boot simulator`);
    assert.ok(prebuildIndex >= 0, `${name} must run expo prebuild for ios`);
    assert.ok(vulnerabilityIndex < ensureIndex, `${name} must verify CocoaPods after vulnerability gate`);
    assert.ok(ensureIndex < simulatorIndex, `${name} must verify CocoaPods before simulator boot`);
    assert.ok(ensureIndex < prebuildIndex, `${name} must verify CocoaPods before prebuild`);
    assert.doesNotMatch(workflow, /pod install/);
    assert.match(workflow, /--dev-client/);
  }
});

test('maestro full suite is schedule-only while ios-pr-smoke provides PR-native iOS coverage', () => {
  const fullSuite = readWorkflow('maestro-full-suite.yml');
  const prSmoke = readWorkflow('ios-pr-smoke.yml');

  assert.match(fullSuite, /schedule:/);
  assert.match(fullSuite, /workflow_dispatch:/);
  assert.doesNotMatch(fullSuite, /pull_request:/);
  assert.doesNotMatch(fullSuite, /^\s+paths:/m);

  assert.match(prSmoke, /pull_request:/);
  assert.match(prSmoke, /paths:/);
  assert.match(prSmoke, /ensure-cocoapods\.sh/);
  assert.match(fullSuite, /ensure-cocoapods\.sh/);
  assert.match(fullSuite, /Run full Maestro suite/);
});

test('android workflow uses ubuntu-24.04, verifies SDK, uploads APK, and avoids mutable caches', () => {
  const workflow = readWorkflow('android-compile-smoke.yml');
  assert.match(workflow, /runs-on:\s*ubuntu-24\.04/);
  assert.match(workflow, /Verify Android SDK/);
  assert.match(workflow, /resolve-expo-bin\.js/);
  assert.match(workflow, /upload-artifact@ea165f8d65b6e75b540449e92b4886f43607fa02/);
  assert.match(workflow, /app-debug\.apk/);
  assert.match(workflow, /push:[\s\S]*branches:[\s\S]*- main/);
  assert.doesNotMatch(workflow, /actions\/cache@/);
  assert.doesNotMatch(workflow, /cache:\s*gradle/);
  assert.doesNotMatch(workflow, /cache:\s*npm/);
});
