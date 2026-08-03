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
const appConfig = JSON.parse(
  fs.readFileSync(path.join(repositoryRoot, 'finance-app/app.json'), 'utf8'),
).expo;
const widgetPlugin = appConfig.plugins.find(
  (plugin) => Array.isArray(plugin) && plugin[0] === 'expo-widgets',
);
assert.ok(widgetPlugin, 'finance-app config must include expo-widgets');
const simulatorAppIdentifier = `FAKETEAMID.${appConfig.ios.bundleIdentifier}`;
const simulatorWidgetIdentifier = `FAKETEAMID.${widgetPlugin[1].bundleIdentifier}`;
const simulatorAppGroup = widgetPlugin[1].groupIdentifier;

const NATIVE_STRESS_JOBS = [
  {
    name: 'ios-pr-smoke.yml',
    job: 'ios-simulator-build',
    firstExecutionMarker: 'ensure-cocoapods.sh',
    pathFiltered: true,
  },
  {
    name: 'ios-pr-smoke.yml',
    job: 'ios-simulator-maestro',
    firstExecutionMarker: 'ci-ios-simulator.js',
    pathFiltered: true,
  },
  {
    name: 'maestro-full-suite.yml',
    job: 'maestro-ios-build',
    firstExecutionMarker: 'ensure-cocoapods.sh',
    pathFiltered: false,
  },
  {
    name: 'maestro-full-suite.yml',
    job: 'maestro-ios',
    firstExecutionMarker: 'ci-ios-simulator.js',
    pathFiltered: false,
  },
  {
    name: 'android-compile-smoke.yml',
    job: 'android-assemble-debug',
    firstExecutionMarker: 'prebuild -p android',
    pathFiltered: true,
  },
  {
    name: 'shutdown-stress.yml',
    job: 'bounded-stress',
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

function escapeRegExp(value) {
  return value.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

function readWorkflowJob(name, jobName) {
  const lines = readWorkflow(name).split('\n');
  const start = lines.findIndex((line) => line === `  ${jobName}:`);
  assert.ok(start >= 0, `${name} must contain job ${jobName}`);
  const relativeEnd = lines.slice(start + 1).findIndex((line) => /^  [a-z0-9_-]+:\s*$/.test(line));
  const end = relativeEnd < 0 ? lines.length : start + 1 + relativeEnd;
  return lines.slice(start, end).join('\n');
}

function assertSupplyChainPreflightOrder(jobText, { name, job, firstExecutionMarker }) {
  const label = `${name}:${job}`;
  const npmCiIndex = jobText.indexOf('- run: npm ci');
  const preflightIndex = jobText.indexOf('Supply-chain preflight (pinned actions + vulnerability gate)');
  const upstreamIndex = jobText.indexOf('check:action-pins:upstream');
  const vulnerabilityIndex = jobText.indexOf('check:vulnerabilities');
  const executionIndex = jobText.indexOf(firstExecutionMarker);

  assert.ok(npmCiIndex >= 0, `${label} must run npm ci`);
  assert.ok(preflightIndex >= 0, `${label} must declare supply-chain preflight step`);
  assert.ok(upstreamIndex >= 0, `${label} must run check:action-pins:upstream`);
  assert.ok(vulnerabilityIndex >= 0, `${label} must run check:vulnerabilities`);
  assert.ok(executionIndex >= 0, `${label} must run ${firstExecutionMarker}`);
  assert.ok(npmCiIndex < preflightIndex, `${label} must run npm ci before supply-chain preflight`);
  assert.ok(
    preflightIndex < upstreamIndex && upstreamIndex < vulnerabilityIndex,
    `${label} must run upstream pin check before vulnerability gate inside preflight`,
  );
  assert.ok(
    vulnerabilityIndex < executionIndex,
    `${label} must finish supply-chain preflight before ${firstExecutionMarker}`,
  );
  assert.doesNotMatch(jobText, /actions\/cache@/);
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
      'com.apple.CoreSimulator.SimRuntime.iOS-18-5': [
        { name: 'iPhone 16 Pro', udid: 'ios18-pro', isAvailable: true },
      ],
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
  assert.equal(selectDevice(devices, { runtime: '18.5' }).udid, 'ios18-pro');
  assert.throws(
    () => selectDevice(devices, { runtime: '18.4' }),
    /no available iPhone simulator found for iOS 18\.4/,
  );
  assert.throws(
    () => selectDevice(devices, { runtime: 'latest' }),
    /invalid IOS_SIMULATOR_RUNTIME/,
  );
});

test('native and stress workflows run supply-chain preflight after npm ci and before execution', () => {
  for (const workflowSpec of NATIVE_STRESS_JOBS) {
    assertSupplyChainPreflightOrder(
      readWorkflowJob(workflowSpec.name, workflowSpec.job),
      workflowSpec,
    );
  }
});

test('path-filtered native workflows trigger on supply-chain checker and policy files', () => {
  const workflowNames = new Set(
    NATIVE_STRESS_JOBS.filter((item) => item.pathFiltered).map((item) => item.name),
  );
  for (const workflowName of workflowNames) {
    const workflow = readWorkflow(workflowName);
    for (const triggerPath of SUPPLY_CHAIN_PATH_TRIGGERS) {
      const escaped = triggerPath.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
      assert.match(workflow, new RegExp(`- '${escaped}'`));
    }
  }
});

test('iOS workflows use dynamic simulator, locked expo, metro, DEVICE on Maestro, and GITHUB_PATH wiring', () => {
  for (const [name, testJobName] of [
    ['ios-pr-smoke.yml', 'ios-simulator-maestro'],
    ['maestro-full-suite.yml', 'maestro-ios'],
  ]) {
    const workflow = readWorkflow(name);
    const testJob = readWorkflowJob(name, testJobName);
    assert.match(testJob, /ci-ios-simulator\.js/);
    assert.match(testJob, /steps\.simulator\.outputs\.device/);
    assert.match(testJob, /resolve-expo-bin\.js/);
    assert.match(testJob, /GITHUB_PATH/);
    assert.match(testJob, /ci-metro\.pid/);
    assert.match(testJob, /retention-days:\s*3/);
    assert.match(testJob, /IOS_SIMULATOR_RUNTIME:\s*'18\.5'/);
    assert.match(testJob, /DEVICE:\s*\$\{\{\s*steps\.simulator\.outputs\.device\s*\}\}/);
    assert.doesNotMatch(workflow, /iPhone 16'/);
    assert.doesNotMatch(workflow, /actions:\s*write/);
  }
  assert.match(readWorkflow('ios-pr-smoke.yml'), /push:[\s\S]*branches:[\s\S]*- main/);
});

test('iOS build jobs verify CocoaPods while Maestro jobs boot only after their own preflight', () => {
  for (const [name, buildJobName, testJobName] of [
    ['ios-pr-smoke.yml', 'ios-simulator-build', 'ios-simulator-maestro'],
    ['maestro-full-suite.yml', 'maestro-ios-build', 'maestro-ios'],
  ]) {
    const workflow = readWorkflow(name);
    const buildJob = readWorkflowJob(name, buildJobName);
    const testJob = readWorkflowJob(name, testJobName);
    const buildVulnerabilityIndex = buildJob.indexOf('check:vulnerabilities');
    const ensureIndex = buildJob.indexOf('ensure-cocoapods.sh');
    const prebuildIndex = buildJob.indexOf('prebuild -p ios');
    const testVulnerabilityIndex = testJob.indexOf('check:vulnerabilities');
    const simulatorIndex = testJob.indexOf('ci-ios-simulator.js');
    assert.ok(buildVulnerabilityIndex < ensureIndex, `${name} build must verify CocoaPods after vulnerability gate`);
    assert.ok(ensureIndex < prebuildIndex, `${name} build must verify CocoaPods before prebuild`);
    assert.ok(testVulnerabilityIndex < simulatorIndex, `${name} test must finish preflight before simulator boot`);
    assert.doesNotMatch(buildJob, /ci-ios-simulator\.js/);
    assert.doesNotMatch(testJob, /ensure-cocoapods\.sh|prebuild -p ios/);
    assert.doesNotMatch(workflow, /pod install/);
    assert.match(testJob, /--dev-client/);
  }
});

test('iOS workflows checksum-bind arm64 simulator apps across the split runner boundary', () => {
  for (const [name, buildJobName, testJobName, artifactName] of [
    ['ios-pr-smoke.yml', 'ios-simulator-build', 'ios-simulator-maestro', 'ios-simulator-app'],
    ['maestro-full-suite.yml', 'maestro-ios-build', 'maestro-ios', 'maestro-ios-app'],
  ]) {
    const buildJob = readWorkflowJob(name, buildJobName);
    const testJob = readWorkflowJob(name, testJobName);
    assert.match(buildJob, /test "\$\(uname -m\)" = arm64/);
    assert.match(buildJob, /destination 'generic\/platform=iOS Simulator'/);
    assert.match(buildJob, /ARCHS=arm64/);
    assert.match(buildJob, /CODE_SIGN_IDENTITY=-/);
    assert.match(buildJob, /CODE_SIGNING_REQUIRED=YES/);
    assert.match(buildJob, /CODE_SIGNING_ALLOWED=YES/);
    assert.match(buildJob, /CODE_SIGN_STYLE=Manual/);
    assert.match(buildJob, /DEVELOPMENT_TEAM=''/);
    assert.doesNotMatch(buildJob, /CODE_SIGNING_ALLOWED=NO|CODE_SIGNING_REQUIRED=NO/);
    assert.match(buildJob, /Signature=adhoc/);
    assert.match(buildJob, /Finances\.app-Simulated\.xcent/);
    assert.match(buildJob, /ExpoWidgetsTarget\.appex-Simulated\.xcent/);
    assert.match(buildJob, /test -f "\$app_simulator_entitlements"/);
    assert.match(buildJob, /test -f "\$widget_simulator_entitlements"/);
    assert.doesNotMatch(buildJob, /codesign --force --sign/);
    assert.doesNotMatch(buildJob, /codesign -d --entitlements :-/);
    assert.match(buildJob, /codesign -d --entitlements - --xml/);
    assert.match(buildJob, /simulator code signature unexpectedly contains entitlements/);
    assert.match(buildJob, /\[\[ "\$\(plutil -convert json -o - "\$output"\)" != '\{\}' \]\]/);
    assert.match(buildJob, /test "\$\(lipo -archs "\$widget_path\/\$widget_executable"\)" = arm64/);
    assert.match(buildJob, /extract_simulator_entitlements/);
    assert.match(buildJob, /otool -X -s __TEXT __entitlements/);
    assert.match(buildJob, /xxd -r -p/);
    assert.match(buildJob, /plutil -lint "\$output"/);
    assert.match(buildJob, /plutil -convert json/);
    assert.match(buildJob, new RegExp(escapeRegExp(simulatorAppIdentifier)));
    assert.match(buildJob, new RegExp(escapeRegExp(simulatorWidgetIdentifier)));
    assert.match(buildJob, new RegExp(escapeRegExp(simulatorAppGroup)));
    assert.match(buildJob, /Print :aps-environment/);
    const xcodeBuildIndex = buildJob.indexOf('xcodebuild \\');
    const signIndex = buildJob.indexOf('codesign --verify --deep --strict');
    const buildSignatureBoundaryIndex = buildJob.indexOf(
      'assert_empty_signature_entitlements "$app_path"',
    );
    const buildEmbeddedEntitlementsIndex = buildJob.indexOf(
      'extract_simulator_entitlements "$app_path/$executable"',
    );
    const buildWidgetEntitlementsIndex = buildJob.indexOf(
      'extract_simulator_entitlements "$widget_path/$widget_executable"',
    );
    const entitlementValidationIndex = buildJob.indexOf('Print :application-identifier');
    const packageIndex = buildJob.indexOf('COPYFILE_DISABLE=1 tar -czf');
    assert.ok(xcodeBuildIndex >= 0 && xcodeBuildIndex < signIndex);
    assert.ok(signIndex < buildSignatureBoundaryIndex);
    assert.ok(buildSignatureBoundaryIndex < buildEmbeddedEntitlementsIndex);
    assert.ok(buildEmbeddedEntitlementsIndex < buildWidgetEntitlementsIndex);
    assert.ok(buildWidgetEntitlementsIndex < entitlementValidationIndex);
    assert.ok(entitlementValidationIndex < packageIndex);
    assert.match(buildJob, /COPYFILE_DISABLE=1 tar -czf/);
    assert.match(buildJob, /shasum -a 256 ios-simulator-app\.tgz/);
    assert.match(buildJob, /actions\/upload-artifact@ea165f8d65b6e75b540449e92b4886f43607fa02/);
    assert.match(buildJob, new RegExp(`name:\\s*${artifactName}-\\$\\{\\{ github\\.run_id \\}\\}`));

    assert.match(testJob, new RegExp(`needs:\\s*${buildJobName}`));
    assert.match(testJob, /test "\$\(uname -m\)" = arm64/);
    assert.match(testJob, /actions\/download-artifact@3e5f45b2cfb9172054b4087a40e8e0b5a5461e7c/);
    assert.match(testJob, new RegExp(`name:\\s*${artifactName}-\\$\\{\\{ github\\.run_id \\}\\}`));
    const checksumIndex = testJob.indexOf('shasum -a 256 -c');
    const extractIndex = testJob.indexOf('tar -xzf');
    const architectureIndex = testJob.indexOf('lipo -archs');
    const signatureIndex = testJob.indexOf('codesign --verify --deep --strict');
    const signatureEntitlementsIndex = testJob.indexOf('codesign -d --entitlements - --xml');
    const testSignatureBoundaryIndex = testJob.indexOf(
      'assert_empty_signature_entitlements "$app_path"',
    );
    const testEmbeddedEntitlementsIndex = testJob.indexOf(
      'extract_simulator_entitlements "$app_path/$executable"',
    );
    const testWidgetEntitlementsIndex = testJob.indexOf(
      'extract_simulator_entitlements "$widget_path/$widget_executable"',
    );
    const runtimeIndex = testJob.indexOf('steps.simulator.outputs.runtime');
    const installIndex = testJob.indexOf('xcrun simctl install');
    assert.ok(checksumIndex >= 0 && checksumIndex < extractIndex);
    assert.ok(extractIndex < architectureIndex);
    assert.ok(architectureIndex < signatureIndex);
    assert.ok(signatureIndex < signatureEntitlementsIndex);
    assert.ok(signatureEntitlementsIndex < testSignatureBoundaryIndex);
    assert.ok(testSignatureBoundaryIndex < testEmbeddedEntitlementsIndex);
    assert.ok(testEmbeddedEntitlementsIndex < testWidgetEntitlementsIndex);
    assert.ok(testWidgetEntitlementsIndex < runtimeIndex);
    assert.ok(runtimeIndex < installIndex);
    assert.match(testJob, /Signature=adhoc/);
    assert.match(testJob, /widget_path="\$app_path\/PlugIns\/ExpoWidgetsTarget\.appex"/);
    assert.match(testJob, /test -d "\$widget_path"/);
    assert.match(testJob, /widget_executable=/);
    assert.doesNotMatch(testJob, /codesign --force --sign/);
    assert.doesNotMatch(testJob, /codesign -d --entitlements :-/);
    assert.match(testJob, /codesign -d --entitlements - --xml/);
    assert.match(testJob, /simulator code signature unexpectedly contains entitlements/);
    assert.match(testJob, /\[\[ "\$\(plutil -convert json -o - "\$output"\)" != '\{\}' \]\]/);
    assert.match(testJob, /test "\$\(lipo -archs "\$widget_path\/\$widget_executable"\)" = arm64/);
    assert.match(testJob, /otool -X -s __TEXT __entitlements/);
    assert.match(testJob, /xxd -r -p/);
    assert.match(testJob, /plutil -lint "\$output"/);
    assert.match(testJob, new RegExp(escapeRegExp(simulatorAppIdentifier)));
    assert.match(testJob, new RegExp(escapeRegExp(simulatorWidgetIdentifier)));
    assert.match(testJob, new RegExp(escapeRegExp(simulatorAppGroup)));
    assert.match(testJob, /Print :aps-environment/);
    assert.match(testJob, /Print :CFBundleIdentifier/);
    assert.doesNotMatch(testJob, /simctl launch "\$DEVICE" dev\.darkmg1\.finances/);
    assert.match(testJob, /grep -q 'iOS Bundled' build\/ci-metro\.log/);
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
