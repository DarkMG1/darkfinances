#!/usr/bin/env node
'use strict';

const path = require('path');
const { runStagedRestore } = require('./staged-restore');

function usage() {
  console.error('Usage: restore-dashboard-runtime.js [--dry-run|--confirm] <bundle.tgz>');
  console.error('Environment:');
  console.error('  FINANCE_DASHBOARD_DIR            destination runtime directory');
  console.error('  RESTORE_QUIESCENCE_ADMISSION_PATH path to PR-18 admission token JSON');
  console.error('  RESTORE_QUIESCENCE_ADMISSION_TOKEN inline admission token JSON');
  process.exit(2);
}

const args = process.argv.slice(2);
let dryRun = true;
let archivePath = null;

for (const arg of args) {
  if (arg === '--dry-run') dryRun = true;
  else if (arg === '--confirm') dryRun = false;
  else if (arg === '--help' || arg === '-h') usage();
  else if (!archivePath) archivePath = arg;
  else usage();
}

if (!archivePath) usage();

const destinationRoot = process.env.FINANCE_DASHBOARD_DIR
  || path.join(process.env.HOME || '/tmp', 'finance-dashboard');

if (process.env.CONFIRM === '1') {
  dryRun = false;
}

try {
  const result = runStagedRestore({
    archivePath: path.resolve(archivePath),
    destinationRoot: path.resolve(destinationRoot),
    dryRun,
    confirm: !dryRun,
    releaseManifestPath: process.env.RESTORE_RELEASE_MANIFEST_PATH || null,
    actualDataGenerationPath: process.env.RESTORE_ACTUAL_DATA_GENERATION_PATH || null,
  });
  if (result.dryRun) {
    console.error('restore dry-run: ok');
    console.error(JSON.stringify(result.report, null, 2));
    process.exit(2);
  }
  console.log('restore: ok');
  console.log(JSON.stringify(result.report, null, 2));
} catch (error) {
  console.error(`restore failed: ${error.message}`);
  process.exit(1);
}
