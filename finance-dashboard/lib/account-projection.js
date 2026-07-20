'use strict';

const crypto = require('crypto');
const { metricValue } = require('./metric-provenance');
const { fromCents, sumCents } = require('./domain/money');
const {
  isSplitwiseMirrorAccount,
  SPLITWISE_MIRROR_IDENTITY_INVALID,
  SPLITWISE_MIRROR_MIGRATION_REQUIRED,
} = require('./splitwise-mirror-account');
const { MANUAL_ASSETS_UNAVAILABLE } = require('./manual-assets-projection');

const ACCOUNT_METRIC = Object.freeze({
  displayList: 'display_list',
  netWorthLive: 'net_worth_live',
  netWorthHistory: 'net_worth_history',
  operatingCash: 'operating_cash',
  liquidCash: 'liquid_cash',
  forecastCash: 'forecast_cash',
  spendingAttribution: 'spending_attribution',
  obligationGraph: 'obligation_graph',
  goalFeasibility: 'goal_feasibility',
  notificationsCash: 'notifications_cash',
});

const ACCOUNT_PROJECTION_REASON = Object.freeze({
  accountRolesUnassigned: 'account_roles_unassigned',
  netWorthRoleUnknown: 'net_worth_role_unknown',
  operatingCashRoleUnknown: 'operating_cash_role_unknown',
  liquidCashRoleUnknown: 'liquid_cash_role_unknown',
  spendingRoleUnknown: 'spending_role_unknown',
  accountBalanceUnavailable: 'account_balance_unavailable',
  accountIdentityDuplicate: 'account_identity_duplicate',
  manualAssetsUnavailable: MANUAL_ASSETS_UNAVAILABLE,
  splitwiseMirrorIdentityInvalid: SPLITWISE_MIRROR_IDENTITY_INVALID,
  splitwiseMirrorMigrationRequired: SPLITWISE_MIRROR_MIGRATION_REQUIRED,
});

const NET_WORTH_ROLES = new Set([
  'operating_cash',
  'protected_savings',
  'credit_card',
  'loan',
  'investment',
]);
const OPERATING_CASH_ROLES = new Set(['operating_cash']);
const LIQUID_CASH_ROLES = new Set(['operating_cash', 'protected_savings']);
const ROLE_DEPENDENT_METRICS = new Set([
  ACCOUNT_METRIC.netWorthLive,
  ACCOUNT_METRIC.netWorthHistory,
  ACCOUNT_METRIC.operatingCash,
  ACCOUNT_METRIC.liquidCash,
  ACCOUNT_METRIC.forecastCash,
  ACCOUNT_METRIC.spendingAttribution,
  ACCOUNT_METRIC.notificationsCash,
]);
const BALANCE_DEPENDENT_METRICS = new Set([
  ACCOUNT_METRIC.netWorthLive,
  ACCOUNT_METRIC.operatingCash,
  ACCOUNT_METRIC.liquidCash,
  ACCOUNT_METRIC.forecastCash,
]);

function normalizeBalanceCents(value) {
  if (value === null || value === undefined) return { ok: false };
  if (typeof value === 'bigint') return { ok: false };
  if (!Number.isFinite(value)) return { ok: false };
  const cents = typeof value === 'number' && Number.isInteger(value) ? value : Math.round(value);
  if (!Number.isSafeInteger(cents)) return { ok: false };
  return { ok: true, cents };
}

function topologySignature(account) {
  return JSON.stringify({
    id: String(account.id),
    name: account.name ?? '',
    closed: !!account.closed,
    offbudget: !!account.offbudget,
    role: account.role ?? 'unknown',
  });
}

function detectDuplicateAccountTopology(accountsRaw) {
  const byId = new Map();
  for (const account of accountsRaw || []) {
    const id = String(account.id);
    if (!byId.has(id)) byId.set(id, []);
    byId.get(id).push(account);
  }
  const duplicates = [];
  for (const [id, rows] of byId) {
    if (rows.length <= 1) continue;
    const canonical = topologySignature(rows[0]);
    duplicates.push({
      id,
      count: rows.length,
      conflicting: rows.some((row) => topologySignature(row) !== canonical),
    });
  }
  return duplicates;
}

function detectDuplicateAccountIds(accountsRaw) {
  return detectDuplicateAccountTopology(accountsRaw).map((entry) => entry.id);
}

