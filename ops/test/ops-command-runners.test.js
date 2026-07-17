'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const os = require('os');
const path = require('path');
const {
  commandExists,
  findExecutableInPath,
  isSafeCommandName,
  createDefaultRunners,
} = require('../lib/ops-command-runners');

function mkRoot(t, prefix) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), prefix));
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  return root;
}

function writeExecutable(dir, name, body = '#!/bin/sh\nexit 0\n') {
  fs.mkdirSync(dir, { recursive: true, mode: 0o700 });
  const filePath = path.join(dir, name);
  fs.writeFileSync(filePath, body, { mode: 0o755 });
  return filePath;
}

test('isSafeCommandName rejects path separators and shell metacharacters', () => {
  assert.equal(isSafeCommandName('systemctl'), true);
  assert.equal(isSafeCommandName('docker-compose'), true);
  assert.equal(isSafeCommandName('../systemctl'), false);
  assert.equal(isSafeCommandName('bin/systemctl'), false);
  assert.equal(isSafeCommandName('systemctl;rm'), false);
  assert.equal(isSafeCommandName(''), false);
});

test('findExecutableInPath locates a regular executable in PATH', (t) => {
  const root = mkRoot(t, 'df-path-exec-');
  const bin = path.join(root, 'bin');
  const toolPath = writeExecutable(bin, 'tool-a');
  const found = findExecutableInPath('tool-a', { PATH: bin });
  assert.equal(found, toolPath);
  assert.equal(commandExists('tool-a', { PATH: bin }), true);
});

test('findExecutableInPath ignores non-executable and directory entries', (t) => {
  const root = mkRoot(t, 'df-path-skip-');
  const bin = path.join(root, 'bin');
  fs.mkdirSync(bin, { recursive: true, mode: 0o700 });
  fs.writeFileSync(path.join(bin, 'blocked'), '#!/bin/sh\n', { mode: 0o644 });
  fs.mkdirSync(path.join(bin, 'systemctl'), { mode: 0o755 });
  assert.equal(findExecutableInPath('blocked', { PATH: bin }), null);
  assert.equal(findExecutableInPath('systemctl', { PATH: bin }), null);
});

test('findExecutableInPath follows symlink to executable target', (t) => {
  const root = mkRoot(t, 'df-path-symlink-');
  const bin = path.join(root, 'bin');
  const real = writeExecutable(path.join(root, 'real'), 'systemctl');
  fs.mkdirSync(bin, { recursive: true, mode: 0o700 });
  fs.symlinkSync(real, path.join(bin, 'systemctl'));
  assert.equal(findExecutableInPath('systemctl', { PATH: bin }), path.join(bin, 'systemctl'));
});

test('findExecutableInPath skips empty PATH entries and missing directories', (t) => {
  const root = mkRoot(t, 'df-path-empty-');
  const bin = path.join(root, 'bin');
  writeExecutable(bin, 'tar');
  const pathEnv = `::${bin}:${path.join(root, 'missing')}`;
  assert.equal(findExecutableInPath('tar', { PATH: pathEnv }), path.join(bin, 'tar'));
});

test('findExecutableInPath returns null for missing, empty, or oversize PATH', (t) => {
  assert.equal(findExecutableInPath('systemctl', { PATH: '' }), null);
  assert.equal(findExecutableInPath('systemctl', {}), null);
  assert.equal(findExecutableInPath('../systemctl', { PATH: '/usr/bin' }), null);
  const huge = `${'a'.repeat(5000)}:/usr/bin`;
  assert.equal(findExecutableInPath('systemctl', { PATH: huge }), null);
});

test('findExecutableInPath honors first PATH match like Linux exec lookup', (t) => {
  const root = mkRoot(t, 'df-path-order-');
  const first = path.join(root, 'first');
  const second = path.join(root, 'second');
  writeExecutable(first, 'docker', '#!/bin/sh\necho first\n');
  writeExecutable(second, 'docker', '#!/bin/sh\necho second\n');
  const found = findExecutableInPath('docker', { PATH: `${first}${path.delimiter}${second}` });
  assert.equal(found, path.join(first, 'docker'));
});

test('findExecutableInPath applies PATHEXT on Windows', () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'df-path-win-'));
  try {
    const bin = path.join(root, 'bin');
    fs.mkdirSync(bin, { recursive: true, mode: 0o700 });
    const exePath = path.join(bin, 'tool.EXE');
    fs.writeFileSync(exePath, 'MZ', { mode: 0o755 });
    assert.equal(
      findExecutableInPath('tool', { PATH: bin, PATHEXT: '.EXE' }, 'win32'),
      exePath,
    );
    assert.equal(findExecutableInPath('tool', { PATH: bin, PATHEXT: '.EXE' }, 'linux'), null);
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
});

test('createDefaultRunners.commandExists does not invoke shell command builtin', (t) => {
  const root = mkRoot(t, 'df-path-runners-');
  const bin = path.join(root, 'bin');
  writeExecutable(bin, 'systemctl');
  const runners = createDefaultRunners({ PATH: bin });
  assert.equal(runners.commandExists('systemctl'), true);
  assert.equal(runners.commandExists('missing-tool'), false);
});

test('createDefaultRunners.commandExists is fail-closed when PATH lacks executable', () => {
  const runners = createDefaultRunners({ PATH: path.join(os.tmpdir(), 'df-empty-path-never') });
  assert.equal(runners.commandExists('systemctl'), false);
  assert.equal(runners.commandExists('docker'), false);
});
