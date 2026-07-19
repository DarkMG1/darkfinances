'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const os = require('os');
const path = require('path');
const { spawnSync } = require('child_process');

const repositoryRoot = path.resolve(__dirname, '..', '..');
const checkShellScript = path.join(repositoryRoot, 'scripts/check-shell.sh');

function runCheckShell(env = {}) {
  return spawnSync('/bin/bash', [checkShellScript], {
    cwd: repositoryRoot,
    encoding: 'utf8',
    env: { ...process.env, ...env },
  });
}

function pathWithoutShellcheck() {
  const which = spawnSync('/bin/bash', ['-lc', 'command -v shellcheck'], { encoding: 'utf8' });
  const shellcheck = which.stdout.trim();
  if (!shellcheck) return process.env.PATH || '';
  const shellcheckDir = path.dirname(shellcheck);
  return (process.env.PATH || '')
    .split(':')
    .filter((entry) => entry && entry !== shellcheckDir)
    .join(':');
}

function envWithoutShellcheck(extra = {}) {
  const { CI, GITHUB_ACTIONS, ...base } = process.env;
  return {
    ...base,
    PATH: '/usr/bin:/bin',
    ...extra,
  };
}

test('check-shell skips cleanly when shellcheck is unavailable locally', () => {
  const result = runCheckShell(envWithoutShellcheck());

  assert.equal(result.status, 0, `${result.stderr}\n${result.stdout}`);
  assert.match(result.stdout, /shellcheck: skipped \(not installed/);
});

test('check-shell fails when shellcheck is unavailable in CI=true', () => {
  const result = runCheckShell(envWithoutShellcheck({ CI: 'true' }));

  assert.notEqual(result.status, 0);
  assert.match(result.stderr, /shellcheck: required in CI but not installed/);
  assert.doesNotMatch(result.stdout, /skipped/);
});

test('check-shell fails when shellcheck is unavailable in GITHUB_ACTIONS=true', () => {
  const result = runCheckShell(envWithoutShellcheck({ GITHUB_ACTIONS: 'true' }));

  assert.notEqual(result.status, 0);
  assert.match(result.stderr, /shellcheck: required in CI but not installed/);
  assert.doesNotMatch(result.stdout, /skipped/);
});

test('check-shell fails when shellcheck reports warnings', (t) => {
  const binDir = fs.mkdtempSync(path.join(os.tmpdir(), 'darkfinances-fake-shellcheck-'));
  t.after(() => fs.rmSync(binDir, { recursive: true, force: true }));
  const fake = path.join(binDir, 'shellcheck');
  fs.writeFileSync(fake, '#!/usr/bin/env bash\nexit 1\n');
  fs.chmodSync(fake, 0o755);

  const result = runCheckShell({ PATH: `${binDir}:${process.env.PATH || ''}` });

  assert.notEqual(result.status, 0);
});

test('check-shell passes with real shellcheck on repository scripts', () => {
  if (spawnSync('command', ['-v', 'shellcheck'], { shell: true, encoding: 'utf8' }).status !== 0) {
    return;
  }

  const result = runCheckShell();
  assert.equal(result.status, 0, result.stderr || result.stdout);
});

test('package.json check:shell delegates to scripts/check-shell.sh', () => {
  const pkg = JSON.parse(fs.readFileSync(path.join(repositoryRoot, 'package.json'), 'utf8'));
  assert.equal(pkg.scripts['check:shell'], 'bash scripts/check-shell.sh');
});
