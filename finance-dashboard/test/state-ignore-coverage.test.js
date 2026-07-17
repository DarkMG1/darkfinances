const test = require('node:test');
const assert = require('node:assert/strict');
const { spawnSync } = require('node:child_process');
const fs = require('fs');
const os = require('os');
const path = require('path');
const { STATE_REGISTRY } = require('../lib/state-registry');

const dashboardRoot = path.resolve(__dirname, '..');
const atomicPid = '4242';
const atomicRandom = 'a1b2c3d4e5f6';

function runGit(cwd, args) {
  const result = spawnSync('git', args, { cwd, encoding: 'utf8' });
  if (result.error) throw result.error;
  assert.notEqual(result.status, null, `git ${args.join(' ')} was terminated by a signal`);
  return result;
}

function temporaryGitRepo(t) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'darkfinances-gitignore-'));
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }));

  const init = runGit(dir, ['init', '--quiet']);
  assert.equal(init.status, 0, init.stderr);
  fs.copyFileSync(path.join(dashboardRoot, '.gitignore'), path.join(dir, '.gitignore'));
  return dir;
}

function assertIgnoreStatus(repo, pathname, ignored, context = pathname) {
  const result = runGit(repo, ['check-ignore', '--quiet', '--no-index', '--', pathname]);
  assert.equal(
    result.status,
    ignored ? 0 : 1,
    `${context}: ${pathname} should ${ignored ? '' : 'not '}be ignored by Git${result.stderr ? `: ${result.stderr.trim()}` : ''}`,
  );
}

function runtimeArtifacts(filename) {
  return {
    primary: filename,
    lastGood: `${filename}.last-good`,
    corrupt: `${filename}.corrupt-2026-07-13T00-00-00-000Z`,
    atomicPrimary: `.${filename}.${atomicPid}.${atomicRandom}.tmp`,
    atomicLastGood: `.${filename}.last-good.${atomicPid}.${atomicRandom}.tmp`,
  };
}

function passkeyCredentialArtifacts() {
  const filename = 'passkey-credentials.json';
  return {
    primary: filename,
    serverAtomic: `${filename}.${atomicPid}.${atomicRandom}.tmp`,
    dotPrefixedAtomic: `.${filename}.${atomicPid}.${atomicRandom}.tmp`,
  };
}

function trackedExampleTemplates() {
  const result = runGit(dashboardRoot, ['ls-files', '--', '*.example.json']);
  assert.equal(result.status, 0, result.stderr);
  const templates = result.stdout.trim().split('\n').filter(Boolean);
  assert.ok(templates.length > 0, 'expected checked-in example JSON templates');
  return templates;
}

test('STATE_REGISTRY runtime files and JSON-store artifacts are ignored', (t) => {
  const repo = temporaryGitRepo(t);
  const entries = Object.entries(STATE_REGISTRY);
  assert.ok(entries.length > 0, 'expected registered runtime state');

  for (const [name, { filename }] of entries) {
    for (const [artifact, pathname] of Object.entries(runtimeArtifacts(filename))) {
      assertIgnoreStatus(repo, pathname, true, `${name} ${artifact}`);
    }
  }
});

test('passkey credential artifacts are ignored with registry durability contract', (t) => {
  const repo = temporaryGitRepo(t);
  assert.equal(STATE_REGISTRY.passkeyCredentials.durability, 'passkey-server-writer');

  for (const [artifact, pathname] of Object.entries(passkeyCredentialArtifacts())) {
    assertIgnoreStatus(repo, pathname, true, `passkeyCredentials ${artifact}`);
  }
});

test('example templates and ordinary project files remain trackable', (t) => {
  const repo = temporaryGitRepo(t);
  const trackablePaths = [
    ...trackedExampleTemplates(),
    'test/fixtures/safe-to-spend.js',
    'test/fixtures/ordinary.json',
    'lib/state-registry.js',
    'package.json',
    'package-lock.json',
    'app.json',
    'ordinary.json',
  ];

  for (const pathname of trackablePaths) {
    assertIgnoreStatus(repo, pathname, false);
  }
});
