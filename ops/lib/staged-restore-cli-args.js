'use strict';

function parseStagedRestoreCliArgs(argv, env = {}) {
  let sawDryRun = false;
  let sawConfirm = false;
  let archivePath = null;

  for (const arg of argv) {
    if (arg === '--help' || arg === '-h') {
      return { help: true, archivePath: null, dryRun: true, confirm: false };
    }
    if (arg === '--dry-run') {
      if (sawConfirm) {
        throw new Error('restore refused: conflicting restore mode flags (--dry-run and --confirm)');
      }
      sawDryRun = true;
      continue;
    }
    if (arg === '--confirm') {
      if (sawDryRun) {
        throw new Error('restore refused: conflicting restore mode flags (--dry-run and --confirm)');
      }
      sawConfirm = true;
      continue;
    }
    if (!archivePath) {
      archivePath = arg;
      continue;
    }
    throw new Error('restore refused: unexpected argument');
  }

  if (sawDryRun && env.CONFIRM === '1') {
    throw new Error('restore refused: conflicting restore mode (--dry-run with CONFIRM=1)');
  }

  let dryRun;
  if (sawDryRun) {
    dryRun = true;
  } else if (sawConfirm) {
    dryRun = false;
  } else if (env.CONFIRM === '1') {
    dryRun = false;
  } else {
    dryRun = true;
  }

  return {
    help: false,
    archivePath,
    dryRun,
    confirm: dryRun === false,
  };
}

module.exports = {
  parseStagedRestoreCliArgs,
};
