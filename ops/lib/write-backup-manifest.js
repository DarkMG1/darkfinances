#!/usr/bin/env node
const path = require('path');
const { buildManifest } = require('./backup-verify');

const dashboardDir = process.argv[2];
const archivePath = process.argv[3];
const files = process.argv.slice(4);
if (!dashboardDir || !archivePath || files.length === 0) {
  console.error('Usage: write-backup-manifest.js <dashboardDir> <archivePath> <files...>');
  process.exit(2);
}
process.stdout.write(`${JSON.stringify(buildManifest({ dashboardDir, archivePath, files }))}\n`);
