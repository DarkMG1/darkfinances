'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const path = require('path');

const repoRoot = path.resolve(__dirname, '..', '..');

test('restore dry-run docs distinguish coordinated RESTORE_DRY_RUN from standalone preview', () => {
  const release = fs.readFileSync(path.join(repoRoot, 'docs/RELEASE.md'), 'utf8');
  const opsReadme = fs.readFileSync(path.join(repoRoot, 'ops/README.md'), 'utf8');

  assert.match(release, /Standalone preview/);
  assert.match(release, /Coordinated restore preview/);
  assert.match(release, /`RESTORE_DRY_RUN` applies only to coordinated restore, not the standalone helper/);
  assert.match(release, /standalone: `CONFIRM=1`/);

  assert.match(opsReadme, /`RESTORE_DRY_RUN=1` applies only to[\s\S]*`restore-coordinated\.sh`/);
  assert.match(opsReadme, /Default invocation is[\s\S]*dry-run \(`--dry-run`\)/);
  assert.match(opsReadme, /live swap requires `CONFIRM=1`/);
});
