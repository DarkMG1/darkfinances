'use strict';

const { readRuntimeState } = require('./runtime-state-store');

function resolveConfiguredSplitwiseMirrorAccountId({
  bulkSagasPath,
  env = process.env,
} = {}) {
  const configured = String(env.SPLITWISE_MIRROR_ACCOUNT_ID || '').trim();
  if (configured) return configured;

  if (!bulkSagasPath) return null;
  try {
    const state = readRuntimeState('bulkOperationSagas', { file: bulkSagasPath }).value;
    const sagas = state?.sagas && typeof state.sagas === 'object'
      ? Object.values(state.sagas)
      : Object.values(state || {}).filter((entry) => entry && typeof entry === 'object' && entry.kind === 'splitwise_mirror');
    let latest = null;
    let latestAt = 0;
    for (const saga of sagas) {
      const accountId = saga?.mirrorRuntime?.accountId;
      if (!accountId) continue;
      const updatedAt = Date.parse(saga.updatedAt || saga.createdAt || '') || 0;
      if (updatedAt >= latestAt) {
        latestAt = updatedAt;
        latest = String(accountId);
      }
    }
    return latest;
  } catch (_) {
    return null;
  }
}

function isSplitwiseMirrorAccount(accountId, mirrorAccountId) {
  if (!mirrorAccountId || accountId == null) return false;
  return String(accountId) === String(mirrorAccountId);
}

function resolveSplitwiseMirrorAccountId({
  accountsRaw = [],
  configuredAccountId = null,
  accountName = 'Splitwise',
} = {}) {
  if (configuredAccountId) return configuredAccountId;
  const normalized = String(accountName || 'Splitwise').toLowerCase();
  const matches = (accountsRaw || []).filter(
    (account) => (account.name || '').toLowerCase() === normalized,
  );
  if (matches.length === 1) return String(matches[0].id);
  return null;
}

module.exports = {
  isSplitwiseMirrorAccount,
  resolveConfiguredSplitwiseMirrorAccountId,
  resolveSplitwiseMirrorAccountId,
};
