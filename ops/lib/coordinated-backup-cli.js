#!/usr/bin/env node
'use strict';

const { runCoordinatedBackup } = require('./coordinated-backup');

async function main() {
  const dryRun = process.env.BACKUP_DRY_RUN === '1' || process.argv.includes('--dry-run');
  const quiesce = process.env.BACKUP_QUIESCE !== '0';
  const includeActual = process.env.BACKUP_INCLUDE_ACTUAL_DATA === '1';

  try {
    const result = await runCoordinatedBackup({
      dryRun,
      quiesce,
      includeActual,
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
