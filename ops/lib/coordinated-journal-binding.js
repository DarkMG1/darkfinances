'use strict';

const path = require('path');
const { writerInventoryDigest, loadWriterInventory } = require('./writer-inventory');
const { inventoryDigest, loadBackupStateInventory } = require('./backup-bundle-inventory');
const { journalDigest } = require('./coordinated-run-journal');

function canonicalPath(value) {
  if (!value) return null;
  const fs = require('fs');
  const resolved = path.resolve(value);
  if (fs.existsSync(resolved)) return fs.realpathSync(resolved);
  return resolved;
}

function assertJournalBinding(journal, {
  layout,
  inventory,
  options = {},
}) {
  if (!journal) throw new Error('coordinated journal missing');
  const writers = inventory || loadWriterInventory();
  const expectedWriterDigest = writerInventoryDigest(writers);
  if (journal.inventory?.writerInventoryDigest !== expectedWriterDigest) {
    throw new Error('coordinated journal writer inventory digest mismatch');
  }
  const runtimeInventory = loadBackupStateInventory();
  const expectedRuntimeDigest = inventoryDigest(runtimeInventory);
  if (journal.inventory?.runtimeInventoryDigest !== expectedRuntimeDigest) {
    throw new Error('coordinated journal runtime inventory digest mismatch');
  }
  if (canonicalPath(journal.canonicalRoot) !== canonicalPath(layout.canonicalRoot)) {
    throw new Error('coordinated journal canonical root mismatch');
  }
  const expectedDashboard = canonicalPath(options.dashboardDir || journal.options?.dashboardDir);
  if (canonicalPath(journal.options?.dashboardDir) !== expectedDashboard) {
    throw new Error('coordinated journal dashboardDir mismatch');
  }
  if (journal.options?.includeActualData !== (options.includeActualData === true)) {
    throw new Error('coordinated journal includeActualData mismatch');
  }
  if (journal.options?.preQuiesced !== (options.preQuiesced === true)) {
    throw new Error('coordinated journal preQuiesced mismatch');
  }
}

module.exports = {
  canonicalPath,
  assertJournalBinding,
  writerInventoryDigest,
  journalDigest,
};
