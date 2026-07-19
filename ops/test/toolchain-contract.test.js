'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const os = require('os');
const path = require('path');
const { spawnSync } = require('child_process');

const repositoryRoot = path.resolve(__dirname, '..', '..');

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

test('packageManager parser reads declared npm version without hardcoding', () => {
  const { readDeclaredNpmVersion } = require(path.join(repositoryRoot, 'scripts/package-manager.js'));
  assert.equal(readDeclaredNpmVersion(repositoryRoot), '10.9.2');
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

test('ensure-declared-npm installs when active npm differs', (t) => {
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

test('.nvmrc pins an exact Node 24 patch release', () => {
  const nvmrc = fs.readFileSync(path.join(repositoryRoot, '.nvmrc'), 'utf8').trim();
  assert.match(nvmrc, /^24\.\d+\.\d+$/);
});

test('CI verify and lockfile-repro enforce declared npm before npm ci', () => {
  const workflow = fs.readFileSync(path.join(repositoryRoot, '.github/workflows/ci.yml'), 'utf8');
  assert.match(workflow, /verify:[\s\S]*?- run: node scripts\/ensure-declared-npm\.js[\s\S]*?- run: npm ci/);
  assert.match(workflow, /lockfile-repro:[\s\S]*?- run: node scripts\/ensure-declared-npm\.js[\s\S]*?- run: node scripts\/check-lockfile-repro\.js/);
});

test('CI avoids duplicate feature-branch push runs while keeping pull_request and main push', () => {
  const workflow = fs.readFileSync(path.join(repositoryRoot, '.github/workflows/ci.yml'), 'utf8');
  assert.match(workflow, /pull_request:/);
  assert.match(workflow, /branches:\s*\n\s+- main/);
  assert.doesNotMatch(workflow, /push:\s*\n\s+branches:\s*\n\s+-\s+\*/);
});
