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
        if (npmBootstrapCommands.has(step) || /^npm (ci|install)\b/.test(step)) {
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

test('ensure-declared-npm installs when active npm differs', () => {
  const { ensureDeclaredNpm } = require(path.join(repositoryRoot, 'scripts/ensure-declared-npm.js'));
  const calls = [];

  const result = ensureDeclaredNpm({
    declaredVersion: '10.9.2',
    runCommand: (command, args) => {
      calls.push([command, args]);
      if (command === 'npm' && args[0] === '--version') {
        return { status: 0, stdout: calls.length === 1 ? '11.12.1\n' : '10.9.2\n' };
      }
      if (command === 'npm' && args[0] === 'install') {
        return { status: 0, stdout: '', stderr: '' };
      }
      return { status: 1, stdout: '', stderr: 'unexpected command' };
    },
  });

  assert.equal(result.changed, true);
  assert.deepEqual(calls[1], ['npm', ['install', '-g', 'npm@10.9.2']]);
});

test('ensure-declared-npm is idempotent when active npm already matches', () => {
  const { ensureDeclaredNpm } = require(path.join(repositoryRoot, 'scripts/ensure-declared-npm.js'));
  const calls = [];

  const result = ensureDeclaredNpm({
    declaredVersion: '10.9.2',
    runCommand: (command, args) => {
      calls.push([command, args]);
      return { status: 0, stdout: '10.9.2\n' };
    },
  });

  assert.equal(result.changed, false);
  assert.deepEqual(calls, [['npm', ['--version']]]);
});

test('ensure-declared-npm uses parsed packageManager version for global install target', () => {
  const { ensureDeclaredNpm } = require(path.join(repositoryRoot, 'scripts/ensure-declared-npm.js'));
  const calls = [];
  let versionChecks = 0;

  ensureDeclaredNpm({
    declaredVersion: '10.9.2',
    runCommand: (command, args) => {
      calls.push([command, args]);
      if (command === 'npm' && args[0] === '--version') {
        versionChecks += 1;
        return { status: 0, stdout: versionChecks === 1 ? '11.0.0\n' : '10.9.2\n' };
      }
      return { status: 0, stdout: '', stderr: '' };
    },
  });

  assert.deepEqual(calls.find(([, args]) => args[0] === 'install'), ['npm', ['install', '-g', 'npm@10.9.2']]);
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
    'ci.yml',
    'shutdown-stress.yml',
  ]);

  const paths = collectWorkflowNpmPaths();
  assert.deepEqual(
    paths.map((entry) => `${entry.workflow}:${entry.job}:${entry.step}`).sort(),
    [
      'ci.yml:lockfile-repro:node scripts/check-lockfile-repro.js',
      'ci.yml:verify:npm ci',
      'shutdown-stress.yml:bounded-stress:npm ci',
    ],
  );
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
