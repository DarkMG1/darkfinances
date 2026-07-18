'use strict';

const { readRuntimeState } = require('./runtime-state-store');
const { readJsonFile } = require('./json-store');

const SPLITWISE_MIRROR_IDENTITY_INVALID = 'splitwise_mirror_identity_invalid';
const SPLITWISE_MIRROR_MIGRATION_REQUIRED = 'splitwise_mirror_migration_required';

function readSagaMirrorAccountId(bulkSagasPath) {
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

function readOwesConfigMirrorAccountId(owesConfigPath) {
  if (!owesConfigPath) return null;
  try {
    const cfg = readJsonFile(owesConfigPath, null);
    if (!cfg || typeof cfg !== 'object') return null;
    const id = cfg.mirrorAccountId ?? cfg.splitwiseMirrorAccountId;
    if (id == null) return null;
    const trimmed = String(id).trim();
    return trimmed || null;
  } catch (_) {
    return null;
  }
}

function findLegacyNameCandidates(accountsRaw, accountName) {
  const normalized = String(accountName || 'Splitwise').toLowerCase();
  return (accountsRaw || [])
    .filter((account) => (account.name || '').toLowerCase() === normalized)
    .map((account) => String(account.id));
}

function resolveSplitwiseMirrorIdentity({
  accountsRaw = [],
  bulkSagasPath = null,
  owesConfigPath = null,
  env = process.env,
  accountName = 'Splitwise',
} = {}) {
  const configuredSources = {
    env: String(env.SPLITWISE_MIRROR_ACCOUNT_ID || '').trim() || null,
    saga: readSagaMirrorAccountId(bulkSagasPath),
    owesConfig: readOwesConfigMirrorAccountId(owesConfigPath),
  };
  const legacyNameCandidates = findLegacyNameCandidates(accountsRaw, accountName);
  const configuredEntries = Object.entries(configuredSources).filter(([, value]) => value);
  const uniqueIds = [...new Set(configuredEntries.map(([, value]) => String(value)))];

  if (uniqueIds.length > 1) {
    return {
      accountId: null,
      status: 'disagreement',
      configuredSources,
      legacyNameCandidates,
      migrationRequired: true,
      incompleteReasons: [SPLITWISE_MIRROR_IDENTITY_INVALID],
    };
  }

  if (uniqueIds.length === 1) {
    const accountId = uniqueIds[0];
    const exists = (accountsRaw || []).some((account) => String(account.id) === accountId);
    if (!exists) {
      return {
        accountId: null,
        status: 'invalid',
        configuredSources,
        legacyNameCandidates,
        migrationRequired: true,
        incompleteReasons: [SPLITWISE_MIRROR_IDENTITY_INVALID],
      };
    }
    return {
      accountId,
      status: 'valid',
      configuredSources,
      legacyNameCandidates,
      migrationRequired: false,
      incompleteReasons: [],
    };
  }

  if (legacyNameCandidates.length > 0) {
    return {
      accountId: null,
      status: 'migration_required',
      configuredSources,
      legacyNameCandidates,
      migrationRequired: true,
      incompleteReasons: [SPLITWISE_MIRROR_MIGRATION_REQUIRED],
    };
  }

  return {
    accountId: null,
    status: 'not_configured',
    configuredSources,
    legacyNameCandidates,
    migrationRequired: false,
    incompleteReasons: [],
  };
}

function isSplitwiseMirrorAccount(accountId, mirrorAccountId) {
  if (!mirrorAccountId || accountId == null) return false;
  return String(accountId) === String(mirrorAccountId);
}

module.exports = {
  SPLITWISE_MIRROR_IDENTITY_INVALID,
  SPLITWISE_MIRROR_MIGRATION_REQUIRED,
  findLegacyNameCandidates,
  isSplitwiseMirrorAccount,
  readOwesConfigMirrorAccountId,
  readSagaMirrorAccountId,
  resolveSplitwiseMirrorIdentity,
};
