'use strict';

const BUNDLE_KIND = 'darkfinances-dashboard-runtime-backup-bundle';
const BUNDLE_SCHEMA_VERSION = 1;
const INVENTORY_SCHEMA_VERSION = 1;
const RUNTIME_ARCHIVE_KIND = 'darkfinances-dashboard-runtime-backup';

const RUNTIME_PREFIX = 'runtime/';
const TOOLING_PREFIX = 'tooling/';
const EMBEDDED_MANIFEST = 'bundle-manifest.json';
const INVENTORY_RELATIVE = 'tooling/ops/lib/backup-state-inventory.json';
const VERIFY_ENTRYPOINT = 'tooling/ops/bin/verify-backup-bundle.js';

const SUPPORTED_NODE_ENGINE = '>=24';
const REQUIRED_BINARIES = Object.freeze(['tar', 'node']);

const SENSITIVE_RUNTIME_BASENAMES = Object.freeze([
  'passkey-credentials.json',
]);

function assertSupportedBundleSchemaVersion(version) {
  if (version !== BUNDLE_SCHEMA_VERSION) {
    throw new Error(`unsupported bundle schemaVersion ${version}`);
  }
}

function assertSupportedInventorySchemaVersion(version) {
  if (version !== INVENTORY_SCHEMA_VERSION) {
    throw new Error(`unsupported inventory schemaVersion ${version}`);
  }
}

module.exports = {
  BUNDLE_KIND,
  BUNDLE_SCHEMA_VERSION,
  INVENTORY_SCHEMA_VERSION,
  RUNTIME_ARCHIVE_KIND,
  RUNTIME_PREFIX,
  TOOLING_PREFIX,
  EMBEDDED_MANIFEST,
  INVENTORY_RELATIVE,
  VERIFY_ENTRYPOINT,
  SUPPORTED_NODE_ENGINE,
  REQUIRED_BINARIES,
  SENSITIVE_RUNTIME_BASENAMES,
  assertSupportedBundleSchemaVersion,
  assertSupportedInventorySchemaVersion,
};
