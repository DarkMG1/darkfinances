const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const os = require('os');
const path = require('path');
const { execFileSync, spawnSync } = require('child_process');
const {
  DASHBOARD_RUNTIME_FILES,
  HASH_CHUNK_BYTES,
  buildManifest,
  buildSourceIdentity,
  canonicalSerialize,
  collectDeployedFiles,
  contractFingerprint,
  createGitRunner,
  hashRegularFile,
  parseCliArgs,
  recalculateContentDigest,
  sha256Canonical,
  verifyManifest,
  assertStdoutModeAllowed,
} = require('../../scripts/release-manifest');
const { validateManifestEnvelope, validateManifestContent } = require('../../finance-dashboard/lib/release-schema');
const { readReleaseIdentity } = require('../../finance-dashboard/lib/release-identity');
const { createEphemeralSigningMaterial } = require('./helpers/release-signing-fixtures');
const { signaturePathFor } = require('../../finance-dashboard/lib/release-signing');

const REPOSITORY_ROOT = path.resolve(__dirname, '..', '..');
const SCRIPT = path.join(REPOSITORY_ROOT, 'scripts', 'release-manifest.js');
const CAN_RUN_PUBLISHER_RUNTIME = process.platform === 'darwin'
  && process.arch === 'arm64'
  && fs.existsSync(path.join(REPOSITORY_ROOT, 'ops/publisher-toolchain/node_modules/eas-cli'));
const temporaryDirectories = [];

test.after(() => {
  for (const directory of temporaryDirectories) {
    fs.rmSync(directory, { recursive: true, force: true });
  }
});

function write(root, relative, contents) {
  const target = path.join(root, relative);
  fs.mkdirSync(path.dirname(target), { recursive: true });
  fs.writeFileSync(target, contents);
  return target;
}

function git(root, args, env = process.env) {
  return execFileSync('git', args, { cwd: root, encoding: 'utf8', env }).trim();
}

function writeBrokenSigner(directory) {
  fs.mkdirSync(directory, { recursive: true });
  const signer = path.join(directory, 'broken-gpg-signer.sh');
  fs.writeFileSync(
    signer,
    '#!/bin/sh\necho "broken signer invoked" >&2\nexit 1\n',
  );
  fs.chmodSync(signer, 0o755);
  return signer;
}

function createSimulatedGlobalGitConfig(brokenSignerPath) {
  const configDir = fs.mkdtempSync(path.join(os.tmpdir(), 'darkfinances-git-global-'));
  temporaryDirectories.push(configDir);
  const configPath = path.join(configDir, 'config');
  fs.writeFileSync(configPath, [
    '[commit]',
    '  gpgsign = true',
    '[gpg]',
    `  program = ${brokenSignerPath}`,
    '',
  ].join('\n'));
  return configPath;
}

function gitEnv(globalConfigPath) {
  return { ...process.env, GIT_CONFIG_GLOBAL: globalConfigPath };
}

function isolateFixtureRepositorySigning(root, brokenSignerPath) {
  git(root, ['config', 'commit.gpgsign', 'false']);
  git(root, ['config', 'gpg.program', brokenSignerPath]);
}

function createFixtureRepository() {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'darkfinances-release-test-'));
  temporaryDirectories.push(root);
  write(root, '.gitignore', [
    'node_modules/',
    'build/',
    '.env',
    'runtime-state.json',
    'finance-dashboard/release-manifest.json',
    '',
  ].join('\n'));
  write(root, 'package-lock.json', JSON.stringify({
    name: 'fixture',
    lockfileVersion: 3,
    packages: {
      '': { name: 'fixture', version: '1.0.0' },
      'node_modules/eas-cli': {
        version: '21.3.0',
        integrity: 'sha512-6btEJ0LVhRw4Hx8XSlCHSaSXgGBRpPr+90/7+NYu2HZ+1CP4lRnWqerXUdui7kUWxyst4f6OolKO+oWQ58nqHQ==',
      },
    },
  }, null, 2) + '\n');
  write(root, 'finance-dashboard/package.json', JSON.stringify({
    dependencies: { '@actual-app/api': '26.7.0' },
  }));
  write(root, 'actual-tools/package.json', JSON.stringify({
    dependencies: { '@actual-app/api': '26.7.0' },
  }));
  write(root, 'ops/actual-compose.yml', [
    'services:',
    '  actual:',
    '    image: actualbudget/actual-server:26.7.0',
    '',
  ].join('\n'));
  write(root, 'finance-dashboard/lib/validation.js', 'module.exports = "validation";\n');
  write(root, 'finance-app/src/api/generated/endpoints.ts', 'export const endpoints = [];\n');
  write(root, 'finance-app/src/api/generated/types.ts', 'export type Ping = { ok: true };\n');
  write(root, 'finance-app/package.json', JSON.stringify({
    name: 'fixture-app',
    version: '1.2.0',
  }, null, 2) + '\n');
  write(root, 'ops/publisher-toolchain/package.json', JSON.stringify({
    name: 'publisher-toolchain',
    version: '1.0.0',
    devDependencies: { 'eas-cli': '21.3.0' },
  }, null, 2) + '\n');
  write(root, 'finance-app/eas.json', JSON.stringify({
    cli: { version: '21.3.0', appVersionSource: 'local' },
    build: {
      production: { channel: 'production', environment: 'production' },
      preview: { channel: 'preview', environment: 'preview' },
    },
  }, null, 2) + '\n');
  fs.mkdirSync(path.join(root, 'ops/toolchain'), { recursive: true });
  fs.copyFileSync(
    path.join(REPOSITORY_ROOT, 'ops/toolchain/eas-cli-runtime-closure.json'),
    path.join(root, 'ops/toolchain/eas-cli-runtime-closure.json'),
  );
  fs.mkdirSync(path.join(root, 'ops/publisher-toolchain/node_modules'), { recursive: true });
  fs.cpSync(
    path.join(REPOSITORY_ROOT, 'ops/publisher-toolchain/node_modules/eas-cli'),
    path.join(root, 'ops/publisher-toolchain/node_modules/eas-cli'),
    { recursive: true },
  );
  const nestedEasModules = path.join(root, 'ops/publisher-toolchain/node_modules/eas-cli/node_modules');
  if (fs.existsSync(nestedEasModules)) fs.rmSync(nestedEasModules, { recursive: true, force: true });
  fs.copyFileSync(
    path.join(REPOSITORY_ROOT, 'ops/publisher-toolchain/package-lock.json'),
    path.join(root, 'ops/publisher-toolchain/package-lock.json'),
  );
  write(root, 'finance-app/package-lock.json', JSON.stringify({
    name: 'fixture-app',
    lockfileVersion: 3,
    packages: {
      '': { name: 'fixture-app', version: '1.2.0' },
    },
  }, null, 2) + '\n');
  write(root, 'finance-app/app.json', JSON.stringify({
    expo: {
      name: 'Fixture',
      slug: 'fixture',
      version: '1.2.0',
      runtimeVersion: { policy: 'appVersion' },
      updates: { requestHeaders: { 'expo-channel-name': 'production' } },
      ios: { buildNumber: '5' },
    },
  }));
  write(root, 'source.js', 'module.exports = "clean";\n');
  for (const relative of DASHBOARD_RUNTIME_FILES) {
    const target = path.join(root, 'finance-dashboard', relative);
    if (!fs.existsSync(target)) write(root, `finance-dashboard/${relative}`, `fixture:${relative}\n`);
  }
  git(root, ['init', '--quiet']);
  const brokenSignerPath = writeBrokenSigner(path.join(root, '.git', 'signing'));
  const simulatedGlobalConfig = createSimulatedGlobalGitConfig(brokenSignerPath);
  const signingEnv = gitEnv(simulatedGlobalConfig);
  isolateFixtureRepositorySigning(root, brokenSignerPath);
  git(root, ['config', 'user.name', 'Release Test']);
  git(root, ['config', 'user.email', 'release-test@example.invalid']);
  git(root, ['config', 'core.fileMode', 'true']);
  git(root, ['add', '.'], signingEnv);
  git(root, ['commit', '--quiet', '-m', 'fixture'], signingEnv);
  return root;
}

