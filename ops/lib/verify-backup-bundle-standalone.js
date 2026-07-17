#!/usr/bin/env node
'use strict';

const fs = require('fs');
const path = require('path');

const bundleRoot = path.resolve(process.argv[2] || '');
if (!bundleRoot || !fs.existsSync(bundleRoot)) {
  process.stderr.write('Usage: verify-backup-bundle.js <extracted-bundle-root>\n');
  process.exit(2);
}

const toolingRoot = path.join(bundleRoot, 'tooling');
const { EMBEDDED_MANIFEST } = require(path.join(toolingRoot, 'ops/lib/backup-bundle-schema'));
const {
  inventoryFromBundle,
  verifyExtractedTree,
} = require(path.join(toolingRoot, 'ops/lib/backup-bundle-verify'));

const manifestPath = path.join(bundleRoot, EMBEDDED_MANIFEST);
if (!fs.existsSync(manifestPath)) {
  process.stderr.write(`missing ${EMBEDDED_MANIFEST}\n`);
  process.exit(2);
}

const manifest = JSON.parse(fs.readFileSync(manifestPath, 'utf8'));
const inventory = inventoryFromBundle(bundleRoot);
verifyExtractedTree({
  bundleRoot,
  manifest,
  inventory,
  toolingRoot,
  readOnly: true,
});
process.stdout.write('verify-backup-bundle: ok\n');
