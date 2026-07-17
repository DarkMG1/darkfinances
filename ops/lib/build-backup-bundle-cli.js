#!/usr/bin/env node
'use strict';

const path = require('path');
const { buildBackupBundle } = require('./build-backup-bundle');
const { verifyBackupBundleArchive } = require('./backup-bundle-verify');

const dashboardDir = process.argv[2];
const archivePath = path.resolve(process.argv[3]);
if (!dashboardDir || !process.argv[3]) {
  console.error('Usage: build-backup-bundle.js <dashboardDir> <archivePath>');
  process.exit(2);
}

const manifest = buildBackupBundle({ dashboardDir, archivePath });
verifyBackupBundleArchive({ archivePath });
process.stdout.write(`${archivePath}\n`);