function deployDashboardFixture(root, deployedRoot) {
  for (const relative of DASHBOARD_RUNTIME_FILES) {
    const destination = path.join(deployedRoot, relative);
    fs.mkdirSync(path.dirname(destination), { recursive: true });
    fs.copyFileSync(path.join(root, 'finance-dashboard', relative), destination);
    fs.chmodSync(
      destination,
      fs.statSync(path.join(root, 'finance-dashboard', relative)).mode & 0o777,
    );
  }
  return deployedRoot;
}

function explicitPublisherToolchainFixture() {
  const contract = JSON.parse(fs.readFileSync(
    path.join(REPOSITORY_ROOT, 'ops/toolchain/eas-cli-runtime-closure.json'),
    'utf8',
  ));
  return {
    package: 'eas-cli',
    version: contract.version,
    integrity: contract.integrity,
    invocation: 'node finance-app/scripts/run-pinned-eas.js',
    runtimeClosureDigest: contract.runtimeClosureDigest,
    packageCount: contract.packageCount,
    fileCount: contract.fileCount,
    platform: contract.platform,
    arch: contract.arch,
    derivationVersion: contract.derivationVersion,
    standaloneInstallCommand: contract.standaloneInstallCommand,
  };
}

function dependencies(root, builtAt = '2026-07-01T00:00:00.000Z') {
  return {
    root,
    clock: () => new Date(builtAt),
    resolvePublisherToolchain: () => explicitPublisherToolchainFixture(),
    resolveAppConfig: ({ variant }) => ({
      version: '1.2.0',
      runtimeVersion: variant === 'free-sideload'
        ? '1.2.0-free-sideload'
        : { policy: 'appVersion' },
      updates: {
        requestHeaders: {
          'expo-channel-name': variant === 'free-sideload' ? 'free-sideload' : 'production',
        },
      },
      ios: { buildNumber: '5' },
    }),
  };
}

function fixtureManifest(root, options = {}, builtAt) {
  return buildManifest({ root, ...options }, dependencies(root, builtAt));
}

function assertUnsignedOtaFixtureEvidence(ota) {
  validateManifestEnvelope(ota);
  validateManifestContent(ota.content);
  assert.equal(ota.contentDigest.value, recalculateContentDigest(ota));
}

function digest(manifest) {
  validateManifestEnvelope(manifest);
  return manifest.contentDigest.value;
}

function verifySignedFile(manifestPath, keyringPath) {
  verifyManifest(JSON.parse(fs.readFileSync(manifestPath, 'utf8')), {
    manifestPath,
    keyringPath,
    env: {},
  });
}

function runCli(root, args, expectedStatus = 0, env = process.env) {
  const signingRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'release-cli-signing-'));
  temporaryDirectories.push(signingRoot);
  const signing = createEphemeralSigningMaterial(signingRoot);
  const result = spawnSync(process.execPath, [SCRIPT, `--root=${root}`, ...args], {
    cwd: root,
    encoding: 'utf8',
    env: { ...env, ...signing.signingEnv },
  });
  assert.equal(result.status, expectedStatus, result.stderr);
  return { ...result, signing };
}

test('fixture repositories isolate inherited commit signing configuration', () => {
  const root = createFixtureRepository();
  const brokenSignerPath = git(root, ['config', '--get', 'gpg.program']);
  const simulatedGlobalConfig = createSimulatedGlobalGitConfig(brokenSignerPath);
  const signingEnv = gitEnv(simulatedGlobalConfig);

  assert.equal(git(root, ['config', '--get', 'commit.gpgsign']), 'false');
  assert.match(brokenSignerPath, /[\\/]\.git[\\/]signing[\\/]broken-gpg-signer\.sh$/);
  assert.throws(
    () => execFileSync(brokenSignerPath, [], { encoding: 'utf8' }),
    /broken signer invoked/,
  );

  write(root, 'signing-isolation.js', 'module.exports = "isolated";\n');
  git(root, ['add', 'signing-isolation.js'], signingEnv);
  assert.doesNotThrow(() => git(root, ['commit', '--quiet', '-m', 'signing isolation'], signingEnv));

  const unisolatedRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'darkfinances-release-signing-control-'));
  temporaryDirectories.push(unisolatedRoot);
  write(unisolatedRoot, '.gitignore', 'node_modules/\n');
  write(unisolatedRoot, 'source.js', 'module.exports = "signing control";\n');
  git(unisolatedRoot, ['init', '--quiet']);
  git(unisolatedRoot, ['config', 'user.name', 'Release Test']);
  git(unisolatedRoot, ['config', 'user.email', 'release-test@example.invalid']);
  git(unisolatedRoot, ['add', '.'], signingEnv);
  assert.throws(
    () => git(unisolatedRoot, ['commit', '-m', 'simulated global signing should fail'], signingEnv),
    /broken signer invoked|gpg|sign|failed/i,
  );
});

test('release manifest includes versioned alignment and contract identity', () => {
  const root = createFixtureRepository();
  const manifest = fixtureManifest(root, { variant: 'full' });
  assert.equal(manifest.kind, 'darkfinances-release');
  assert.equal(manifest.schemaVersion, 2);
  assert.equal(manifest.content.mode, 'source');
  assert.match(manifest.content.lockfile.sha256, /^[a-f0-9]{64}$/);
  assert.equal(manifest.content.actual.dashboardApi, manifest.content.actual.toolsApi);
  assert.equal(manifest.content.actual.serverImage, '26.7.0');
  assert.match(manifest.content.contract.fingerprint, /^[a-f0-9]{16}$/);
  assert.equal(manifest.content.app.variant, 'full');
  assert.equal(manifest.content.app.releaseProfile, 'production');
  assert.equal(contractFingerprint(root), manifest.content.contract.fingerprint);
  assert.equal(verifyManifest(manifest), true);
});

test('manifest construction fails closed on missing or mismatched Actual versions', () => {
  const cases = [
    {
      mutate(root) {
        write(root, 'ops/actual-compose.yml', [
          'services:',
          '  actual:',
          '    image: actualbudget/actual-server:latest',
          '',
        ].join('\n'));
      },
      error: /Actual server image version must be an exact/,
    },
    {
      mutate(root) {
        write(root, 'ops/actual-compose.yml', [
          '# image: actualbudget/actual-server:26.7.0',
          'services:',
          '  actual:',
          '    image: actualbudget/actual-server:latest',
          '',
        ].join('\n'));
      },
      error: /Actual server image version must be an exact/,
    },
    {
      mutate(root) {
        write(root, 'ops/actual-compose.yml', [
          'services:',
          '  actual:',
          '    notes: |',
          '      image: actualbudget/actual-server:26.7.0',
          '    image: actualbudget/actual-server:latest',
          '',
        ].join('\n'));
      },
      error: /Actual server image version must be an exact/,
    },
    {
      mutate(root) {
        write(root, 'finance-dashboard/package.json', '{"dependencies":{}}\n');
      },
      error: /finance-dashboard @actual-app\/api must be an exact/,
    },
    {
      mutate(root) {
        write(root, 'actual-tools/package.json', '{"dependencies":{}}\n');
      },
      error: /actual-tools @actual-app\/api must be an exact/,
    },
    {
      mutate(root) {
        write(root, 'finance-dashboard/package.json', JSON.stringify({
          dependencies: { '@actual-app/api': '26.7.1' },
        }));
      },
      error: /@actual-app\/api mismatch/,
    },
    {
      mutate(root) {
        for (const workspace of ['finance-dashboard', 'actual-tools']) {
          write(root, `${workspace}/package.json`, JSON.stringify({
            dependencies: { '@actual-app/api': '26.7.1' },
          }));
        }
      },
      error: /Actual API\/server mismatch/,
    },
  ];
  for (const { mutate, error } of cases) {
    const root = createFixtureRepository();
    mutate(root);
    assert.throws(() => fixtureManifest(root), error);
  }
});

