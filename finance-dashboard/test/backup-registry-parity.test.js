const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const path = require('path');
const { STATE_REGISTRY, backupEntries } = require('../lib/state-registry');
const { SIDECAR_FILES } = require('../../ops/lib/backup-verify');
const {
  assertInventoryMatchesRegistry,
  loadBackupStateInventory,
  sidecarFilenames,
} = require('../../ops/lib/backup-bundle-inventory');

test('STATE_REGISTRY backup:true inventory matches backup-verify SIDECAR_FILES exactly', () => {
  const registryNames = Object.entries(STATE_REGISTRY)
    .filter(([, definition]) => definition.backup)
    .map(([name]) => name)
    .sort();
  const registryFiles = backupEntries().map((entry) => entry.filename).sort();
  const verifyFiles = [...SIDECAR_FILES].sort();
  const inventoryFiles = sidecarFilenames();

  assert.equal(registryNames.length, Object.keys(STATE_REGISTRY).length);
  assert.deepEqual(registryFiles, verifyFiles);
  assert.deepEqual(registryFiles, inventoryFiles);
  assert.equal(registryFiles.length, 28);
});

test('committed backup-state-inventory.json matches STATE_REGISTRY', () => {
  const inventory = assertInventoryMatchesRegistry();
  assert.equal(inventory.storeCount, 28);
});

test('backup-dashboard-runtime.sh derives members from inventory helper', () => {
  const scriptPath = path.resolve(__dirname, '../../ops/bin/backup-dashboard-runtime.sh');
  const script = fs.readFileSync(scriptPath, 'utf8');
  assert.match(script, /list-backup-runtime-members\.js/);
  for (const { filename } of backupEntries()) {
    assert.ok(
      loadBackupStateInventory().stores.some((store) => store.filename === filename),
      `${filename} missing from backup-state-inventory.json`,
    );
  }
});

test('list-backup-runtime-members derives members from inventory', () => {
  const inventory = loadBackupStateInventory();
  assert.equal(inventory.stores.length, 28);
  assert.equal(inventory.auxiliary.receiptsDirectory, 'receipts');
});