function firstOccurrenceAccounts(accountsRaw, duplicateAccountIds = []) {
  const duplicateIds = new Set(duplicateAccountIds);
  const seen = new Set();
  return (accountsRaw || []).filter((account) => {
    const id = String(account.id);
    if (!duplicateIds.has(id)) return true;
    if (seen.has(id)) return false;
    seen.add(id);
    return true;
  });
}

function effectiveRole(rawAccount, override) {
  if (override?.role) return override.role;
  if (rawAccount?.role && rawAccount.role !== 'unknown') return rawAccount.role;
  return 'unknown';
}

function displayNameForAccount(rawAccount, override) {
  const trimmed = typeof override?.name === 'string' ? override.name.trim() : '';
  return trimmed || rawAccount.name || rawAccount.id;
}

function enrichAccountRow(rawAccount, {
  override = {},
  balanceCents = null,
  balanceUnavailable = false,
  splitwiseMirrorAccountId = null,
} = {}) {
  const role = effectiveRole(rawAccount, override);
  const hidden = !!override.hidden;
  const splitwiseMirror = isSplitwiseMirrorAccount(rawAccount.id, splitwiseMirrorAccountId);
  return {
    id: rawAccount.id,
    actualName: rawAccount.name || rawAccount.id,
    name: displayNameForAccount(rawAccount, override),
    offbudget: !!rawAccount.offbudget,
    closed: !!rawAccount.closed,
    balance: Number.isSafeInteger(balanceCents) ? fromCents(balanceCents) : null,
    balanceCents: Number.isSafeInteger(balanceCents) ? balanceCents : null,
    balanceUnavailable,
    hidden,
    role,
    roleSource: override?.role ? 'explicit' : (rawAccount?.role && rawAccount.role !== 'unknown' ? 'explicit' : 'unknown'),
    splitwiseMirror,
    excludedRole: role === 'excluded',
  };
}

function metricNeedsRoleAssignment(metric) {
  return ROLE_DEPENDENT_METRICS.has(metric);
}

function isDecisionExcluded(row) {
  return row.hidden || row.excludedRole;
}

function unknownRoleBlocksMetric(metric, row) {
  if (row.role !== 'unknown') return false;
  if (row.closed && metric === ACCOUNT_METRIC.netWorthHistory) return false;
  if (metric === ACCOUNT_METRIC.netWorthLive || metric === ACCOUNT_METRIC.netWorthHistory) {
    return !row.closed && !isDecisionExcluded(row) && !row.splitwiseMirror;
  }
  if (metric === ACCOUNT_METRIC.operatingCash || metric === ACCOUNT_METRIC.forecastCash) {
    return !row.closed && !row.hidden;
  }
  if (metric === ACCOUNT_METRIC.liquidCash) {
    return !row.closed && !row.hidden;
  }
  if (metric === ACCOUNT_METRIC.spendingAttribution) {
    return !row.closed && !row.offbudget && !isDecisionExcluded(row);
  }
  if (metric === ACCOUNT_METRIC.notificationsCash) {
    return !row.closed && !row.hidden && !row.offbudget;
  }
  return false;
}

function unknownReasonForMetric(metric) {
  switch (metric) {
    case ACCOUNT_METRIC.netWorthLive:
    case ACCOUNT_METRIC.netWorthHistory:
      return ACCOUNT_PROJECTION_REASON.netWorthRoleUnknown;
    case ACCOUNT_METRIC.operatingCash:
    case ACCOUNT_METRIC.forecastCash:
      return ACCOUNT_PROJECTION_REASON.operatingCashRoleUnknown;
    case ACCOUNT_METRIC.liquidCash:
      return ACCOUNT_PROJECTION_REASON.liquidCashRoleUnknown;
    case ACCOUNT_METRIC.spendingAttribution:
      return ACCOUNT_PROJECTION_REASON.spendingRoleUnknown;
    default:
      return ACCOUNT_PROJECTION_REASON.accountRolesUnassigned;
  }
}