test('verification rejects tampered Actual alignment even with a recalculated digest', () => {
  const root = createFixtureRepository();
  const manifest = fixtureManifest(root);
  manifest.content.actual.toolsApi = '26.7.1';
  manifest.contentDigest.value = sha256Canonical(manifest.content);
  assert.throws(() => verifyManifest(manifest), /@actual-app\/api mismatch/);
});

test('clean source identity and content digest are stable', () => {
  const root = createFixtureRepository();
  const first = fixtureManifest(root, {}, '2026-07-01T00:00:00.000Z');
  const second = fixtureManifest(root, {}, '2026-07-02T00:00:00.000Z');
  assert.equal(first.content.repository.source.state, 'clean');
  assert.equal(first.content.repository.dirty, false);
  assert.equal(first.content.repository.source.digest, second.content.repository.source.digest);
  assert.notEqual(first.builtAt, second.builtAt);
  assert.equal(digest(first), digest(second));
});

test('tracked source modifications change identity and mark tracked dirty', () => {
  const root = createFixtureRepository();
  const clean = fixtureManifest(root);
  write(root, 'source.js', 'module.exports = "tracked edit";\n');
  const dirty = fixtureManifest(root);
  assert.equal(dirty.content.repository.dirty, true);
  assert.equal(dirty.content.repository.source.state, 'tracked-dirty');
  assert.equal(dirty.content.repository.source.trackedDirty, true);
  assert.equal(dirty.content.repository.source.untrackedSource, false);
  assert.notEqual(clean.content.repository.source.digest, dirty.content.repository.source.digest);
  assert.notEqual(digest(clean), digest(dirty));
});

test('expected source digest rejects release-operation source races', {
  skip: path.sep !== '/',
}, () => {
  const trackedRoot = createFixtureRepository();
  const trackedExpected = buildSourceIdentity({ root: trackedRoot }).source.digest;
  write(trackedRoot, 'source.js', 'changed during build\n');
  assert.throws(() => fixtureManifest(trackedRoot, {
    expectedSourceDigest: trackedExpected,
  }), /source changed during release operation/);

  const untrackedRoot = createFixtureRepository();
  const untrackedExpected = buildSourceIdentity({ root: untrackedRoot }).source.digest;
  write(untrackedRoot, 'new-source.js', 'created during publication\n');
  assert.throws(() => fixtureManifest(untrackedRoot, {
    expectedSourceDigest: untrackedExpected,
  }), /source changed during release operation/);

  const modeRoot = createFixtureRepository();
  const modeExpected = buildSourceIdentity({ root: modeRoot }).source.digest;
  fs.chmodSync(path.join(modeRoot, 'source.js'), 0o755);
  assert.throws(() => fixtureManifest(modeRoot, {
    expectedSourceDigest: modeExpected,
  }), /source changed during release operation/);

  const commitRoot = createFixtureRepository();
  const commitExpected = buildSourceIdentity({ root: commitRoot }).source.digest;
  git(commitRoot, ['commit', '--allow-empty', '--quiet', '-m', 'commit changed during operation']);
  assert.throws(() => fixtureManifest(commitRoot, {
    expectedSourceDigest: commitExpected,
  }), /source changed during release operation/);
});

test('manifest assembly rechecks source after hashing release evidence', () => {
  const root = createFixtureRepository();
  const artifact = write(root, 'build/assembly-race.ipa', 'artifact\n');
  const baseRunner = createGitRunner(root);
  let identityReads = 0;
  const gitRunner = (args, options) => {
    if (args[0] === 'rev-parse' && args.includes('--verify')) {
      identityReads += 1;
      if (identityReads === 2) write(root, 'source.js', 'changed during evidence hashing\n');
    }
    return baseRunner(args, options);
  };
  assert.throws(() => buildManifest({
    root,
    mode: 'ipa',
    artifactPath: artifact,
  }, {
    ...dependencies(root),
    gitRunner,
  }), /source changed while release evidence was being assembled/);
});

test('non-ignored untracked source content changes source identity without leaking its path', () => {
  const root = createFixtureRepository();
  const clean = fixtureManifest(root);
  write(root, 'private-name-not-recorded.js', 'first untracked content\n');
  const first = fixtureManifest(root);
  write(root, 'private-name-not-recorded.js', 'second untracked content\n');
  const second = fixtureManifest(root);
  assert.equal(first.content.repository.source.state, 'untracked-source');
  assert.equal(first.content.repository.source.untrackedSource, true);
  assert.notEqual(clean.content.repository.source.digest, first.content.repository.source.digest);
  assert.notEqual(first.content.repository.source.digest, second.content.repository.source.digest);
  assert.equal(JSON.stringify(first).includes('private-name-not-recorded.js'), false);
});

test('ignored environment and runtime-state files do not enter automatic source identity', () => {
  const root = createFixtureRepository();
  const clean = fixtureManifest(root);
  write(root, '.env', 'SECRET=not-recorded\n');
  write(root, 'runtime-state.json', '{"private":true}\n');
  write(root, 'build/generated.bin', 'ignored build output\n');
  const ignored = fixtureManifest(root);
  assert.equal(ignored.content.repository.source.state, 'clean');
  assert.equal(ignored.content.repository.source.digest, clean.content.repository.source.digest);
  assert.equal(digest(ignored), digest(clean));
});

test('Git listing order does not affect source identity', () => {
  const root = createFixtureRepository();
  write(root, 'zeta/new.js', 'zeta\n');
  write(root, 'alpha/new.js', 'alpha\n');
  const standard = buildSourceIdentity({ root });
  const baseRunner = createGitRunner(root);
  const reorderedRunner = (args, options) => {
    const result = baseRunner(args, options);
    if (args[0] !== 'ls-files' || result.status !== 0) return result;
    const buffer = Buffer.isBuffer(result.stdout)
      ? result.stdout
      : Buffer.from(String(result.stdout), 'utf8');
    const paths = buffer.toString('utf8').split('\0').filter(Boolean).reverse();
    return { ...result, stdout: Buffer.from(`${paths.join('\0')}\0`, 'utf8') };
  };
  const reordered = buildSourceIdentity({ root, gitRunner: reorderedRunner });
  assert.equal(reordered.source.digest, standard.source.digest);
  assert.equal(reordered.source.state, standard.source.state);
});

test('literal backslashes in Git paths are hashed as filename content on POSIX', {
  skip: path.sep !== '/',
}, () => {
  const root = createFixtureRepository();
  write(root, 'literal\\name.js', 'first\n');
  const first = buildSourceIdentity({ root });
  write(root, 'literal\\name.js', 'second\n');
  const second = buildSourceIdentity({ root });
  assert.notEqual(first.source.digest, second.source.digest);
});

test('tracked and untracked executable-bit changes alter source identity', {
  skip: path.sep !== '/',
}, () => {
  const root = createFixtureRepository();
  const tracked = path.join(root, 'source.js');
  fs.chmodSync(tracked, 0o644);
  const trackedNonExecutable = buildSourceIdentity({ root });
  const trackedNonExecutableManifest = fixtureManifest(root);
  git(root, ['config', 'core.fileMode', 'false']);
  fs.chmodSync(tracked, 0o755);
  const trackedExecutable = buildSourceIdentity({ root });
  const trackedExecutableManifest = fixtureManifest(root);
  assert.equal(trackedExecutable.source.state, 'tracked-dirty');
  assert.notEqual(trackedExecutable.source.digest, trackedNonExecutable.source.digest);
  assert.notEqual(digest(trackedExecutableManifest), digest(trackedNonExecutableManifest));

  fs.chmodSync(tracked, 0o644);
  const untracked = write(root, 'untracked-script.sh', '#!/bin/sh\nexit 0\n');
  fs.chmodSync(untracked, 0o644);
  const nonExecutable = buildSourceIdentity({ root });
  const nonExecutableManifest = fixtureManifest(root);
  fs.chmodSync(untracked, 0o755);
  const executable = buildSourceIdentity({ root });
  const executableManifest = fixtureManifest(root);
  assert.equal(nonExecutable.source.state, 'untracked-source');
  assert.notEqual(executable.source.digest, nonExecutable.source.digest);
  assert.notEqual(digest(executableManifest), digest(nonExecutableManifest));
});

