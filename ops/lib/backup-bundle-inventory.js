'use strict';

const fs = require('fs');
const path = require('path');
const crypto = require('crypto');
const { STATE_REGISTRY } = require('../../finance-dashboard/lib/state-registry');
const {
  INVENTORY_SCHEMA_VERSION,
  assertSupportedInventorySchemaVersion,
} = require('./backup-bundle-schema');

const INVENTORY_PATH = path.join(__dirname, 'backup-state-inventory.json');

function buildStateInventory() {
  const stores = Object.entries(STATE_REGISTRY)
    .filter(([, definition]) => definition.backup)
    .map(([name, definition]) => ({
      name,
      filename: definition.filename,
      schemaVersion: definition.schemaVersion,
      durability: definition.durability,
      optionalMissing: definition.optionalMissing === true,
      unknownFieldPolicy: definition.unknownFieldPolicy,
      lastGoodPolicy: definition.lastGoodPolicy,
      sagaSemantics: definition.sagaSemantics === true,
      references: definition.references,
    }))
    .sort((a, b) => a.name.localeCompare(b.name));

  return {
    schemaVersion: INVENTORY_SCHEMA_VERSION,
    generatedFrom: 'finance-dashboard/lib/state-registry.js',
    storeCount: stores.length,
    stores,
    auxiliary: {
      receiptsDirectory: 'receipts',
      lastGoodSuffix: '.last-good',
      excludedBasenames: ['.env', '.backup-manifest.json', 'bundle-manifest.json'],
      excludedPatterns: ['*.corrupt-*'],
    },
  };
}

function inventoryDigest(inventory) {
  return crypto.createHash('sha256').update(`${JSON.stringify(inventory)}\n`).digest('hex');
}

function loadBackupStateInventory(options = {}) {
  const inventoryPath = options.inventoryPath || INVENTORY_PATH;
  const inventory = JSON.parse(fs.readFileSync(inventoryPath, 'utf8'));
  assertSupportedInventorySchemaVersion(inventory.schemaVersion);
  return inventory;
}

function sidecarFilenames(options = {}) {
  return loadBackupStateInventory(options).stores.map((store) => store.filename).sort();
}

function storeByFilename(filename, options = {}) {
  const inventory = loadBackupStateInventory(options);
  const store = inventory.stores.find((entry) => entry.filename === filename);
  if (!store) throw new Error(`unknown backup sidecar filename: ${filename}`);
  return store;
}

function assertInventoryMatchesRegistry(options = {}) {
  const built = buildStateInventory();
  const committed = loadBackupStateInventory(options);
  if (built.storeCount !== committed.storeCount) {
    throw new Error('backup-state-inventory storeCount mismatch');
  }
  if (inventoryDigest(built) !== inventoryDigest(committed)) {
    throw new Error('backup-state-inventory.json is out of sync with STATE_REGISTRY');
  }
  return committed;
}

function lastGoodRelativePath(filename) {
  return `${filename}.last-good`;
}

function allowsLastGoodSidecar(store) {
  return store.lastGoodPolicy === 'allow-on-primary-invalid';
}

function isExcludedRuntimeBasename(name) {
  if (name.startsWith('.env')) return true;
  if (name === '.backup-manifest.json' || name === 'bundle-manifest.json') return true;
  if (/\.corrupt-/.test(name)) return true;
  return false;
}

module.exports = {
  INVENTORY_PATH,
  buildStateInventory,
  inventoryDigest,
  loadBackupStateInventory,
  sidecarFilenames,
  storeByFilename,
  assertInventoryMatchesRegistry,
  lastGoodRelativePath,
  allowsLastGoodSidecar,
  isExcludedRuntimeBasename,
};
