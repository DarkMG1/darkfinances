'use strict';

const ACCOUNT_ROLES = [
  'operating_cash',
  'protected_savings',
  'credit_card',
  'loan',
  'investment',
  'excluded',
  'unknown',
];
const ROLE_SET = new Set(ACCOUNT_ROLES);
const ENTRY_KEYS = new Set(['name', 'hidden', 'role']);
const FLAT_LEGACY_RESERVED_KEYS = new Set([
  'schemaVersion',
  'accounts',
  'version',
  'metadata',
  'source',
  'generatedAt',
  'manifest',
  'auditTrail',
]);
// Actual account ids are UUIDs; demo and test fixtures use short prefixed ids.
const ACCOUNT_ID_RE = /^(?:[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}|[A-Za-z0-9][A-Za-z0-9._:-]{0,127})$/i;

function isPlainObject(value) {
  return !!value && typeof value === 'object' && !Array.isArray(value);
}

function hasOwn(source, field) {
  return Object.prototype.hasOwnProperty.call(source || {}, field);
}

function validAccountId(id) {
  return typeof id === 'string' && ACCOUNT_ID_RE.test(id);
}

function entryHasOverrideIntent(entry) {
  return entry.name !== undefined || entry.hidden !== undefined || entry.role !== undefined;
}

function validEntry(entry) {
  return entry &&
    typeof entry === 'object' &&
    !Array.isArray(entry) &&
    Object.keys(entry).every((key) => ENTRY_KEYS.has(key)) &&
    (entry.name === undefined || typeof entry.name === 'string') &&
    (entry.hidden === undefined || typeof entry.hidden === 'boolean') &&
    (entry.role === undefined || ROLE_SET.has(entry.role)) &&
    entryHasOverrideIntent(entry);
}

function migrateAccountOverrides(value) {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return null;
  if (value.schemaVersion === 2) {
    if (!hasOwn(value, 'accounts')) return null;
    if (!isPlainObject(value.accounts) || Array.isArray(value.accounts)) return null;
    if (!Object.entries(value.accounts).every(([id, entry]) => validAccountId(id) && validEntry(entry))) {
      return null;
    }
    return { schemaVersion: 2, accounts: value.accounts };
  }
  if (hasOwn(value, 'schemaVersion')) {
    if (!Number.isInteger(value.schemaVersion) || value.schemaVersion >= 2) return null;
  }
  if (hasOwn(value, 'accounts')) return null;
  const accounts = {};
  for (const [key, entry] of Object.entries(value)) {
    if (FLAT_LEGACY_RESERVED_KEYS.has(key)) return null;
    if (!validAccountId(key)) return null;
    if (!validEntry(entry)) return null;
    accounts[key] = entry;
  }
  return { schemaVersion: 2, accounts };
}

module.exports = {
  ACCOUNT_ID_RE,
  ACCOUNT_ROLES,
  ENTRY_KEYS,
  FLAT_LEGACY_RESERVED_KEYS,
  migrateAccountOverrides,
  validAccountId,
  validEntry,
};