test('canonical serialization is stable across object-key order', () => {
  const left = { z: 1, a: { y: true, b: ['x', { q: 2, a: 1 }] } };
  const right = { a: { b: ['x', { a: 1, q: 2 }], y: true }, z: 1 };
  assert.equal(canonicalSerialize(left), canonicalSerialize(right));
});

test('dashboard generation accepts an exact repository/deployment runtime match', () => {
  const root = createFixtureRepository();
  const deployedRoot = path.join(root, 'build', 'dashboard');
  deployDashboardFixture(root, deployedRoot);
  const manifest = fixtureManifest(root, {
    mode: 'dashboard',
    deployedRoot,
  });
  assert.deepEqual(
    manifest.content.deployedFiles.map((entry) => entry.path),
    [...DASHBOARD_RUNTIME_FILES].sort(),
  );
  validateManifestEnvelope(manifest);
});

test('dashboard generation rejects stale deployed source and executable state', {
  skip: path.sep !== '/',
}, () => {
  const root = createFixtureRepository();
  const staleRoot = deployDashboardFixture(root, path.join(root, 'build', 'stale-dashboard'));
  write(staleRoot, 'server.js', 'stale deployed server\n');
  assert.throws(() => fixtureManifest(root, {
    mode: 'dashboard',
    deployedRoot: staleRoot,
  }), /does not match repository source: server\.js/);

  const modeRoot = deployDashboardFixture(root, path.join(root, 'build', 'mode-dashboard'));
  const deployedServer = path.join(modeRoot, 'server.js');
  const sourceExecutable = (fs.statSync(path.join(root, 'finance-dashboard/server.js')).mode & 0o111) !== 0;
  fs.chmodSync(deployedServer, sourceExecutable ? 0o644 : 0o755);
  assert.throws(() => fixtureManifest(root, {
    mode: 'dashboard',
    deployedRoot: modeRoot,
  }), /does not match repository source: server\.js/);
});

test('dashboard generation rejects missing or changed repository runtime source', () => {
  const root = createFixtureRepository();
  const missingRoot = deployDashboardFixture(root, path.join(root, 'build', 'missing-source-dashboard'));
  fs.unlinkSync(path.join(root, 'finance-dashboard/lib/release-files.js'));
  assert.throws(() => fixtureManifest(root, {
    mode: 'dashboard',
    deployedRoot: missingRoot,
  }), /dashboard source verification failed/);

  const changedRoot = createFixtureRepository();
  const deployedRoot = deployDashboardFixture(
    changedRoot,
    path.join(changedRoot, 'build', 'changed-source-dashboard'),
  );
  write(changedRoot, 'finance-dashboard/server.js', 'source changed after deployment\n');
  assert.throws(() => fixtureManifest(changedRoot, {
    mode: 'dashboard',
    deployedRoot,
  }), /does not match repository source: server\.js/);
});

test('a generated dashboard manifest becomes invalid when its deployed server changes', () => {
  const root = createFixtureRepository();
  const deployedRoot = deployDashboardFixture(root, path.join(root, 'build', 'live-dashboard'));
  const manifest = fixtureManifest(root, { mode: 'dashboard', deployedRoot });
  const manifestPath = write(root, 'build/dashboard-release.json', JSON.stringify(manifest));
  const signing = createEphemeralSigningMaterial(root);
  const { writeSignedManifest } = require('./helpers/release-signing-fixtures');
  writeSignedManifest(manifestPath, manifest, signing.signingPath, signing.keyringPath);
  assert.ok(readReleaseIdentity(manifestPath, deployedRoot, {
    keyringPath: signing.keyringPath,
    manifestPath,
  }));
  write(deployedRoot, 'server.js', 'server-v2\n');
  assert.equal(readReleaseIdentity(manifestPath, deployedRoot), null);
});

test('an IPA artifact swap changes the bound artifact and content digest', () => {
  const root = createFixtureRepository();
  const artifact = write(root, 'build/Finances.ipa', 'ipa-v1\n');
  const first = fixtureManifest(root, { mode: 'ipa', artifactPath: artifact });
  write(root, 'build/Finances.ipa', 'ipa-v2\n');
  const second = fixtureManifest(root, { mode: 'ipa', artifactPath: artifact });
  assert.equal(first.content.artifact.file, 'Finances.ipa');
  assert.notEqual(first.content.artifact.sha256, second.content.artifact.sha256);
  assert.notEqual(digest(first), digest(second));
});

test('large artifact evidence is hashed incrementally with bounded reads', () => {
  const root = createFixtureRepository();
  const artifact = write(
    root,
    'build/large.ipa',
    Buffer.alloc((HASH_CHUNK_BYTES * 4) + 17, 0x5a),
  );
  let calls = 0;
  let largestRead = 0;
  const evidence = hashRegularFile(artifact, 'large artifact', {
    readSync(descriptor, buffer, offset, length, position) {
      calls += 1;
      largestRead = Math.max(largestRead, length);
      return fs.readSync(descriptor, buffer, offset, length, position);
    },
  });
  assert.equal(evidence.bytes, (HASH_CHUNK_BYTES * 4) + 17);
  assert.ok(calls > 4);
  assert.ok(largestRead <= HASH_CHUNK_BYTES);
  assert.match(evidence.sha256, /^[a-f0-9]{64}$/);
});

test('artifact hashing rejects atomic path replacement during hashing', () => {
  const root = createFixtureRepository();
  const artifact = write(root, 'build/replaced.ipa', Buffer.alloc(HASH_CHUNK_BYTES * 2, 0x31));
  let replaced = false;
  assert.throws(() => hashRegularFile(artifact, 'replaced artifact', {
    readSync(descriptor, buffer, offset, length, position) {
      if (!replaced) {
        replaced = true;
        fs.renameSync(artifact, `${artifact}.old`);
        fs.writeFileSync(artifact, Buffer.alloc(HASH_CHUNK_BYTES * 2, 0x32));
      }
      return fs.readSync(descriptor, buffer, offset, length, position);
    },
  }), /changed while it was being hashed/);
});

test('OTA IDs are content-bound and full production identity is enforced', () => {
  const root = createFixtureRepository();
  const ota = {
    groupId: 'group-1',
    updates: [{ id: 'update-1', platform: 'ios' }],
    runtimeVersion: '1.2.0',
    channel: 'production',
    branch: 'production',
  };
  const original = digest(fixtureManifest(root, { mode: 'ota', ota }));
  const productionManifest = fixtureManifest(root, { mode: 'ota', ota });
  assert.equal(productionManifest.content.app.releaseProfile, 'production');
  assert.equal(productionManifest.content.ota.environment, 'production');
  const variants = [
    { ...ota, updates: [{ id: 'update-2', platform: 'ios' }] },
    { ...ota, groupId: 'group-2' },
  ];
  for (const changed of variants) {
    assert.notEqual(digest(fixtureManifest(root, { mode: 'ota', ota: changed })), original);
  }
  const runtimeDependencies = dependencies(root);
  runtimeDependencies.resolveAppConfig = () => ({
    version: '1.2.0',
    runtimeVersion: '1.2.1',
    updates: { requestHeaders: { 'expo-channel-name': 'production' } },
    ios: { buildNumber: '5' },
  });
  const changedRuntime = buildManifest({
    root,
    mode: 'ota',
    ota: { ...ota, runtimeVersion: '1.2.1' },
  }, runtimeDependencies);
  assert.notEqual(digest(changedRuntime), original);
  assert.throws(
    () => fixtureManifest(root, { mode: 'ota', ota: { ...ota, runtimeVersion: 'wrong' } }),
    /does not match full app runtime/,
  );
  assert.throws(
    () => fixtureManifest(root, { mode: 'ota', ota: { ...ota, channel: 'preview' } }),
    /OTA channel does not match release profile/,
  );
  assert.throws(
    () => fixtureManifest(root, { mode: 'ota', ota: { ...ota, branch: 'preview' } }),
    /OTA branch does not match release profile/,
  );
  assert.throws(
    () => fixtureManifest(root, {
      mode: 'ota',
      ota: { ...ota, environment: 'preview' },
    }),
    /OTA environment does not match release profile/,
  );
});

