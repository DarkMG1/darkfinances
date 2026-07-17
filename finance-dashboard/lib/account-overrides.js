'use strict';

const { ACCOUNT_ROLES, migrateAccountOverrides } = require('./account-overrides-schema');

function runtimeStore() {
  return require('./runtime-state-store');
}

function resolveAccountOverridesName(file) {
  return runtimeStore().registryNameForPath(file) || 'accountOverrides';
}

function readAccountOverrides(file) {
  const { readRuntimeState } = runtimeStore();
  return readRuntimeState(resolveAccountOverridesName(file), { file }).value;
}

function writeAccountOverrides(file, store) {
  const { writeRuntimeState } = runtimeStore();
  const migrated = migrateAccountOverrides(store);
  if (!migrated) throw new Error('account override state is invalid');
  writeRuntimeState(resolveAccountOverridesName(file), migrated, { file });
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
