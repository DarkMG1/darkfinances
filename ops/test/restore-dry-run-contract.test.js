'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const path = require('path');

const repoRoot = path.resolve(__dirname, '..', '..');

test('restore dry-run docs distinguish coordinated RESTORE_DRY_RUN from standalone preview', () => {
  const release = fs.readFileSync(path.join(repoRoot, 'docs/RELEASE.md'), 'utf8');
  const opsReadme = fs.readFileSync(path.join(repoRoot, 'ops/README.md'), 'utf8');
  const restoreCli = fs.readFileSync(path.join(repoRoot, 'ops/lib/staged-restore-cli.js'), 'utf8');
  const restoreShell = fs.readFileSync(path.join(repoRoot, 'ops/bin/restore-dashboard-runtime.sh'), 'utf8');

  assert.match(release, /Standalone preview/);
  assert.match(release, /Coordinated restore preview/);
  assert.match(release, /`RESTORE_DRY_RUN` applies only to coordinated restore, not the standalone helper/);
  assert.match(release, /Standalone `CONFIRM=1` is rejected/);
  assert.match(release, /### Restore admission transport migration/);
  assert.match(release, /RESTORE_QUIESCENCE_ADMISSION_PATH/);
  assert.match(release, /Inline JSON\/token transport/);
  assert.match(release, /mode `0600`/);
  assert.match(release, /trusted coordinator roots/);
  assert.match(release, /Coordinated preview/);

  assert.match(opsReadme, /`RESTORE_DRY_RUN=1` applies only to[\s\S]*`restore-coordinated\.sh`/);
  assert.match(opsReadme, /Default invocation is[\s\S]*dry-run \(`--dry-run`\)/);
  assert.match(opsReadme, /`CONFIRM=1` is rejected by the standalone/);
  assert.match(opsReadme, /RESTORE_QUIESCENCE_ADMISSION_PATH/);
  assert.match(opsReadme, /Inline JSON\/token transport \(`RESTORE_QUIESCENCE_ADMISSION_TOKEN`\) is rejected/);
  assert.match(opsReadme, /Live restore is allowed only inside the coordinated session/);

  assert.match(restoreCli, /RESTORE_QUIESCENCE_ADMISSION_PATH/);
  assert.doesNotMatch(restoreCli, /RESTORE_QUIESCENCE_ADMISSION_TOKEN/);
  assert.match(restoreShell, /RESTORE_QUIESCENCE_ADMISSION_PATH/);
  assert.doesNotMatch(restoreShell, /RESTORE_QUIESCENCE_ADMISSION_TOKEN/);
});

test('production restore entrypoints pass explicit boolean dryRun to admission callers', () => {
  const stagedRestoreCli = fs.readFileSync(path.join(repoRoot, 'ops/lib/staged-restore-cli.js'), 'utf8');
  const coordinatedRestoreCli = fs.readFileSync(path.join(repoRoot, 'ops/lib/coordinated-restore-cli.js'), 'utf8');
  const stagedRestore = fs.readFileSync(path.join(repoRoot, 'ops/lib/staged-restore.js'), 'utf8');
  const coordinatedRestore = fs.readFileSync(path.join(repoRoot, 'ops/lib/coordinated-restore.js'), 'utf8');
  const restoreQuiescenceAdmission = fs.readFileSync(
    path.join(repoRoot, 'ops/lib/restore-quiescence-admission.js'),
    'utf8',
  );

  assert.match(stagedRestoreCli, /dryRun:\s*parsed\.dryRun/);
  assert.match(coordinatedRestoreCli, /runCoordinatedRestore\(\{\s*dryRun,/);
  assert.match(coordinatedRestore, /runStagedRestore\)\(\{[\s\S]*?dryRun:\s*false/);
  assert.equal((stagedRestore.match(/requireQuiescenceAdmission\(/g) || []).length, 1);
  assert.match(stagedRestore, /requireQuiescenceAdmission\(\{[\s\S]*?dryRun:\s*true/);
  assert.match(stagedRestore, /standalone live restore is refused/);
  assert.match(stagedRestore, /assertCoordinatedLockHeld/);
  assert.match(restoreQuiescenceAdmission, /resolveRestoreAdmissionTransportPolicy\(options\)/);
  const transport = fs.readFileSync(path.join(repoRoot, 'ops/lib/restore-admission-transport.js'), 'utf8');
  assert.match(transport, /assertExplicitRestoreAdmissionMode/);
  assert.match(transport, /typeof options\.dryRun !== 'boolean'/);
});