test('EAS JSON binds update IDs, group, runtime, channel, and branch', () => {
  const root = createFixtureRepository();
  const result = write(root, 'build/eas-update.json', JSON.stringify([
    {
      id: 'ios-update',
      group: 'update-group',
      runtimeVersion: '1.2.0',
      branch: 'production',
      platform: 'ios',
    },
    {
      id: 'android-update',
      group: 'update-group',
      runtimeVersion: '1.2.0',
      branch: 'production',
      platform: 'android',
    },
  ]));
  const manifest = fixtureManifest(root, {
    mode: 'ota',
    otaResultPath: result,
    otaBranch: 'production',
  });
  assert.equal(manifest.content.ota.groupId, 'update-group');
  assert.equal(manifest.content.ota.runtimeVersion, '1.2.0');
  assert.equal(manifest.content.ota.channel, 'production');
  assert.equal(manifest.content.ota.branch, 'production');
  assert.equal(manifest.content.ota.profile, 'production');
  assert.equal(manifest.content.ota.environment, 'production');
  assert.deepEqual(manifest.content.ota.updates, [
    { id: 'android-update', platform: 'android' },
    { id: 'ios-update', platform: 'ios' },
  ]);
  assert.throws(() => fixtureManifest(root, {
    mode: 'ota',
    otaResultPath: result,
    otaBranch: 'free-sideload',
  }), /does not match requested branch/);
});

test('preview OTA profile derives and enforces preview branch, channel, and environment', () => {
  const root = createFixtureRepository();
  const result = write(root, 'build/preview-eas-update.json', JSON.stringify([{
    id: 'preview-update',
    group: 'preview-group',
    runtimeVersion: '1.2.0',
    branch: 'preview',
    platform: 'ios',
  }]));
  const manifest = fixtureManifest(root, {
    mode: 'ota',
    releaseProfile: 'preview',
    otaResultPath: result,
    otaBranch: 'preview',
  });
  assert.equal(manifest.content.app.releaseProfile, 'preview');
  assert.equal(manifest.content.app.updateChannel, 'production');
  assert.equal(manifest.content.ota.branch, 'preview');
  assert.equal(manifest.content.ota.channel, 'preview');
  assert.equal(manifest.content.ota.environment, 'preview');

  const wrongBranchResult = write(root, 'build/preview-wrong-branch.json', JSON.stringify([{
    id: 'preview-update',
    group: 'preview-group',
    runtimeVersion: '1.2.0',
    branch: 'production',
    platform: 'ios',
  }]));
  assert.throws(() => fixtureManifest(root, {
    mode: 'ota',
    releaseProfile: 'preview',
    otaResultPath: wrongBranchResult,
    otaBranch: 'preview',
  }), /does not match requested branch/);

  assert.throws(() => fixtureManifest(root, {
    mode: 'ota',
    releaseProfile: 'preview',
    ota: {
      updateId: 'preview-update',
      runtimeVersion: '1.2.0',
      channel: 'production',
      branch: 'preview',
    },
  }), /OTA channel does not match release profile/);
  assert.throws(() => fixtureManifest(root, {
    mode: 'ota',
    releaseProfile: 'preview',
    ota: {
      updateId: 'preview-update',
      runtimeVersion: 'wrong',
      channel: 'preview',
      branch: 'preview',
    },
  }), /does not match full app runtime/);

  write(root, 'finance-app/eas.json', JSON.stringify({
    build: {
      production: { channel: 'production', environment: 'production' },
      preview: { channel: 'production', environment: 'preview' },
    },
  }));
  assert.throws(() => fixtureManifest(root, {
    mode: 'ota',
    releaseProfile: 'preview',
    otaResultPath: result,
    otaBranch: 'preview',
  }), /preview must map channel preview and environment preview/);
});

test('free-sideload OTA identity accepts only its isolated runtime, channel, and branch', () => {
  const root = createFixtureRepository();
  const ota = {
    updateId: 'free-update',
    runtimeVersion: '1.2.0-free-sideload',
    channel: 'free-sideload',
    branch: 'free-sideload',
  };
  const manifest = fixtureManifest(root, {
    mode: 'ota',
    variant: 'free-sideload',
    ota,
  });
  assert.equal(manifest.content.app.updateChannel, 'free-sideload');
  assert.equal(manifest.content.app.releaseProfile, 'free-sideload');
  assert.equal(manifest.content.ota.runtimeVersion, '1.2.0-free-sideload');
  assert.equal(manifest.content.ota.environment, 'production');
  const result = write(root, 'build/free-eas-update.json', JSON.stringify([{
    id: 'free-update',
    group: 'free-group',
    runtimeVersion: '1.2.0-free-sideload',
    branch: 'free-sideload',
    platform: 'ios',
  }]));
  const resultManifest = fixtureManifest(root, {
    mode: 'ota',
    variant: 'free-sideload',
    otaResultPath: result,
    otaBranch: 'free-sideload',
  });
  assert.equal(resultManifest.content.ota.branch, 'free-sideload');
  assert.throws(() => fixtureManifest(root, {
    mode: 'ota',
    variant: 'free-sideload',
    ota: { ...ota, runtimeVersion: '1.2.0' },
  }), /does not match free-sideload app runtime/);
  assert.throws(() => fixtureManifest(root, {
    mode: 'ota',
    variant: 'free-sideload',
    ota: { ...ota, channel: 'production' },
  }), /OTA channel does not match release profile/);
  assert.throws(() => fixtureManifest(root, {
    mode: 'ota',
    variant: 'free-sideload',
    ota: { ...ota, branch: 'production' },
  }), /OTA branch does not match release profile/);
});

test('backup manifest and archive changes independently alter the digest', () => {
  const root = createFixtureRepository();
  const backupManifest = write(root, 'build/runtime.tgz.manifest.json', '{"version":1}\n');
  const backupArchive = write(root, 'build/runtime.tgz', 'archive-v1\n');
  const options = {
    mode: 'backup',
    backupManifestPath: backupManifest,
    backupArchivePath: backupArchive,
  };
  const original = fixtureManifest(root, options);
  write(root, 'build/runtime.tgz.manifest.json', '{"version":2}\n');
  const changedManifest = fixtureManifest(root, options);
  write(root, 'build/runtime.tgz', 'archive-v2\n');
  const changedArchive = fixtureManifest(root, options);
  assert.notEqual(digest(original), digest(changedManifest));
  assert.notEqual(digest(changedManifest), digest(changedArchive));
});

test('publisherToolchain runtime closure evidence changes signed OTA digest', () => {
  const root = createFixtureRepository();
  const ota = {
    updateId: 'update-1',
    groupId: '00000000-0000-0000-0000-000000000001',
    runtimeVersion: '1.2.0',
    channel: 'production',
    branch: 'production',
    profile: 'production',
    environment: 'production',
    updates: [{ id: '11111111-1111-1111-1111-111111111111', platform: 'ios' }],
  };
  const base = fixtureManifest(root, { mode: 'ota', ota });
  const tampered = JSON.parse(JSON.stringify(base));
  tampered.content.publisherToolchain.runtimeClosureDigest = 'b'.repeat(64);
  tampered.contentDigest.value = recalculateContentDigest(tampered);
  assert.notEqual(base.contentDigest.value, tampered.contentDigest.value);
  assert.equal(base.content.publisherToolchain.packageCount, explicitPublisherToolchainFixture().packageCount);
});

test('additional coordinated-backup archives are content-addressed', () => {
  const root = createFixtureRepository();
  const backupManifest = write(root, 'build/runtime.tgz.manifest.json', '{}\n');
  const backupArchive = write(root, 'build/runtime.tgz', 'runtime\n');
  const actualArchive = write(root, 'build/actual-data.tgz', 'actual-v1\n');
  const options = {
    mode: 'backup',
    backupManifestPath: backupManifest,
    backupArchivePath: backupArchive,
    backupAdditionalArchivePaths: [actualArchive],
  };
  const first = fixtureManifest(root, options);
  write(root, 'build/actual-data.tgz', 'actual-v2\n');
  const second = fixtureManifest(root, options);
  assert.equal(first.content.backup.additionalArchives[0].file, 'actual-data.tgz');
  assert.notEqual(digest(first), digest(second));
});

