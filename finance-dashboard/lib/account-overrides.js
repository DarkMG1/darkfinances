'use strict';

const {
  ACCOUNT_METRIC,
  LIQUID_CASH_ROLES,
  NET_WORTH_ROLES,
  OPERATING_CASH_ROLES,
} = require('./account-projection');
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

function roleSetForMetric(metric) {
  switch (metric) {
    case 'operating_cash':
    case ACCOUNT_METRIC.operatingCash:
    case ACCOUNT_METRIC.forecastCash:
      return OPERATING_CASH_ROLES;
    case 'liquid_cash':
    case ACCOUNT_METRIC.liquidCash:
      return LIQUID_CASH_ROLES;
    case 'net_worth':
    case ACCOUNT_METRIC.netWorthLive:
    case ACCOUNT_METRIC.netWorthHistory:
      return NET_WORTH_ROLES;
    default:
      return new Set();
  }
}

function accountsForMetric(accounts, metric) {
  const allowed = roleSetForMetric(metric);
  if (!allowed.size) return [];
  return (accounts || []).filter((account) => allowed.has(account.role));
}

module.exports = {
  ACCOUNT_ROLES,
  accountsForMetric,
  migrateAccountOverrides,
  readAccountOverrides,
  roleSetForMetric,
  writeAccountOverrides,
};
