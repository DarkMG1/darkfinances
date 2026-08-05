#!/usr/bin/env node
'use strict';

const path = require('path');
const { parseStagedRestoreCliArgs } = require('./staged-restore-cli-args');

function loadStagedRestore() {
  const libDir = path.basename(path.dirname(__filename)) === 'bin'
    ? path.join(__dirname, '..', 'lib')
    : __dirname;
  return require(path.join(libDir, 'staged-restore'));
}

function usage() {
  console.error('Usage: restore-dashboard-runtime.js --dry-run <bundle.tgz>');
  console.error('Live restore must run through restore-coordinated.sh so writer stops remain held through swap.');
  console.error('Environment:');
  console.error('  FINANCE_DASHBOARD_DIR            destination runtime directory');
  console.error('  RESTORE_QUIESCENCE_ADMISSION_PATH path to PR-18 admission token JSON (0600, trusted roots)');
  process.exit(2);
}

let parsed;
try {
  parsed = parseStagedRestoreCliArgs(process.argv.slice(2), process.env);
} catch (error) {
  console.error(`restore failed: ${error.message}`);
  process.exit(2);
}

if (parsed.help) usage();
if (!parsed.archivePath) usage();

const destinationRoot = process.env.FINANCE_DASHBOARD_DIR
  || path.join(process.env.HOME || '/tmp', 'finance-dashboard');

try {
  const { runStagedRestore } = loadStagedRestore();
  const result = runStagedRestore({
    archivePath: path.resolve(parsed.archivePath),
    destinationRoot: path.resolve(destinationRoot),
    dryRun: parsed.dryRun,
    confirm: parsed.confirm,
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