test('explicit source archive and dirty patch changes alter the digest', () => {
  const root = createFixtureRepository();
  const sourceArchive = write(root, 'build/source.tar.gz', 'source-v1\n');
  const dirtyPatch = write(root, 'build/dirty.patch', 'patch-v1\n');
  const options = { sourceArchivePath: sourceArchive, dirtyPatchPath: dirtyPatch };
  const original = fixtureManifest(root, options);
  write(root, 'build/source.tar.gz', 'source-v2\n');
  const changedArchive = fixtureManifest(root, options);
  write(root, 'build/dirty.patch', 'patch-v2\n');
  const changedPatch = fixtureManifest(root, options);
  assert.notEqual(digest(original), digest(changedArchive));
  assert.notEqual(digest(changedArchive), digest(changedPatch));
});

test('tampering with a bound field fails verification', () => {
  const root = createFixtureRepository();
  const manifest = fixtureManifest(root);
  const tampered = structuredClone(manifest);
  tampered.content.app.version = '9.9.9';
  assert.notEqual(recalculateContentDigest(tampered), manifest.contentDigest.value);
  assert.throws(() => verifyManifest(tampered), /content digest mismatch/);
});

test('verification rejects semantically invalid content even with a recalculated digest', () => {
  const root = createFixtureRepository();
  const manifest = fixtureManifest(root);
  const invalidVariant = structuredClone(manifest);
  invalidVariant.content.app.variant = 'typo';
  invalidVariant.contentDigest.value = sha256Canonical(invalidVariant.content);
  assert.throws(() => verifyManifest(invalidVariant), /unsupported app variant/);

  const incompatibleMode = structuredClone(manifest);
  incompatibleMode.content.artifact = {
    file: 'injected.ipa',
    sha256: 'a'.repeat(64),
    bytes: 1,
  };
  incompatibleMode.contentDigest.value = sha256Canonical(incompatibleMode.content);
  assert.throws(() => verifyManifest(incompatibleMode), /incompatible ipa evidence/);

  const unknownIdentity = structuredClone(manifest);
  unknownIdentity.content.repository.extra = 'not-allowed';
  unknownIdentity.contentDigest.value = sha256Canonical(unknownIdentity.content);
  assert.throws(() => verifyManifest(unknownIdentity), /unsupported field: extra/);
});

test('release modes fail closed when required evidence is missing', () => {
  const root = createFixtureRepository();
  assert.throws(() => fixtureManifest(root, { mode: 'dashboard' }), /deployed-root/);
  assert.throws(() => fixtureManifest(root, { mode: 'ipa' }), /requires --artifact/);
  assert.throws(() => fixtureManifest(root, { mode: 'ota' }), /requires update\/group ID/);
  assert.throws(() => fixtureManifest(root, { mode: 'backup' }), /requires both backup manifest/);
  assert.throws(() => fixtureManifest(root, {
    mode: 'backup',
    backupManifestPath: path.join(root, 'missing.json'),
  }), /requires both --backup-manifest/);
  assert.throws(() => fixtureManifest(root, { variant: 'typo' }), /unsupported app variant/);
  assert.throws(() => fixtureManifest(root, {
    mode: 'source',
    artifactPath: path.join(root, 'missing.ipa'),
  }), /source mode cannot include ipa release evidence/);
  assert.throws(() => fixtureManifest(root, {
    mode: 'ota',
    ota: {
      updateId: 'update-1',
      runtimeVersion: '1.2.0',
      channel: 'free-sideload',
      branch: 'production',
    },
  }), /OTA channel does not match release profile/);
});

test('free-sideload manifest preserves isolated variant, runtime, channel, and build identity', () => {
  const root = createFixtureRepository();
  const manifest = fixtureManifest(root, { variant: 'free-sideload' });
  assert.equal(manifest.content.app.variant, 'free-sideload');
  assert.equal(manifest.content.app.releaseProfile, 'free-sideload');
  assert.equal(manifest.content.app.version, '1.2.0');
  assert.equal(manifest.content.app.runtimeVersion, '1.2.0-free-sideload');
  assert.equal(manifest.content.app.updateChannel, 'free-sideload');
  assert.equal(manifest.content.app.iosBuildNumber, '5');
});

test('CLI destination and --artifact parsing preserve equals and separate-value forms', () => {
  assert.deepEqual(
    parseCliArgs(['--artifact=/tmp/a.ipa', '/tmp/manifest.json']),
    {
      artifactPath: '/tmp/a.ipa',
      stdout: false,
      destination: '/tmp/manifest.json',
    },
  );
  assert.deepEqual(
    parseCliArgs(['/tmp/manifest.json', '--artifact', '/tmp/a.ipa']),
    {
      artifactPath: '/tmp/a.ipa',
      stdout: false,
      destination: '/tmp/manifest.json',
    },
  );
  assert.throws(
    () => parseCliArgs(['--artifact=a.ipa', '--artifact=b.ipa']),
    /may only be supplied once/,
  );
});

test('CLI validates production, preview, and free-sideload release profiles', () => {
  const root = createFixtureRepository();
  for (const [profile, variant, channel, environment] of [
    ['production', 'full', 'production', 'production'],
    ['preview', 'full', 'preview', 'preview'],
    ['free-sideload', 'free-sideload', 'free-sideload', 'production'],
  ]) {
    const result = runCli(root, [
      `--check-profile=${profile}`,
      `--variant=${variant}`,
    ]);
    const resolved = JSON.parse(result.stdout);
    assert.equal(resolved.name, profile);
    assert.equal(resolved.channel, channel);
    assert.equal(resolved.environment, environment);
  }
});

