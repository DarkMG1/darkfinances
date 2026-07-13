'use strict';

const { readJsonFile, writeJsonFile } = require('./json-store');

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

function readAccountOverrides(file) {
  const raw = readJsonFile(file, { schemaVersion: 2, accounts: {} }, (value) => migrateAccountOverrides(value) !== null);
  return migrateAccountOverrides(raw) || { schemaVersion: 2, accounts: {} };
}

function writeAccountOverrides(file, store) {
  const migrated = migrateAccountOverrides(store);
  if (!migrated) throw new Error('account override state is invalid');
  writeJsonFile(file, migrated);
}

function accountsForMetric(accounts, metric) {
  const allowed = metric === 'operating_cash'
    ? new Set(['operating_cash'])
    : metric === 'net_worth'
      ? new Set(['operating_cash', 'protected_savings', 'credit_card', 'loan', 'investment'])
      : new Set();
  return (accounts || []).filter((account) => allowed.has(account.role));
}

module.exports = {
  ACCOUNT_ROLES,
  accountsForMetric,
  migrateAccountOverrides,
  readAccountOverrides,
  writeAccountOverrides,
};
