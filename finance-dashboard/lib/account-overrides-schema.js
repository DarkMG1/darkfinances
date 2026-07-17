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

function validEntry(entry) {
  return entry &&
    typeof entry === 'object' &&
    !Array.isArray(entry) &&
    (entry.name === undefined || typeof entry.name === 'string') &&
    (entry.hidden === undefined || typeof entry.hidden === 'boolean') &&
    (entry.role === undefined || ROLE_SET.has(entry.role));
}

function migrateAccountOverrides(value) {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return null;
  if (value.schemaVersion === 2) {
    if (!value.accounts || typeof value.accounts !== 'object' || Array.isArray(value.accounts)) return null;
    if (!Object.values(value.accounts).every(validEntry)) return null;
    return { schemaVersion: 2, accounts: value.accounts };
  }
  if (!Object.values(value).every(validEntry)) return null;
  return { schemaVersion: 2, accounts: value };
}

module.exports = {
  ACCOUNT_ROLES,
  migrateAccountOverrides,
  validEntry,
};