test('CLI exercises source, dashboard, IPA, OTA, backup, and verification modes in fixtures', () => {
  const root = createFixtureRepository();

  const sourceDigest = runCli(root, ['--source-digest']).stdout.trim();
  assert.match(sourceDigest, /^[a-f0-9]{64}$/);
  const source = JSON.parse(runCli(root, [
    '--mode=source',
    `--expected-source-digest=${sourceDigest}`,
    '--stdout',
  ]).stdout);
  assert.equal(source.content.mode, 'source');
  verifyManifest(source);

  const deployedRoot = path.join(root, 'build', 'deployed');
  deployDashboardFixture(root, deployedRoot);
  const dashboardPath = path.join(root, 'build', 'dashboard-manifest.json');
  const dashboardRun = runCli(root, [
    '--mode=dashboard',
    `--deployed-root=${deployedRoot}`,
    dashboardPath,
  ]);
  const dashboard = JSON.parse(fs.readFileSync(dashboardPath, 'utf8'));
  assert.equal(dashboard.content.deployedFiles.length, DASHBOARD_RUNTIME_FILES.length);
  verifySignedFile(dashboardPath, dashboardRun.signing.keyringPath);

  const artifact = write(root, 'build/cli.ipa', 'ipa\n');
  const ipaDestination = path.join(root, 'build', 'ipa-manifest.json');
  const ipaRun = runCli(root, ['--mode=ipa', `--artifact=${artifact}`, ipaDestination]);
  const ipa = JSON.parse(fs.readFileSync(ipaDestination, 'utf8'));
  assert.equal(ipa.content.mode, 'ipa');
  assert.equal(ipa.content.artifact.file, 'cli.ipa');
  verifySignedFile(ipaDestination, ipaRun.signing.keyringPath);
  assert.equal(fs.existsSync(signaturePathFor(ipaDestination)), true);

  const otaDestination = path.join(root, 'build', 'ota-manifest.json');
  if (CAN_RUN_PUBLISHER_RUNTIME) {
    fs.cpSync(
      path.join(REPOSITORY_ROOT, 'ops/publisher-toolchain/node_modules'),
      path.join(root, 'ops/publisher-toolchain/node_modules'),
      { recursive: true, force: true },
    );
    fs.copyFileSync(
      path.join(REPOSITORY_ROOT, 'ops/publisher-toolchain/package-lock.json'),
      path.join(root, 'ops/publisher-toolchain/package-lock.json'),
    );
    const otaRun = runCli(root, [
      '--mode=ota',
      '--ota-update-id=update-1',
      '--ota-group-id=group-1',
      '--ota-runtime=1.2.0',
      '--ota-channel=production',
      '--ota-branch=production',
      otaDestination,
    ]);
    verifySignedFile(otaDestination, otaRun.signing.keyringPath);
    assert.equal(fs.existsSync(signaturePathFor(otaDestination)), true);
    const ota = JSON.parse(fs.readFileSync(otaDestination, 'utf8'));
    assert.equal(
      ota.content.publisherToolchain.runtimeClosureDigest,
      explicitPublisherToolchainFixture().runtimeClosureDigest,
    );
  } else {
    const ota = fixtureManifest(root, {
      mode: 'ota',
      ota: {
        updateId: 'update-1',
        groupId: 'group-1',
        runtimeVersion: '1.2.0',
        channel: 'production',
        branch: 'production',
      },
    });
    assert.deepEqual(ota.content.publisherToolchain, explicitPublisherToolchainFixture());
    assertUnsignedOtaFixtureEvidence(ota);
  }

  const backupManifest = write(root, 'build/backup.manifest.json', '{}\n');
  const backupArchive = write(root, 'build/backup.tgz', 'archive\n');
  const backupDestination = path.join(root, 'build', 'backup-release.json');
  const backupRun = runCli(root, [
    '--mode=backup',
    `--backup-manifest=${backupManifest}`,
    `--backup-archive=${backupArchive}`,
    backupDestination,
  ]);
  verifySignedFile(backupDestination, backupRun.signing.keyringPath);
  assert.equal(fs.existsSync(signaturePathFor(backupDestination)), true);

  const verified = spawnSync(process.execPath, [
    SCRIPT,
    `--verify=${backupDestination}`,
    `--keyring-path=${backupRun.signing.keyringPath}`,
  ], {
    cwd: root,
    encoding: 'utf8',
  });
  assert.equal(verified.status, 0, verified.stderr);
  assert.match(verified.stdout, /^release-manifest: ok [a-f0-9]{64}\n$/);
});

test('simulated non-bound platform validates unsigned OTA fixture schema and digest without signature', () => {
  const root = createFixtureRepository();
  const ota = fixtureManifest(root, {
    mode: 'ota',
    ota: {
      updateId: 'update-1',
      groupId: 'group-1',
      runtimeVersion: '1.2.0',
      channel: 'production',
      branch: 'production',
    },
  });
  assert.deepEqual(ota.content.publisherToolchain, explicitPublisherToolchainFixture());
  assertUnsignedOtaFixtureEvidence(ota);
  assert.throws(
    () => verifyManifest(ota),
    /manifest path for signature lookup|requires RELEASE_KEYRING_PATH/,
  );
});

test('buildManifest production OTA path requires verified standalone publisher install', () => {
  const root = createFixtureRepository();
  const ota = {
    updateId: 'update-1',
    groupId: 'group-1',
    runtimeVersion: '1.2.0',
    channel: 'production',
    branch: 'production',
  };
  assert.throws(
    () => buildManifest({ root, mode: 'ota', ota }),
    /runtime closure|lock closure|standalone|installed|verifyInstalled|bound platform/i,
  );
});

test('buildManifest production OTA path verifies installed publisher on bound platform', () => {
  if (!CAN_RUN_PUBLISHER_RUNTIME) return;
  const root = createFixtureRepository();
  fs.cpSync(
    path.join(REPOSITORY_ROOT, 'ops/publisher-toolchain/node_modules'),
    path.join(root, 'ops/publisher-toolchain/node_modules'),
    { recursive: true, force: true },
  );
  fs.copyFileSync(
    path.join(REPOSITORY_ROOT, 'ops/publisher-toolchain/package-lock.json'),
    path.join(root, 'ops/publisher-toolchain/package-lock.json'),
  );
  const manifest = buildManifest({
    root,
    mode: 'ota',
    ota: {
      updateId: 'update-1',
      groupId: 'group-1',
      runtimeVersion: '1.2.0',
      channel: 'production',
      branch: 'production',
    },
  });
  assert.equal(
    manifest.content.publisherToolchain.runtimeClosureDigest,
    explicitPublisherToolchainFixture().runtimeClosureDigest,
  );
});

test('CLI direct OTA generation fails without verified standalone install and writes no signed pair', () => {
  const root = createFixtureRepository();
  const otaDestination = path.join(root, 'build', 'ota-direct-fail.json');
  const result = runCli(root, [
    '--mode=ota',
    '--ota-update-id=update-1',
    '--ota-group-id=group-1',
    '--ota-runtime=1.2.0',
    '--ota-channel=production',
    '--ota-branch=production',
    otaDestination,
  ], 1);
  assert.match(result.stderr, /runtime closure|lock closure|standalone|installed|verifyInstalled|bound platform/i);
  assert.equal(fs.existsSync(otaDestination), false);
  assert.equal(fs.existsSync(signaturePathFor(otaDestination)), false);
});

test('CLI and library reject --stdout for production modes before generation', () => {
  const root = createFixtureRepository();
  const deployedRoot = deployDashboardFixture(root, path.join(root, 'build', 'stdout-dashboard'));
  const artifact = write(root, 'build/stdout.ipa', 'ipa\n');
  const backupManifest = write(root, 'build/stdout-backup.manifest.json', '{}\n');
  const backupArchive = write(root, 'build/stdout-backup.tgz', 'archive\n');
  const cases = [
    ['dashboard', ['--mode=dashboard', `--deployed-root=${deployedRoot}`]],
    ['ipa', ['--mode=ipa', `--artifact=${artifact}`]],
    ['ota', [
      '--mode=ota',
      '--ota-update-id=update-1',
      '--ota-group-id=group-1',
      '--ota-runtime=1.2.0',
      '--ota-channel=production',
      '--ota-branch=production',
    ]],
    ['backup', [
      '--mode=backup',
      `--backup-manifest=${backupManifest}`,
      `--backup-archive=${backupArchive}`,
    ]],
  ];
  for (const [mode, args] of cases) {
    assert.throws(
      () => assertStdoutModeAllowed(mode),
      /--stdout is only supported for source mode/,
    );
    const result = runCli(root, [...args, '--stdout'], 1);
    assert.match(result.stderr, /--stdout is only supported for source mode/);
    assert.equal(result.stdout.trim(), '');
    const allowUnsigned = runCli(root, [...args, '--stdout', '--allow-unsigned'], 1);
    assert.match(allowUnsigned.stderr, /--stdout is only supported for source mode/);
    assert.equal(allowUnsigned.stdout.trim(), '');
  }
  const source = runCli(root, ['--mode=source', '--stdout']);
  assert.match(source.stdout, /"mode": "source"/);
  assert.doesNotThrow(() => assertStdoutModeAllowed('source'));
});

test('CLI refuses to write a final manifest when source changes after capture', () => {
  const root = createFixtureRepository();
  const expected = runCli(root, ['--source-digest']).stdout.trim();
  write(root, 'source.js', 'changed while operation ran\n');
  const artifact = write(root, 'build/raced.ipa', 'artifact\n');
  const destination = path.join(root, 'build', 'raced-release.json');
  const result = runCli(root, [
    '--mode=ipa',
    `--expected-source-digest=${expected}`,
    `--artifact=${artifact}`,
    destination,
  ], 1);
  assert.match(result.stderr, /source changed during release operation/);
  assert.equal(fs.existsSync(destination), false);
});

