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
const FLAT_LEGACY_REJECT_KEYS = new Set(['schemaVersion', 'accounts']);
const PRESERVED_METADATA_KEYS = new Set([
  'metadata',
  'source',
  'generatedAt',
  'manifest',
  'auditTrail',
  'version',
]);
const ENVELOPE_KEYS = new Set(['schemaVersion', 'accounts', ...PRESERVED_METADATA_KEYS]);
// Actual Budget account ids are UUIDs; demo fixtures use acc-<slug> ids only.
const ACTUAL_ACCOUNT_ID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;
const DEMO_ACCOUNT_ID_RE = /^acc-[a-z0-9]+(?:-[a-z0-9]+)*$/i;

function isPlainObject(value) {
  return !!value && typeof value === 'object' && !Array.isArray(value);
}

function hasOwn(source, field) {
  return Object.prototype.hasOwnProperty.call(source || {}, field);
}

function cloneJson(value) {
  return JSON.parse(JSON.stringify(value));
}

function validAccountId(id) {
  if (typeof id !== 'string') return false;
  return ACTUAL_ACCOUNT_ID_RE.test(id) || DEMO_ACCOUNT_ID_RE.test(id);
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

function copyPreservedMetadata(source, target) {
  for (const key of PRESERVED_METADATA_KEYS) {
    if (!hasOwn(source, key)) continue;
    target[key] = cloneJson(source[key]);
  }
}

function migrateAccountOverrides(value) {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return null;
  if (value.schemaVersion === 2) {
    if (!hasOwn(value, 'accounts')) return null;
    if (!isPlainObject(value.accounts) || Array.isArray(value.accounts)) return null;
    if (!Object.entries(value.accounts).every(([id, entry]) => validAccountId(id) && validEntry(entry))) {
      return null;
    }
    const out = { schemaVersion: 2, accounts: cloneJson(value.accounts) };
    for (const key of Object.keys(value)) {
      if (key === 'schemaVersion' || key === 'accounts') continue;
      if (!PRESERVED_METADATA_KEYS.has(key)) return null;
    }
    copyPreservedMetadata(value, out);
    return out;
  }
  if (hasOwn(value, 'schemaVersion')) {
    if (!Number.isInteger(value.schemaVersion) || value.schemaVersion >= 2) return null;
  }
  if (hasOwn(value, 'accounts')) return null;

  const accounts = {};
  const out = { schemaVersion: 2, accounts };
  for (const [key, entry] of Object.entries(value)) {
    if (FLAT_LEGACY_REJECT_KEYS.has(key)) return null;
    if (PRESERVED_METADATA_KEYS.has(key)) {
      out[key] = cloneJson(entry);
      continue;
    }
    if (!validAccountId(key)) return null;
    if (!validEntry(entry)) return null;
    accounts[key] = entry;
  }
  return out;
}

module.exports = {
  ACTUAL_ACCOUNT_ID_RE,
  DEMO_ACCOUNT_ID_RE,
  ENVELOPE_KEYS,
  ACCOUNT_ROLES,
  ENTRY_KEYS,
  FLAT_LEGACY_REJECT_KEYS,
  PRESERVED_METADATA_KEYS,
  migrateAccountOverrides,
  validAccountId,
  validEntry,
};
