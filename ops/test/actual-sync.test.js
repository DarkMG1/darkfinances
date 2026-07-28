'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const os = require('os');
const path = require('path');
const { spawnSync } = require('child_process');

const repoRoot = path.resolve(__dirname, '..', '..');
const actualSyncScript = path.join(repoRoot, 'ops/bin/actual-sync.sh');

function mkRoot(t, prefix) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), prefix));
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  return root;
}

function installActualSyncFixture(root, { collectorExitCode = 0, includeRules = true } = {}) {
  const binDir = path.join(root, 'bin');
  fs.mkdirSync(binDir, { recursive: true, mode: 0o700 });
  fs.symlinkSync(process.execPath, path.join(binDir, 'node'));
  fs.mkdirSync(path.join(root, '.config', 'openclaw'), { recursive: true, mode: 0o700 });
  fs.writeFileSync(path.join(root, '.config', 'openclaw', 'secrets.env'), '# stub secrets\n');
  fs.mkdirSync(path.join(root, '.npm-global', 'lib', 'node_modules'), { recursive: true, mode: 0o700 });
  fs.mkdirSync(path.join(root, 'actual'), { recursive: true, mode: 0o700 });
  fs.writeFileSync(
    path.join(root, 'actual', 'bank-sync.js'),
    'process.exit(0);\n',
    { mode: 0o600 },
  );
  fs.mkdirSync(path.join(root, 'actual-tools'), { recursive: true, mode: 0o700 });
  if (includeRules) {
    fs.writeFileSync(
      path.join(root, 'actual-tools', 'collection-rules.json'),
      '{}\n',
      { mode: 0o600 },
    );
  }
  fs.writeFileSync(
    path.join(root, 'actual-tools', 'run.sh'),
    `#!/usr/bin/env bash\nset -euo pipefail\necho invoked >> "${root}/collector-invocations.txt"\nexit ${collectorExitCode}\n`,
    { mode: 0o755 },
  );
}

function runActualSync(root, envOverrides = {}) {
  const binDir = path.join(root, 'bin');
  return spawnSync('bash', [actualSyncScript], {
    env: {
      ...process.env,
      HOME: root,
      PATH: `${binDir}:/usr/bin:/bin:/usr/local/bin`,
      ...envOverrides,
    },
    encoding: 'utf8',
  });
}

test('actual-sync.sh succeeds when COLLECTION_EVENT is unset and skips event collection', (t) => {
  const root = mkRoot(t, 'df-actual-sync-unset-');
  installActualSyncFixture(root, { collectorExitCode: 1 });
  const result = runActualSync(root, { COLLECTION_EVENT: '' });
  delete process.env.COLLECTION_EVENT;

  assert.equal(result.status, 0, result.stderr || result.stdout);
  assert.doesNotMatch(result.stderr, /event collection automation failed/);
});

test('actual-sync.sh fails when bank sync succeeds and configured collector fails', (t) => {
  const root = mkRoot(t, 'df-actual-sync-collector-fail-');
  installActualSyncFixture(root, { collectorExitCode: 1 });
  const result = runActualSync(root, { COLLECTION_EVENT: 'monthly-close' });

  assert.notEqual(result.status, 0, 'expected nonzero exit for OnFailure contract');
  assert.match(result.stderr, /event collection automation failed/);
});

test('actual-sync.sh succeeds when bank sync and configured collector both succeed', (t) => {
  const root = mkRoot(t, 'df-actual-sync-collector-ok-');
  installActualSyncFixture(root, { collectorExitCode: 0 });
  const result = runActualSync(root, { COLLECTION_EVENT: 'monthly-close' });

  assert.equal(result.status, 0, result.stderr || result.stdout);
  assert.doesNotMatch(result.stderr, /event collection automation failed/);
});

test('actual-sync.sh succeeds when COLLECTION_EVENT is set but collection-rules.json is absent', (t) => {
  const root = mkRoot(t, 'df-actual-sync-no-rules-');
  installActualSyncFixture(root, { collectorExitCode: 1, includeRules: false });
  const result = runActualSync(root, { COLLECTION_EVENT: 'monthly-close' });

  assert.equal(result.status, 0, result.stderr || result.stdout);
  assert.doesNotMatch(result.stderr, /event collection automation failed/);
  assert.equal(fs.existsSync(path.join(root, 'collector-invocations.txt')), false);
});
