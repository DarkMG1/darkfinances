'use strict';

const crypto = require('crypto');
const { metricValue } = require('./metric-provenance');
const { fromCents, sumCents, toCents } = require('./domain/money');
const { isSplitwiseMirrorAccount } = require('./splitwise-mirror-account');

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
  balanceCents,
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
    balance: fromCents(balanceCents),
    balanceCents,
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
  };
  return crypto.createHash('sha256').update(JSON.stringify(payload)).digest('hex').slice(0, 16);
}

function projectAccounts({
  accountsRaw = [],
  balancesById = {},
  overrides = {},
  metric,
  splitwiseMirrorAccountId = null,
  financeDate = null,
} = {}) {
  if (!metric) throw new Error('metric required');

  const accounts = (accountsRaw || []).map((rawAccount) => {
    const override = overrides[rawAccount.id] || {};
    const balanceCents = Number.isSafeInteger(balancesById[rawAccount.id])
      ? balancesById[rawAccount.id]
      : Math.round(Number(rawAccount.balance || 0));
    return enrichAccountRow(rawAccount, {
      override,
      balanceCents,
      splitwiseMirrorAccountId,
    });
  });

  const incompleteReasons = [];
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

  const displayNameById = Object.fromEntries(
    accounts.map((row) => [row.id, row.name]),
  );

  const revision = accountProjectionRevision({
    overrides,
    accountsRaw,
    balancesById,
    splitwiseMirrorAccountId,
  });

  const scope = {
    metric,
    financeDate,
    splitwiseMirrorAccountId,
    splitwiseMirrorResolvedBy: splitwiseMirrorAccountId ? 'configured_identity' : 'none',
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
    accountFilter: (rawAccount) => includedIds.has(rawAccount.id),
    ledgerAccountFilter: (rawAccount) => includedIds.has(rawAccount.id),
  };
}

function sumIncludedBalanceCents(projection) {
  return sumCents(
    projection.accounts
      .filter((row) => projection.includedIds.has(row.id))
      .map((row) => row.balanceCents),
  );
}

function buildNetWorthMetric({
  projection,
  manualAssets = { assets: 0, liabilities: 0 },
  asOf,
  financeDate,
  metric = 'net_worth',
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
      excludes: ['hidden accounts', 'excluded roles', 'splitwise mirror ledger'],
    });
  }

  const ledgerCents = sumIncludedBalanceCents(projection);
  const assetCents = toCents(Number(manualAssets.assets) || 0);
  const liabilityCents = toCents(Number(manualAssets.liabilities) || 0);
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
  displayNameForAccount,
  enrichAccountRow,
  includeForMetric,
  projectAccounts,
  sumIncludedBalanceCents,
};