test('CLI rejects ignored arguments and unsafe manifest destinations', () => {
  const root = createFixtureRepository();
  const unsafeParent = path.join(root, 'unsafe-output');
  const preflight = runCli(root, [
    `--check-destination=${path.join(unsafeParent, 'manifest.json')}`,
  ], 1);
  assert.match(preflight.stderr, /must be Git-ignored/);
  assert.equal(fs.existsSync(unsafeParent), false);
  const safeParent = path.join(root, 'build', 'preflight-output');
  const safePreflight = runCli(root, [
    `--check-destination=${path.join(safeParent, 'manifest.json')}`,
  ]);
  assert.match(safePreflight.stdout, /destination ok/);
  assert.equal(fs.existsSync(safeParent), false);

  const trackedDestination = runCli(root, ['--mode=source', 'source.js'], 1);
  assert.match(trackedDestination.stderr, /must not overwrite a tracked source file/);
  const unignoredDestination = runCli(root, ['--mode=source', 'new-manifest.json'], 1);
  assert.match(unignoredDestination.stderr, /must be Git-ignored/);

  const forceAdded = write(root, 'build/force-added.json', '{}\n');
  git(root, ['add', '--force', 'build/force-added.json']);
  git(root, ['commit', '--quiet', '-m', 'force-added ignored fixture']);
  const forceAddedDestination = runCli(root, ['--mode=source', forceAdded], 1);
  assert.match(forceAddedDestination.stderr, /must not overwrite a tracked source file/);

  const deployedRoot = path.join(root, 'build', 'destination-safety');
  deployDashboardFixture(root, deployedRoot);
  const deployedDestination = runCli(root, [
    '--mode=dashboard',
    `--deployed-root=${deployedRoot}`,
    path.join(deployedRoot, 'server.js'),
  ], 1);
  assert.match(deployedDestination.stderr, /must not overwrite a bound deployed file/);

  const stdoutDestination = runCli(root, [
    '--stdout',
    path.join(root, 'build', 'unused.json'),
  ], 1);
  assert.match(stdoutDestination.stderr, /--stdout cannot be combined/);

  const manifestPath = write(root, 'build/valid.json', '{}\n');
  runCli(root, ['--mode=source', '--allow-unsigned', manifestPath]);
  const verifyConflict = spawnSync(process.execPath, [
    SCRIPT,
    `--verify=${manifestPath}`,
    '--deployed-file=server.js',
  ], { cwd: root, encoding: 'utf8' });
  assert.equal(verifyConflict.status, 1);
  assert.match(verifyConflict.stderr, /--verify cannot be combined/);

  const target = write(root, 'build/existing.json', '{}\n');
  const link = path.join(root, 'build/destination-link.json');
  fs.symlinkSync(target, link);
  const symlinkDestination = runCli(root, ['--mode=source', link], 1);
  assert.match(symlinkDestination.stderr, /destination must not be a symbolic link/);
});

test('missing, duplicate, traversing, and symbolic-link evidence fails clearly', () => {
  const root = createFixtureRepository();
  assert.throws(
    () => fixtureManifest(root, { mode: 'ipa', artifactPath: path.join(root, 'missing.ipa') }),
    /artifact not found/,
  );
  const deployedRoot = path.join(root, 'build', 'deployed-safety');
  write(deployedRoot, 'server.js', 'server\n');
  assert.throws(
    () => collectDeployedFiles(deployedRoot, ['../source.js']),
    /normalized relative path/,
  );
  assert.throws(
    () => collectDeployedFiles(deployedRoot, ['server.js', 'server.js']),
    /collide after normalization/,
  );
  const target = write(root, 'build/real.ipa', 'ipa\n');
  const link = path.join(root, 'build/link.ipa');
  fs.symlinkSync(target, link);
  assert.throws(() => fixtureManifest(root, { mode: 'ipa', artifactPath: link }), /symbolic link/);
});

test('generic options cannot overwrite core manifest identity fields', () => {
  const root = createFixtureRepository();
  assert.throws(() => buildManifest({
    root,
    repository: { commit: 'attacker-controlled' },
  }, dependencies(root)), /unsupported field: repository/);
});

test('IPA and OTA callers capture source before operations and assert it afterward', () => {
  const callers = [
    ['finance-app/scripts/ios-build.sh', 'npx expo prebuild'],
    ['finance-app/scripts/ios-sideload.sh', 'npx expo prebuild'],
    ['finance-app/scripts/ota-publish.sh', 'node "$ROOT/scripts/run-pinned-eas.js" update'],
  ];
  for (const [relative, operation] of callers) {
    const source = fs.readFileSync(path.join(REPOSITORY_ROOT, relative), 'utf8');
    assert.ok(source.indexOf('--source-digest') < source.lastIndexOf(operation), relative);
    assert.match(source, /--expected-source-digest=/, relative);
  }
});

test('OTA caller supports validated stable production, preview, and free-sideload targets', () => {
  const source = fs.readFileSync(
    path.join(REPOSITORY_ROOT, 'finance-app/scripts/ota-publish.sh'),
    'utf8',
  );
  assert.match(source, /--branch "\$BRANCH"/);
  assert.doesNotMatch(source, /provenance-/);
  assert.doesNotMatch(source, /channel:edit/);
  assert.match(source, /production\)/);
  assert.match(source, /preview\)/);
  assert.match(source, /free-sideload\)/);
  assert.match(source, /--check-profile="\$BRANCH"/);
  assert.match(source, /--profile="\$BRANCH"/);
  assert.ok(source.indexOf('--check-destination=') < source.indexOf('rm -f "$manifest_path"'));
});

function listFiles(root, relative = '') {
  const directory = path.join(root, relative);
  return fs.readdirSync(directory, { withFileTypes: true }).flatMap((entry) => {
    const child = relative ? `${relative}/${entry.name}` : entry.name;
    return entry.isDirectory() ? listFiles(root, child) : [child];
  });
}

test('dashboard runtime allowlist exactly covers production modules and browser assets', () => {
  const dashboard = path.join(REPOSITORY_ROOT, 'finance-dashboard');
  const expected = [
    'server.js',
    'dataModule.js',
    'demoData.js',
    'package.json',
    'package-lock.json',
    ...listFiles(path.join(dashboard, 'lib'))
      .filter((relative) => relative.endsWith('.js'))
      .map((relative) => `lib/${relative}`),
    ...listFiles(path.join(dashboard, 'public'))
      .map((relative) => `public/${relative}`),
  ].sort();
  assert.deepEqual([...DASHBOARD_RUNTIME_FILES].sort(), expected);
  for (const relative of DASHBOARD_RUNTIME_FILES) {
    assert.equal(fs.statSync(path.join(dashboard, relative)).isFile(), true, relative);
  }
});

test('CLI verify rejects symlink and oversized release manifests', {
  skip: process.platform === 'win32' ? 'POSIX symlink semantics' : false,
}, () => {
  const root = createFixtureRepository();
  const signing = createEphemeralSigningMaterial(root);
  const bundleManifestPath = write(root, 'bundle.manifest.json', '{"artifact":{"id":"abc"}}\n');
  const bundleArchivePath = write(root, 'bundle.tgz', 'bundle\n');
  const manifestPath = path.join(root, 'build', 'verify-target.json');
  const { writeSignedReleaseEvidence } = require('./helpers/release-signing-fixtures');
  writeSignedReleaseEvidence(manifestPath, bundleManifestPath, bundleArchivePath, signing);

  const symlinkPath = path.join(root, 'build', 'linked-verify.json');
  fs.symlinkSync(manifestPath, symlinkPath);
  const symlinkVerify = spawnSync(process.execPath, [SCRIPT, `--verify=${symlinkPath}`], {
    cwd: root,
    encoding: 'utf8',
    env: { ...process.env, ...signing.signingEnv },
  });
  assert.equal(symlinkVerify.status, 1);
  assert.match(symlinkVerify.stderr, /symbolic link/);

  fs.writeFileSync(manifestPath, Buffer.alloc(4 * 1024 * 1024 + 1, 0x7b), { mode: 0o600 });
  const oversizeVerify = spawnSync(process.execPath, [SCRIPT, `--verify=${manifestPath}`], {
    cwd: root,
    encoding: 'utf8',
    env: { ...process.env, ...signing.signingEnv },
  });
  assert.equal(oversizeVerify.status, 1);
  assert.match(oversizeVerify.stderr, /size is out of bounds/);
});
