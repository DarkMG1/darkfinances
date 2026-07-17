#!/usr/bin/env node
'use strict';

const path = require('path');

function loadCoordinatedBackup() {
  const libDir = path.basename(path.dirname(__filename)) === 'bin'
    ? path.join(__dirname, '..', 'lib')
    : __dirname;
  return require(path.join(libDir, 'coordinated-backup'));
}

async function main() {
  const dryRun = process.env.BACKUP_DRY_RUN === '1' || process.argv.includes('--dry-run');
  const includeActual = process.env.BACKUP_INCLUDE_ACTUAL_DATA === '1';
  const preQuiesced = process.env.BACKUP_PRE_QUIESCED === '1';

  try {
    const { runCoordinatedBackup } = loadCoordinatedBackup();
    const result = await runCoordinatedBackup({
      dryRun,
      includeActual,
      preQuiesced,
      env: process.env,
    });
    if (result.dryRun) {
      process.stdout.write(`${JSON.stringify(result.plan, null, 2)}\n`);
      process.exit(2);
    }
    if (result.bundleArchive) process.stdout.write(`${result.bundleArchive}\n`);
    process.exit(0);
  } catch (error) {
    process.stderr.write(`${error.message}\n`);
    process.exit(1);
  }
}

main();