function splitwiseReasonsForMetric(metric, splitwiseMirrorIdentity) {
  if (!splitwiseMirrorIdentity || !metricNeedsRoleAssignment(metric)) return [];
  if (Array.isArray(splitwiseMirrorIdentity.incompleteReasons) && splitwiseMirrorIdentity.incompleteReasons.length) {
    return [...splitwiseMirrorIdentity.incompleteReasons];
  }
  if (splitwiseMirrorIdentity.migrationRequired && (splitwiseMirrorIdentity.legacyNameCandidates || []).length) {
    return [ACCOUNT_PROJECTION_REASON.splitwiseMirrorMigrationRequired];
  }
  return [];
}

function includeForMetric(metric, row) {
  if (row.splitwiseMirror) {
    return metric === ACCOUNT_METRIC.spendingAttribution
      && !row.closed
      && !row.offbudget;
  }

  switch (metric) {
    case ACCOUNT_METRIC.displayList:
      return !row.closed && !row.splitwiseMirror;
    case ACCOUNT_METRIC.netWorthLive:
      return !row.closed
        && !isDecisionExcluded(row)
        && NET_WORTH_ROLES.has(row.role);
    case ACCOUNT_METRIC.netWorthHistory:
      return !isDecisionExcluded(row)
        && NET_WORTH_ROLES.has(row.role);
    case ACCOUNT_METRIC.operatingCash:
    case ACCOUNT_METRIC.forecastCash:
      return !row.closed
        && !row.hidden
        && OPERATING_CASH_ROLES.has(row.role);
    case ACCOUNT_METRIC.liquidCash:
      return !row.closed
        && !row.hidden
        && LIQUID_CASH_ROLES.has(row.role);
    case ACCOUNT_METRIC.spendingAttribution:
      return !row.closed
        && !row.offbudget
        && !isDecisionExcluded(row);
    case ACCOUNT_METRIC.obligationGraph:
      return !row.closed && !isDecisionExcluded(row);
    case ACCOUNT_METRIC.goalFeasibility:
      return !row.closed;
    case ACCOUNT_METRIC.notificationsCash:
      return !row.closed
        && !row.hidden
        && !row.offbudget
        && OPERATING_CASH_ROLES.has(row.role);
    default:
      return false;
  }
}

function visibleForMetric(metric, row) {
  if (metric === ACCOUNT_METRIC.displayList) return !row.hidden;
  if (metric === ACCOUNT_METRIC.goalFeasibility) return true;
  return includeForMetric(metric, row);
}

function buildInclusionFlags(row) {
  return {
    netWorth: includeForMetric(ACCOUNT_METRIC.netWorthLive, row),
    operatingCash: includeForMetric(ACCOUNT_METRIC.operatingCash, row),
    liquidCash: includeForMetric(ACCOUNT_METRIC.liquidCash, row),
    spending: includeForMetric(ACCOUNT_METRIC.spendingAttribution, row),
    obligations: includeForMetric(ACCOUNT_METRIC.obligationGraph, row),
    forecast: includeForMetric(ACCOUNT_METRIC.forecastCash, row),
  };
}

function accountProjectionRevision({
  overrides = {},
  accountsRaw = [],
  balancesById = {},
  splitwiseMirrorAccountId = null,
  splitwiseMirrorIdentity = null,
} = {}) {
  const payload = {
    overrides,
    accounts: (accountsRaw || []).map((account) => ({
      id: account.id,
      closed: !!account.closed,
      offbudget: !!account.offbudget,
      balanceCents: balancesById[account.id] ?? null,
    })).sort((a, b) => a.id.localeCompare(b.id)),
    splitwiseMirrorAccountId,
    splitwiseMirrorIdentity: splitwiseMirrorIdentity ? {
      status: splitwiseMirrorIdentity.status,
      accountId: splitwiseMirrorIdentity.accountId,
      configuredSources: splitwiseMirrorIdentity.configuredSources,
    } : null,
  };
  return crypto.createHash('sha256').update(JSON.stringify(payload)).digest('hex').slice(0, 16);
}

