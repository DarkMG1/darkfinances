#!/usr/bin/env node
'use strict';

const path = require('path');
const { runPinnedEas } = require('../../finance-dashboard/lib/pinned-eas-cli');

const APP_ROOT = path.resolve(__dirname, '..');
const REPO_ROOT = path.resolve(APP_ROOT, '..');

function main() {
  const args = process.argv.slice(2);
  try {
    const { result } = runPinnedEas(args, {
      appRoot: APP_ROOT,
      repoRoot: REPO_ROOT,
      stdio: 'inherit',
    });
    if (result.status !== 0) {
      process.exit(result.status ?? 1);
    }
  } catch (error) {
    console.error(`run-pinned-eas: ${error.message}`);
    process.exit(1);
  }
}

if (require.main === module) main();
module.exports = {
  APP_ROOT,
  REPO_ROOT,
};
