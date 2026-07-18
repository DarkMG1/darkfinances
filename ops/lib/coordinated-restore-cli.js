#!/usr/bin/env node
'use strict';

const path = require('path');

function loadCoordinatedRestore() {
  const libDir = path.basename(path.dirname(__filename)) === 'bin'
    ? path.join(__dirname, '..', 'lib')
    : __dirname;
  return require(path.join(libDir, 'coordinated-restore'));
}

async function main() {
  const dryRun = process.env.RESTORE_DRY_RUN === '1' || process.argv.includes('--dry-run');
  const archivePath = process.argv.find((arg) => !arg.startsWith('-') && arg.endsWith('.tgz'))
    || process.env.RESTORE_ARCHIVE_PATH;
  if (!archivePath) {
    process.stderr.write('restore archive path required\n');
    process.exit(1);
  }
  try {
    const { runCoordinatedRestore } = loadCoordinatedRestore();
    const result = await runCoordinatedRestore({ dryRun, archivePath, env: process.env });
    if (result.dryRun) {
      process.stdout.write(`${JSON.stringify(result.plan, null, 2)}\n`);
      process.exit(2);
    }
    process.exit(0);
  } catch (error) {
    process.stderr.write(`${error.message}\n`);
    process.exit(1);
  }
}

main();
