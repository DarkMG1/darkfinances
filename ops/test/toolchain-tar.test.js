'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const os = require('os');
const path = require('path');
const { spawnSync } = require('child_process');
const {
  extractTarMemberToFile,
  listTarArchive,
  parseVerboseTarLine,
} = require('../../scripts/toolchain-tar');

const LIMITS = {
  maxMemberCount: 16,
  maxMemberBytes: 64 * 1024,
  maxUncompressedBytes: 128 * 1024,
};

function runTar(args, cwd) {
  return spawnSync('tar', args, { cwd, encoding: 'utf8' });
}

test('parseVerboseTarLine accepts GNU and BSD date formats', () => {
  assert.deepEqual(
    parseVerboseTarLine(
      '-rwxr-xr-x runner/docker     18 2026-07-28 06:00 shellcheck-v0.0.0/shellcheck',
    ),
    { type: '-', size: 18, name: 'shellcheck-v0.0.0/shellcheck' },
  );
  assert.deepEqual(
    parseVerboseTarLine(
      '-rwxr-xr-x  0 chiragbhat wheel      18 Jul 27 23:12 shellcheck-v0.0.0/shellcheck',
    ),
    { type: '-', size: 18, name: 'shellcheck-v0.0.0/shellcheck' },
  );
  assert.deepEqual(
    parseVerboseTarLine(
      '-rw-r--r--  0 chiragbhat wheel      18 Jul 17  2024 path with spaces.txt',
    ),
    { type: '-', size: 18, name: 'path with spaces.txt' },
  );
});

test('parseVerboseTarLine fails closed on unparseable regular-file size', () => {
  assert.throws(
    () => parseVerboseTarLine('-rw-r--r-- owner/group ??? 2026-07-28 06:00 member.txt'),
    /unable to parse tar verbose size/,
  );
});

test('listTarArchive rejects symlink members', () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'toolchain-tar-'));
  fs.writeFileSync(path.join(root, 'target.txt'), 'payload');
  fs.symlinkSync('target.txt', path.join(root, 'link.txt'));
  const archive = path.join(root, 'bad.tar.xz');
  runTar(['-cJf', archive, 'target.txt', 'link.txt'], root);
  assert.throws(() => listTarArchive(archive, LIMITS), /symlink member/);
});

test('extractTarMemberToFile writes regular file from stdout extraction', () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'toolchain-tar-'));
  const payloadDir = path.join(root, 'payload');
  fs.mkdirSync(payloadDir, { recursive: true });
  const memberPath = path.join(payloadDir, 'shellcheck-v0.0.0/shellcheck');
  fs.mkdirSync(path.dirname(memberPath), { recursive: true });
  fs.writeFileSync(memberPath, '#!/bin/sh\necho ok\n', { mode: 0o755 });
  const archive = path.join(root, 'good.tar.xz');
  runTar(['-cJf', archive, '-C', payloadDir, 'shellcheck-v0.0.0/shellcheck'], root);
  const dest = path.join(root, 'out', 'shellcheck-v0.0.0/shellcheck');
  extractTarMemberToFile(archive, 'shellcheck-v0.0.0/shellcheck', dest, LIMITS);
  assert.match(fs.readFileSync(dest, 'utf8'), /echo ok/);
  assert.ok(fs.statSync(dest).isFile());
});

test('extractTarMemberToFile rejects missing member', () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'toolchain-tar-'));
  const archive = path.join(root, 'empty.tar.xz');
  runTar(['-cJf', archive, '--files-from', '/dev/null'], root);
  assert.throws(
    () => extractTarMemberToFile(archive, 'missing', path.join(root, 'out'), LIMITS),
    /does not contain expected member/,
  );
});
