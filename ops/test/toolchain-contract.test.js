'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const os = require('os');
const path = require('path');
const { spawnSync } = require('child_process');

const repositoryRoot = path.resolve(__dirname, '..', '..');
const workflowsDir = path.join(repositoryRoot, '.github/workflows');
const ensureDeclaredNpmStep = 'node scripts/ensure-declared-npm.js';
const npmBootstrapCommands = new Set([
  'npm ci',
  'npm install',
  'node scripts/check-lockfile-repro.js',
]);

function fixture(t) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'darkfinances-toolchain-'));
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  return root;
}

function copyScript(root, name) {
  const destination = path.join(root, 'scripts', name);
  fs.mkdirSync(path.dirname(destination), { recursive: true });
  fs.copyFileSync(path.join(repositoryRoot, 'scripts', name), destination);
}

function run(root, script, env = {}) {
  return spawnSync(process.execPath, [path.join(root, 'scripts', script)], {
    cwd: root,
    encoding: 'utf8',
    env: { ...process.env, ...env },
  });
}

function listWorkflowFiles() {
  return fs.readdirSync(workflowsDir)
    .filter((name) => name.endsWith('.yml') || name.endsWith('.yaml'))
    .map((name) => path.join(workflowsDir, name))
    .sort();
}

function parseWorkflowJobs(content) {
  const jobsMatch = content.match(/^jobs:\n([\s\S]*)$/m);
  if (!jobsMatch) return [];

  const jobs = [];
  let current = null;
  for (const line of jobsMatch[1].split('\n')) {
    const jobMatch = line.match(/^  ([a-z0-9_-]+):\s*$/);
    if (jobMatch) {
      if (current) jobs.push(current);
      current = { name: jobMatch[1], lines: [] };
      continue;
    }
    if (current) current.lines.push(line);
  }
  if (current) jobs.push(current);
  return jobs;
}

function jobRunSteps(job) {
  return job.lines
    .filter((line) => /^\s*- run:/.test(line))
    .map((line) => line.replace(/^\s*- run:\s*/, '').trim());
}

function collectWorkflowNpmPaths() {
  const paths = [];
  for (const workflowPath of listWorkflowFiles()) {
    const workflowName = path.basename(workflowPath);
    const jobs = parseWorkflowJobs(fs.readFileSync(workflowPath, 'utf8'));
    for (const job of jobs) {
      const steps = jobRunSteps(job);
      for (const [index, step] of steps.entries()) {
        if (npmBootstrapCommands.has(step) || /^npm (ci|install)\b/.test(step) || /^npm --prefix finance-app ci --workspaces=false$/.test(step) || /^npm --prefix ops\/publisher-toolchain ci --workspaces=false --ignore-scripts$/.test(step)) {
          paths.push({
            workflow: workflowName,
            job: job.name,
            step,
            index,
            steps,
          });
        }
      }
    }
  }
  return paths;
}

test('packageManager parser reads declared npm version without hardcoding', () => {
  const { readDeclaredNpmVersion } = require(path.join(repositoryRoot, 'scripts/package-manager.js'));
  assert.equal(readDeclaredNpmVersion(repositoryRoot), '10.9.2');
});

test('packageManager parser rejects malformed values', () => {
  const { parsePackageManager } = require(path.join(repositoryRoot, 'scripts/package-manager.js'));
  assert.throws(() => parsePackageManager(''), /non-empty string/);
  assert.throws(() => parsePackageManager('npm'), /unsupported format/);
  assert.throws(() => parsePackageManager('not-valid'), /unsupported format/);
  assert.throws(() => parsePackageManager('npm@10'), /unsupported format/);
  assert.equal(parsePackageManager('npm@10.9.2').version, '10.9.2');
  assert.equal(parsePackageManager('npm@10.9.2+sha512.abcd').version, '10.9.2');
  assert.equal(parsePackageManager('yarn@1.22.0').name, 'yarn');
});

test('readDeclaredNpmVersion rejects non-npm packageManager tools', (t) => {
  const root = fixture(t);
  fs.writeFileSync(path.join(root, 'package.json'), JSON.stringify({
    name: 'gate-fixture',
    version: '1.0.0',
    packageManager: 'pnpm@9.0.0',
  }, null, 2));
  const { readDeclaredNpmVersion } = require(path.join(repositoryRoot, 'scripts/package-manager.js'));
  assert.throws(() => readDeclaredNpmVersion(root), /unsupported packageManager tool: pnpm/);
});

test('check-toolchain passes when node and npm match declared packageManager', () => {
  const { checkToolchain } = require(path.join(repositoryRoot, 'scripts/check-toolchain.js'));
  const { readDeclaredNpmVersion } = require(path.join(repositoryRoot, 'scripts/package-manager.js'));
  const declared = readDeclaredNpmVersion(repositoryRoot);

  assert.doesNotThrow(() => checkToolchain({
    rootDir: repositoryRoot,
    nodeVersion: process.versions.node,
    npmVersion: declared,
  }));
});

