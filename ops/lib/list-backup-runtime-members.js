#!/usr/bin/env node
'use strict';

const fs = require('fs');
const path = require('path');
const {
  loadBackupStateInventory,
  allowsLastGoodSidecar,
  lastGoodRelativePath,
  isExcludedRuntimeBasename,
} = require('./backup-bundle-inventory');

const dashboardDir = process.argv[2];
if (!dashboardDir) {
  console.error('Usage: list-backup-runtime-members.js <dashboardDir>');
  process.exit(2);
}

const inventory = loadBackupStateInventory();
const members = [];

for (const store of inventory.stores) {
  const primary = path.join(dashboardDir, store.filename);
  if (fs.existsSync(primary)) members.push(store.filename);
  if (allowsLastGoodSidecar(store)) {
    const lastGood = path.join(dashboardDir, lastGoodRelativePath(store.filename));
    if (fs.existsSync(lastGood)) members.push(lastGoodRelativePath(store.filename));
  }
}

const receiptsDir = path.join(dashboardDir, inventory.auxiliary.receiptsDirectory);
if (fs.existsSync(receiptsDir)) {
  members.push(inventory.auxiliary.receiptsDirectory);
}

for (const member of members) {
  if (isExcludedRuntimeBasename(path.basename(member))) continue;
  process.stdout.write(`${member}\n`);
}
