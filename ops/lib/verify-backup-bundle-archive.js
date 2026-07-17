#!/usr/bin/env node
'use strict';

const path = require('path');
const { verifyBackupBundleArchive } = require('./backup-bundle-verify');

const archivePath = process.argv[2];
if (!archivePath) {
  console.error('Usage: verify-backup-bundle-archive.js <bundle.tgz>');
  process.exit(2);
}

verifyBackupBundleArchive({
  archivePath: path.resolve(archivePath),
  publishDir: process.env.DARKFINANCES_BUNDLE_EXTRACT_DIR || null,
});
console.log('verify-backup-bundle: ok');