test('check-toolchain fails when npm drifts from packageManager', (t) => {
  const root = fixture(t);
  copyScript(root, 'package-manager.js');
  copyScript(root, 'check-toolchain.js');
  fs.writeFileSync(path.join(root, 'package.json'), JSON.stringify({
    name: 'gate-fixture',
    version: '1.0.0',
    packageManager: 'npm@10.9.2',
    engines: { node: '>=24' },
  }, null, 2));

  const result = run(root, 'check-toolchain.js', { npm_config_user_agent: 'npm/11.12.1 node/v24.0.0' });

  assert.notEqual(result.status, 0);
  assert.match(result.stderr, /npm@10\.9\.2 required/);
  assert.match(result.stderr, /npm@11\.12\.1/);
});

test('ensure-declared-npm script installs from verified offline tarball contract', () => {
  const source = fs.readFileSync(path.join(repositoryRoot, 'scripts/ensure-declared-npm.js'), 'utf8');
  assert.match(source, /npm-bootstrap\.json/);
  assert.match(source, /verifySri/);
  assert.match(source, /verifySha256/);
  assert.match(source, /'--offline'/);
  assert.doesNotMatch(source, /install', '-g', `npm@\$\{declaredVersion\}`/);
  assert.doesNotMatch(source, /install', '-g', 'npm@/);
});

test('ensure-declared-npm is idempotent when active npm already matches', async () => {
  const { ensureDeclaredNpm, readContract } = require(path.join(repositoryRoot, 'scripts/ensure-declared-npm.js'));
  const contract = readContract(path.join(repositoryRoot, 'ops/toolchain/npm-bootstrap.json'));
  const calls = [];
  const result = await ensureDeclaredNpm({
    declaredVersion: '10.9.2',
    contract,
    runCommand: (command, args) => {
      calls.push([command, args]);
      return { status: 0, stdout: '10.9.2\n' };
    },
  });
  assert.equal(result.changed, false);
  assert.deepEqual(calls, [['npm', ['--version']]]);
});

test('npm bootstrap contract matches declared packageManager version', () => {
  const { readDeclaredNpmVersion } = require(path.join(repositoryRoot, 'scripts/package-manager.js'));
  const { readContract } = require(path.join(repositoryRoot, 'scripts/ensure-declared-npm.js'));
  const contract = readContract(path.join(repositoryRoot, 'ops/toolchain/npm-bootstrap.json'));
  assert.equal(contract.version, readDeclaredNpmVersion(repositoryRoot));
});

test('.nvmrc pins an exact Node 24 patch release', () => {
  const nvmrc = fs.readFileSync(path.join(repositoryRoot, '.nvmrc'), 'utf8').trim();
  assert.match(nvmrc, /^24\.\d+\.\d+$/);
});

test('every repository workflow npm bootstrap path runs declared npm enforcement first', () => {
  const paths = collectWorkflowNpmPaths();
  assert.ok(paths.length > 0, 'expected at least one workflow npm bootstrap path');

  for (const entry of paths) {
    const ensureIndex = entry.steps.indexOf(ensureDeclaredNpmStep);
    assert.ok(
      ensureIndex >= 0 && ensureIndex < entry.index,
      `${entry.workflow} job ${entry.job} runs "${entry.step}" before ${ensureDeclaredNpmStep}`,
    );
  }
});

test('repository workflows using npm are fully enumerated for bootstrap enforcement', () => {
  const workflowFiles = listWorkflowFiles();
  assert.deepEqual(workflowFiles.map((file) => path.basename(file)).sort(), [
    'android-compile-smoke.yml',
    'ci.yml',
    'ios-pr-smoke.yml',
    'maestro-full-suite.yml',
    'shutdown-stress.yml',
  ]);

  const paths = collectWorkflowNpmPaths();
  const actual = paths.map((entry) => `${entry.workflow}:${entry.job}:${entry.step}`).sort();
  assert.ok(actual.includes('ci.yml:install-lifecycle:npm ci'));
  assert.ok(actual.includes('ci.yml:verify:npm ci'));
  assert.ok(actual.includes('ci.yml:lockfile-repro:node scripts/check-lockfile-repro.js'));
  assert.ok(actual.includes('shutdown-stress.yml:bounded-stress:npm ci'));
  assert.ok(actual.includes('ios-pr-smoke.yml:ios-simulator-maestro:npm ci'));
  assert.ok(actual.includes('android-compile-smoke.yml:android-assemble-debug:npm ci'));
  assert.ok(actual.includes('maestro-full-suite.yml:maestro-ios:npm ci'));
  assert.ok(actual.includes('ci.yml:app-install-lifecycle:npm --prefix finance-app ci --workspaces=false'));
  assert.ok(actual.includes('ci.yml:publisher-closure:npm --prefix ops/publisher-toolchain ci --workspaces=false --ignore-scripts'));
});

test('iOS workflows pin an Expo SDK 56 compatible Xcode toolchain', () => {
  for (const [workflowName, jobName] of [
    ['ios-pr-smoke.yml', 'ios-simulator-maestro'],
    ['maestro-full-suite.yml', 'maestro-ios'],
  ]) {
    const workflow = fs.readFileSync(path.join(workflowsDir, workflowName), 'utf8');
    const job = parseWorkflowJobs(workflow).find((candidate) => candidate.name === jobName);
    assert.ok(job, `expected ${workflowName} job ${jobName}`);
    const jobText = job.lines.join('\n');
    assert.match(jobText, /runs-on:\s*macos-26/);
    assert.doesNotMatch(jobText, /runs-on:\s*macos-15/);
    assert.match(
      jobText,
      /DEVELOPER_DIR:\s*\/Applications\/Xcode_26\.4\.1\.app\/Contents\/Developer/,
    );
    assert.ok(jobText.includes("expected=$'Xcode 26.4.1\\nBuild version 17E202'"));
    assert.ok(jobText.includes('Apple Swift version 6.3'));
    const verifyIndex = jobText.indexOf('- name: Verify pinned Xcode');
    const npmIndex = jobText.indexOf('node scripts/ensure-declared-npm.js');
    assert.ok(verifyIndex >= 0 && verifyIndex < npmIndex);
  }
});

test('app-install-lifecycle job runs declared npm bootstrap before standalone finance-app ci', () => {
  const workflow = fs.readFileSync(path.join(workflowsDir, 'ci.yml'), 'utf8');
  const jobs = parseWorkflowJobs(workflow);
  const appLifecycle = jobs.find((job) => job.name === 'app-install-lifecycle');
  assert.ok(appLifecycle, 'expected ci.yml app-install-lifecycle job');
  const steps = jobRunSteps(appLifecycle);
  const ensureIndex = steps.indexOf('node scripts/ensure-declared-npm.js');
  const standaloneIndex = steps.indexOf('npm --prefix finance-app ci --workspaces=false');
  assert.ok(ensureIndex >= 0 && ensureIndex < standaloneIndex);
});

test('CI install-lifecycle job runs full npm ci then check:install-lifecycle', () => {
  const workflow = fs.readFileSync(path.join(workflowsDir, 'ci.yml'), 'utf8');
  const jobs = parseWorkflowJobs(workflow);
  const installLifecycle = jobs.find((job) => job.name === 'install-lifecycle');
  assert.ok(installLifecycle, 'expected ci.yml install-lifecycle job');
  const steps = jobRunSteps(installLifecycle);
  const ensureIndex = steps.indexOf('node scripts/ensure-declared-npm.js');
  const ciIndex = steps.indexOf('npm ci');
  const lifecycleIndex = steps.indexOf('npm run check:install-lifecycle');
  assert.ok(ensureIndex >= 0 && ensureIndex < ciIndex);
  assert.ok(lifecycleIndex > ciIndex);
  assert.ok(!steps.some((step) => /^npm ci\b/.test(step) && step.includes('--ignore-scripts')));
});

test('CI app-install-lifecycle job uses standalone finance-app lock install', () => {
  const workflow = fs.readFileSync(path.join(workflowsDir, 'ci.yml'), 'utf8');
  const jobs = parseWorkflowJobs(workflow);
  const appLifecycle = jobs.find((job) => job.name === 'app-install-lifecycle');
  assert.ok(appLifecycle, 'expected ci.yml app-install-lifecycle job');
  const steps = jobRunSteps(appLifecycle);
  assert.ok(steps.includes('npm --prefix finance-app ci --workspaces=false'));
  assert.ok(steps.includes('npm run check:app-install-lifecycle'));
  const standaloneIndex = steps.indexOf('npm --prefix finance-app ci --workspaces=false');
  const checkIndex = steps.indexOf('npm run check:app-install-lifecycle');
  assert.ok(checkIndex > standaloneIndex);
});

test('CI publisher-closure job verifies installed-byte runtime closure on macos-15 arm64', () => {
  const workflow = fs.readFileSync(path.join(workflowsDir, 'ci.yml'), 'utf8');
  const jobs = parseWorkflowJobs(workflow);
  const publisher = jobs.find((job) => job.name === 'publisher-closure');
  assert.ok(publisher, 'expected ci.yml publisher-closure job');
  const publisherText = publisher.lines.join('\n');
  assert.match(publisherText, /runs-on:\s*macos-15/);
  assert.match(publisherText, /timeout-minutes:\s*30/);
  assert.match(publisherText, /contents:\s*read/);
  const steps = jobRunSteps(publisher);
  const ensureIndex = steps.indexOf('node scripts/ensure-declared-npm.js');
  const standaloneIndex = steps.indexOf('npm --prefix ops/publisher-toolchain ci --workspaces=false --ignore-scripts');
  const verifyIndex = steps.indexOf('node scripts/check-publisher-closure.js');
  const versionIndex = steps.indexOf('node finance-app/scripts/run-pinned-eas.js --version');
  assert.ok(ensureIndex >= 0 && ensureIndex < standaloneIndex);
  const upstreamIndex = publisherText.indexOf('npm run check:action-pins:upstream');
  const vulnerabilityIndex = publisherText.indexOf('npm run check:vulnerabilities');
  const standaloneTextIndex = publisherText.indexOf('npm --prefix ops/publisher-toolchain ci --workspaces=false --ignore-scripts');
  assert.ok(upstreamIndex >= 0 && upstreamIndex < vulnerabilityIndex);
  assert.ok(vulnerabilityIndex < standaloneTextIndex);
  assert.ok(verifyIndex > standaloneIndex);
  assert.ok(versionIndex > verifyIndex);
  for (const forbidden of [
    'npm run ota:publish',
    'ota-publish.sh',
    'eas update',
    'release-manifest.js --mode=ota',
    'npm run release',
  ]) {
    assert.doesNotMatch(workflow, new RegExp(forbidden.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')));
  }
});

test('check-publisher-closure validates digest packageCount and fileCount against contract', () => {
  const source = fs.readFileSync(path.join(repositoryRoot, 'scripts/check-publisher-closure.js'), 'utf8');
  assert.match(source, /verifyPublisherToolchain\(root, \{ verifyInstalled: true \}\)/);
  assert.match(source, /runtimeClosureDigest/);
  assert.match(source, /packageCount/);
  assert.match(source, /fileCount/);
});

test('CI verify job runs upstream action pin verification without npm cache', () => {
  const workflow = fs.readFileSync(path.join(workflowsDir, 'ci.yml'), 'utf8');
  assert.match(workflow, /check-github-action-pins\.js --verify-upstream/);
  assert.doesNotMatch(workflow, /cache:\s*npm/);
});

test('root check script includes action pin and install lifecycle gates', () => {
  const pkg = JSON.parse(fs.readFileSync(path.join(repositoryRoot, 'package.json'), 'utf8'));
  assert.match(pkg.scripts.check, /check:action-pins/);
  assert.match(pkg.scripts.check, /check:install-lifecycle/);
  assert.match(pkg.scripts['check:install-lifecycle'], /check-install-lifecycle\.js/);
  assert.doesNotMatch(pkg.scripts['check:install-lifecycle'], /check-app-install-lifecycle\.js/);
  assert.match(pkg.scripts['check:app-install-lifecycle'], /check-app-install-lifecycle\.js/);
  assert.doesNotMatch(pkg.scripts['check:app'], /check-app-install-lifecycle\.js/);
});

test('CI verify job runs check:vulnerabilities after npm ci', () => {
  const workflow = fs.readFileSync(path.join(workflowsDir, 'ci.yml'), 'utf8');
  const jobs = parseWorkflowJobs(workflow);
  const verify = jobs.find((job) => job.name === 'verify');
  assert.ok(verify, 'expected ci.yml verify job');
  const steps = jobRunSteps(verify);
  const ciIndex = steps.indexOf('npm ci');
  const vulnIndex = steps.indexOf('npm run check:vulnerabilities');
  assert.ok(ciIndex >= 0, 'verify job must run npm ci');
  assert.ok(vulnIndex >= 0, 'verify job must run check:vulnerabilities');
  assert.ok(vulnIndex > ciIndex, 'check:vulnerabilities must run after npm ci');
});

test('CI avoids duplicate feature-branch push runs while keeping pull_request and main push', () => {
  const workflow = fs.readFileSync(path.join(workflowsDir, 'ci.yml'), 'utf8');
  assert.match(workflow, /pull_request:/);
  assert.match(workflow, /branches:\s*\n\s+- main/);
  assert.doesNotMatch(workflow, /push:\s*\n\s+branches:\s*\n\s+-\s+\*/);
});

test('CI concurrency groups cancel per pull request or ref, not across unrelated PRs', () => {
  const workflow = fs.readFileSync(path.join(workflowsDir, 'ci.yml'), 'utf8');
  assert.match(
    workflow,
    /group:\s*ci-\$\{\{\s*github\.event\.pull_request\.number\s*\|\|\s*github\.ref\s*\}\}/,
  );
  assert.doesNotMatch(workflow, /group:\s*ci-\$\{\{\s*github\.ref\s*\}\}/);
});
