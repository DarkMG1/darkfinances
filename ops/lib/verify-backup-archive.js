#!/usr/bin/env node
const path = require('path');
const { verifyArchive } = require('../lib/backup-verify');

const archivePath = process.argv[2];
const dashboardDir = process.argv[3] || null;
if (!archivePath) {
  console.error('Usage: verify-backup-archive.js <archive.tgz> [dashboardDir]');
  process.exit(2);
}
verifyArchive({ archivePath, dashboardDir });
console.log('verify-backup: ok');