function projectAccounts({
  accountsRaw = [],
  balancesById = {},
  balanceUnavailableIds = new Set(),
  duplicateAccountIds = [],
  overrides = {},
  metric,
  splitwiseMirrorAccountId = null,
  splitwiseMirrorIdentity = null,
  financeDate = null,
} = {}) {
  if (!metric) throw new Error('metric required');

  const duplicateIds = new Set(duplicateAccountIds || []);
  const unavailableIds = balanceUnavailableIds instanceof Set
    ? balanceUnavailableIds
    : new Set(balanceUnavailableIds || []);
  const sourceAccounts = firstOccurrenceAccounts(accountsRaw, [...duplicateIds]);

  const accounts = sourceAccounts.map((rawAccount) => {
    const override = overrides[rawAccount.id] || {};
    const balanceCents = balancesById[rawAccount.id];
    const balanceUnavailable = unavailableIds.has(rawAccount.id)
      || !Number.isSafeInteger(balanceCents);
    return enrichAccountRow(rawAccount, {
      override,
      balanceCents: Number.isSafeInteger(balanceCents) ? balanceCents : null,
      balanceUnavailable,
      splitwiseMirrorAccountId,
    });
  });

  const incompleteReasons = [];
  if (duplicateIds.size && metricNeedsRoleAssignment(metric)) {
    incompleteReasons.push(ACCOUNT_PROJECTION_REASON.accountIdentityDuplicate);
  }
  for (const reason of splitwiseReasonsForMetric(metric, splitwiseMirrorIdentity)) {
    if (!incompleteReasons.includes(reason)) incompleteReasons.push(reason);
  }
  if (metricNeedsRoleAssignment(metric)) {
    for (const row of accounts) {
      if (unknownRoleBlocksMetric(metric, row)) {
        const reason = unknownReasonForMetric(metric);
        if (!incompleteReasons.includes(reason)) incompleteReasons.push(reason);
      }
    }
  }

  const includedIds = new Set();
  const visibleIds = new Set();
  const excludedReasons = {};
  for (const row of accounts) {
    if (includeForMetric(metric, row)) includedIds.add(row.id);
    if (visibleForMetric(metric, row)) visibleIds.add(row.id);
    if (row.hidden) excludedReasons[row.id] = 'hidden';
    else if (row.excludedRole) excludedReasons[row.id] = 'excluded';
    else if (row.splitwiseMirror && metric !== ACCOUNT_METRIC.spendingAttribution) {
      excludedReasons[row.id] = 'splitwise_mirror';
    } else if (row.closed && metric === ACCOUNT_METRIC.netWorthLive) {
      excludedReasons[row.id] = 'closed';
    }
  }

  if (BALANCE_DEPENDENT_METRICS.has(metric)) {
    for (const row of accounts) {
      if (includedIds.has(row.id) && !Number.isSafeInteger(row.balanceCents)) {
        if (!incompleteReasons.includes(ACCOUNT_PROJECTION_REASON.accountBalanceUnavailable)) {
          incompleteReasons.push(ACCOUNT_PROJECTION_REASON.accountBalanceUnavailable);
        }
        break;
      }
    }
  }

  const displayNameById = Object.fromEntries(
    accounts.map((row) => [row.id, row.name]),
  );

  const revision = accountProjectionRevision({
    overrides,
    accountsRaw,
    balancesById,
    splitwiseMirrorAccountId,
    splitwiseMirrorIdentity,
  });

  const scope = {
    metric,
    financeDate,
    splitwiseMirrorAccountId,
    splitwiseMirrorIdentity: splitwiseMirrorIdentity ? {
      status: splitwiseMirrorIdentity.status,
      configuredSources: splitwiseMirrorIdentity.configuredSources,
      legacyNameCandidates: splitwiseMirrorIdentity.legacyNameCandidates || [],
      migrationRequired: !!splitwiseMirrorIdentity.migrationRequired,
    } : null,
    splitwiseMirrorResolvedBy: splitwiseMirrorAccountId ? 'configured_identity' : 'none',
    duplicateAccountIds: [...duplicateIds],
    includesClosedAccountHistory: metric === ACCOUNT_METRIC.netWorthHistory,
    excludedHiddenAccounts: true,
    excludedRoles: ['excluded'],
  };

  return {
    accounts,
    includedIds,
    visibleIds,
    excludedReasons,
    incompleteReasons,
    revision,
    scope,
    displayNameById,
    splitwiseMirrorAccountId,
    splitwiseMirrorIdentity,
    duplicateAccountIds: [...duplicateIds],
    accountFilter: (rawAccount) => includedIds.has(rawAccount.id),
    ledgerAccountFilter: (rawAccount) => includedIds.has(rawAccount.id),
  };
}

