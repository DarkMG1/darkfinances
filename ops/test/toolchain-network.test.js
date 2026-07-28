'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const path = require('path');
const { spawnSync } = require('child_process');

const repositoryRoot = path.resolve(__dirname, '..', '..');
const networkEnabled = process.env.DARKFINANCES_TOOLCHAIN_NETWORK_TEST === '1';

function readWorkflow(name) {
  return fs.readFileSync(path.join(repositoryRoot, '.github/workflows', name), 'utf8');
}

test('ci.yml merge gate runs upstream action pin verification', () => {
  const ci = readWorkflow('ci.yml');
  assert.match(ci, /node scripts\/check-github-action-pins\.js --verify-upstream/);
  const pkg = JSON.parse(fs.readFileSync(path.join(repositoryRoot, 'package.json'), 'utf8'));
  assert.equal(
    pkg.scripts['check:action-pins:upstream'],
    'node scripts/check-github-action-pins.js --verify-upstream',
  );
  assert.doesNotMatch(pkg.scripts.check, /--verify-upstream/);
});

test('check-shell.sh invokes ensure-shellcheck on Linux x86_64', () => {
  const source = fs.readFileSync(path.join(repositoryRoot, 'scripts/check-shell.sh'), 'utf8');
  assert.match(source, /ensure-shellcheck\.sh/);
});

test('iOS workflows invoke ensure-maestro bootstrap wrapper', () => {
  for (const name of ['ios-pr-smoke.yml', 'maestro-full-suite.yml']) {
    const workflow = readWorkflow(name);
    assert.match(workflow, /ensure-maestro\.sh/);
  }
});

test('ensure-shellcheck prints captured --version output on mismatch', () => {
  const root = fs.mkdtempSync(path.join(require('os').tmpdir(), 'ensure-shellcheck-version-'));
  const fakeBin = path.join(root, 'shellcheck');
  fs.writeFileSync(fakeBin, '#!/usr/bin/env bash\necho "ShellCheck - shell script analysis tool" >&2\nexit 0\n');
  fs.chmodSync(fakeBin, 0o755);
  const contract = JSON.parse(fs.readFileSync(
    path.join(repositoryRoot, 'ops/toolchain/shellcheck-bootstrap.json'),
    'utf8',
  ));
  const wrapper = fs.readFileSync(path.join(repositoryRoot, 'scripts/ensure-shellcheck.sh'), 'utf8');
  assert.match(wrapper, /version_output="\$\("\$binary_path" --version 2>&1 \|\| true\)"/);
  assert.match(wrapper, /printf '%s\\n' "\$version_output" >&2/);
  assert.doesNotMatch(wrapper, /2>\/dev\/null/);
  spawnSync('bash', ['-n', path.join(repositoryRoot, 'scripts/ensure-shellcheck.sh')]);
  assert.equal(contract.version, '0.11.0');
  fs.rmSync(root, { recursive: true, force: true });
});

test('ensure-maestro prints captured --version output on mismatch', () => {
  const wrapper = fs.readFileSync(path.join(repositoryRoot, 'scripts/ensure-maestro.sh'), 'utf8');
  assert.match(wrapper, /version_output="\$\("\$binary_path" --version 2>&1 \|\| true\)"/);
  assert.match(wrapper, /printf '%s\\n' "\$version_output" >&2/);
  assert.doesNotMatch(wrapper, /2>\/dev\/null/);
  spawnSync('bash', ['-n', path.join(repositoryRoot, 'scripts/ensure-maestro.sh')]);
});

test('network toolchain integration bootstraps real ShellCheck on Linux x86_64', { skip: !networkEnabled }, () => {
  if (process.platform !== 'linux' || process.arch !== 'x64') {
    assert.fail('DARKFINANCES_TOOLCHAIN_NETWORK_TEST=1 ShellCheck contract requires linux/x86_64');
  }
  const result = spawnSync('bash', [path.join(repositoryRoot, 'scripts/ensure-shellcheck.sh')], {
    encoding: 'utf8',
    env: { ...process.env, CI: 'true', GITHUB_ACTIONS: 'true' },
  });
  assert.equal(result.status, 0, `${result.stderr}\n${result.stdout}`);
  const version = spawnSync(result.stdout.trim(), ['--version'], { encoding: 'utf8' });
  assert.equal(version.status, 0, version.stderr || version.stdout);
  assert.match(version.stdout + version.stderr, /0\.11\.0/);
});

test('network toolchain integration bootstraps real Maestro on macOS', { skip: !networkEnabled }, () => {
  if (process.platform !== 'darwin') {
    assert.fail('DARKFINANCES_TOOLCHAIN_NETWORK_TEST=1 Maestro contract requires darwin');
  }
  const result = spawnSync('bash', [path.join(repositoryRoot, 'scripts/ensure-maestro.sh')], {
    encoding: 'utf8',
    env: { ...process.env, CI: 'true', GITHUB_ACTIONS: 'true', ENSURE_MAESTRO_FORCE: '1' },
  });
  assert.equal(result.status, 0, `${result.stderr}\n${result.stdout}`);
  const version = spawnSync(result.stdout.trim(), ['--version'], { encoding: 'utf8' });
  assert.equal(version.status, 0, version.stderr || version.stdout);
  assert.match(version.stdout + version.stderr, /2\.7\.0/);
});
