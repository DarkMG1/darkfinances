'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const { parseStagedRestoreCliArgs } = require('../lib/staged-restore-cli-args');

test('default preview mode when no flags or CONFIRM', () => {
  const parsed = parseStagedRestoreCliArgs(['bundle.tgz'], {});
  assert.equal(parsed.dryRun, true);
  assert.equal(parsed.confirm, false);
});

test('CONFIRM=1 selects live mode without explicit CLI flag', () => {
  const parsed = parseStagedRestoreCliArgs(['bundle.tgz'], { CONFIRM: '1' });
  assert.equal(parsed.dryRun, false);
  assert.equal(parsed.confirm, true);
});

test('--confirm selects live mode', () => {
  const parsed = parseStagedRestoreCliArgs(['--confirm', 'bundle.tgz'], {});
  assert.equal(parsed.dryRun, false);
  assert.equal(parsed.confirm, true);
});

test('explicit --dry-run selects preview mode', () => {
  const parsed = parseStagedRestoreCliArgs(['--dry-run', 'bundle.tgz'], {});
  assert.equal(parsed.dryRun, true);
  assert.equal(parsed.confirm, false);
});

test('rejects --dry-run and --confirm in either order', () => {
  for (const argv of [
    ['--dry-run', '--confirm', 'bundle.tgz'],
    ['--confirm', '--dry-run', 'bundle.tgz'],
    ['--dry-run', 'bundle.tgz', '--confirm'],
  ]) {
    assert.throws(
      () => parseStagedRestoreCliArgs(argv, {}),
      /conflicting restore mode flags/,
    );
  }
});

test('rejects CONFIRM=1 with explicit --dry-run', () => {
  assert.throws(
    () => parseStagedRestoreCliArgs(['--dry-run', 'bundle.tgz'], { CONFIRM: '1' }),
    /conflicting restore mode \(--dry-run with CONFIRM=1\)/,
  );
});

test('rejects duplicate contradictory mode flags', () => {
  assert.throws(
    () => parseStagedRestoreCliArgs(['--dry-run', '--confirm', '--dry-run', 'bundle.tgz'], {}),
    /conflicting restore mode flags/,
  );
});

test('duplicate same mode flag remains consistent', () => {
  const dryRun = parseStagedRestoreCliArgs(['--dry-run', '--dry-run', 'bundle.tgz'], {});
  assert.equal(dryRun.dryRun, true);
  const confirm = parseStagedRestoreCliArgs(['--confirm', '--confirm', 'bundle.tgz'], {});
  assert.equal(confirm.dryRun, false);
});