function sumIncludedBalanceCents(projection) {
  return sumCents(
    projection.accounts
      .filter((row) => projection.includedIds.has(row.id))
      .map((row) => {
        if (!Number.isSafeInteger(row.balanceCents)) {
          throw new Error('sumIncludedBalanceCents requires complete balances');
        }
        return row.balanceCents;
      }),
  );
}

function buildNetWorthMetric({
  projection,
  manualAssets = { complete: true, assets: 0, liabilities: 0, assetCents: 0, liabilityCents: 0 },
  asOf,
  financeDate,
  metric = 'net_worth',
} = {}) {
  const incompleteReasons = [...(projection.incompleteReasons || [])];
  if (manualAssets?.complete === false) {
    for (const reason of manualAssets.incompleteReasons || [ACCOUNT_PROJECTION_REASON.manualAssetsUnavailable]) {
      if (!incompleteReasons.includes(reason)) incompleteReasons.push(reason);
    }
  }
  if (incompleteReasons.length > 0) {
    return metricValue({
      metric,
      value: null,
      valueCents: null,
      complete: false,
      incompleteReasons,
      asOf,
      financeDate,
      sources: [],
      method: 'account-projection',
      excludes: ['hidden accounts', 'excluded roles', 'splitwise mirror ledger'],
    });
  }

  const ledgerCents = sumIncludedBalanceCents(projection);
  const assetCents = manualAssets.assetCents ?? 0;
  const liabilityCents = manualAssets.liabilityCents ?? 0;
  const totalCents = sumCents([ledgerCents, assetCents, -liabilityCents]);
  const sources = projection.accounts
    .filter((row) => projection.includedIds.has(row.id))
    .map((row) => ({ type: 'actual-account', id: row.id, role: row.role }));

  if (assetCents > 0) sources.push({ type: 'manual-assets', id: 'manual-assets' });
  if (liabilityCents > 0) sources.push({ type: 'manual-liabilities', id: 'manual-liabilities' });

  return metricValue({
    metric,
    value: fromCents(totalCents),
    valueCents: totalCents,
    complete: true,
    asOf,
    financeDate,
    sources,
    method: 'account-projection',
    excludes: ['hidden accounts', 'excluded roles', 'splitwise mirror ledger'],
  });
}

function buildBalanceMetric({
  projection,
  metric,
  asOf,
  financeDate,
} = {}) {
  const incompleteReasons = [...(projection.incompleteReasons || [])];
  if (incompleteReasons.length > 0) {
    return metricValue({
      metric,
      value: null,
      valueCents: null,
      complete: false,
      incompleteReasons,
      asOf,
      financeDate,
      sources: [],
      method: 'account-projection',
      excludes: [],
    });
  }
  const totalCents = sumIncludedBalanceCents(projection);
  return metricValue({
    metric,
    value: fromCents(totalCents),
    valueCents: totalCents,
    complete: true,
    asOf,
    financeDate,
    sources: projection.accounts
      .filter((row) => projection.includedIds.has(row.id))
      .map((row) => ({ type: 'actual-account', id: row.id, role: row.role })),
    method: 'account-projection',
    excludes: metric === ACCOUNT_METRIC.liquidCash
      ? ['credit availability', 'investments']
      : ['protected savings', 'credit availability', 'investments'],
  });
}

function attachInclusionToAccountRow(row, creditExtras = {}) {
  const inclusion = buildInclusionFlags(row);
  return {
    id: row.id,
    name: row.name,
    offbudget: row.offbudget,
    balance: row.balance,
    hidden: row.hidden,
    role: row.role,
    roleSource: row.roleSource,
    inclusion,
    ...creditExtras,
  };
}

module.exports = {
  ACCOUNT_METRIC,
  ACCOUNT_PROJECTION_REASON,
  LIQUID_CASH_ROLES,
  NET_WORTH_ROLES,
  OPERATING_CASH_ROLES,
  accountProjectionRevision,
  attachInclusionToAccountRow,
  buildBalanceMetric,
  buildNetWorthMetric,
  detectDuplicateAccountIds,
  detectDuplicateAccountTopology,
  displayNameForAccount,
  enrichAccountRow,
  includeForMetric,
  normalizeBalanceCents,
  projectAccounts,
  sumIncludedBalanceCents,
};
