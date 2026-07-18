'use strict';

/**
 * @typedef {import('@/api/generated/types').MetricValue} MetricValue
 */

/**
 * @typedef {{
 *   value: number | null;
 *   unavailable: boolean;
 *   authoritative: boolean;
 *   reasons: string[];
 * }} ResolvedMoneyMetric
 */

/**
 * @typedef {'wait' | 'clear' | 'push'} WidgetNetWorthAction
 */

/**
 * @typedef {{
 *   action: WidgetNetWorthAction;
 *   reason?: string;
 *   netWorth?: number;
 *   changeDiff?: number | null;
 *   authoritative?: boolean;
 *   incompleteReasons?: string[];
 * }} WidgetNetWorthDecision
 */

/**
 * @param {MetricValue | undefined} metric
 * @returns {boolean}
 */
function hasServerMetric(metric) {
  return metric != null && typeof metric.complete === 'boolean';
}

/**
 * @param {MetricValue | undefined} metric
 * @param {number | null} fallback
 * @returns {ResolvedMoneyMetric}
 */
function resolveMoneyMetric(metric, fallback) {
  if (!hasServerMetric(metric)) {
    return { value: fallback, unavailable: false, authoritative: false, reasons: [] };
  }
  if (metric.complete === true && metric.value != null) {
    return { value: metric.value, unavailable: false, authoritative: true, reasons: [] };
  }
  return {
    value: null,
    unavailable: true,
    authoritative: false,
    reasons: metric.incompleteReasons ?? [],
  };
}

/**
 * @template T
 * @param {T[]} accounts
 * @returns {boolean}
 */
function accountsHaveInclusion(accounts) {
  return accounts.some((account) => account.inclusion != null);
}

/**
 * @param {Array<{ hidden?: boolean; balance: number; inclusion?: { netWorth?: boolean } }>} accounts
 * @param {{ complete?: boolean; assets?: number | null; liabilities?: number | null } | undefined} manual
 * @returns {number}
 */
function computeFallbackNetWorth(accounts, manual) {
  const visible = accounts.filter((account) => !account.hidden);
  const hasInclusion = accountsHaveInclusion(visible);
  const nwAccounts = hasInclusion ? visible.filter((account) => account.inclusion?.netWorth) : visible;
  const acctSum = nwAccounts.reduce((sum, account) => sum + account.balance, 0);
  const manualComplete = manual?.complete !== false;
  const manualAssets = manualComplete ? (manual?.assets ?? 0) : 0;
  const manualLiabilities = manualComplete ? (manual?.liabilities ?? 0) : 0;
  return acctSum + manualAssets - manualLiabilities;
}

/**
 * @param {{
 *   resolved: ResolvedMoneyMetric;
 *   assets: number;
 *   liabilities: number;
 * }} input
 * @returns {{ showAggregates: boolean; unavailableLabel: string | null; assets: number | null; liabilities: number | null }}
 */
function resolveNetWorthAggregateDisplay({ resolved, assets, liabilities }) {
  if (resolved.unavailable) {
    return {
      showAggregates: false,
      unavailableLabel: 'Asset/liability breakdown unavailable',
      assets: null,
      liabilities: null,
    };
  }
  return {
    showAggregates: true,
    unavailableLabel: null,
    assets,
    liabilities,
  };
}

/**
 * @param {{
 *   todayLoading: boolean;
 *   todaySettled: boolean;
 *   todayError: boolean;
 *   profileGeneration: number;
 *   widgetProfileGeneration: number | null;
 *   scope: string;
 *   widgetScope: string | null;
 *   serverMetric?: MetricValue;
 *   accounts?: Array<{ hidden?: boolean; balance: number; inclusion?: { netWorth?: boolean } }> | null;
 *   manual?: { complete?: boolean; assets?: number | null; liabilities?: number | null };
 *   prevTrendNetWorth?: number | null;
 * }} input
 * @returns {WidgetNetWorthDecision}
 */
function resolveWidgetNetWorthDecision(input) {
  const {
    todayLoading,
    todaySettled,
    todayError,
    profileGeneration,
    widgetProfileGeneration,
    scope,
    widgetScope,
    serverMetric,
    accounts,
    manual,
    prevTrendNetWorth = null,
  } = input;

  if (widgetScope != null && scope !== widgetScope) {
    return { action: 'clear', reason: 'profile_scope_changed' };
  }
  if (widgetProfileGeneration != null && widgetProfileGeneration !== profileGeneration) {
    return { action: 'clear', reason: 'profile_generation_changed' };
  }
  if (todayLoading || !todaySettled) {
    return { action: 'wait', reason: 'today_pending' };
  }
  if (todayError) {
    return { action: 'clear', reason: 'today_error' };
  }
  if (!accounts || accounts.length === 0) {
    return { action: 'wait', reason: 'accounts_pending' };
  }

  const fallbackNetWorth = computeFallbackNetWorth(accounts, manual);
  const resolved = resolveMoneyMetric(serverMetric, fallbackNetWorth);
  if (resolved.unavailable) {
    return {
      action: 'clear',
      reason: 'metric_incomplete',
      incompleteReasons: resolved.reasons,
    };
  }

  const netWorth = resolved.authoritative && resolved.value != null
    ? resolved.value
    : (resolved.value ?? fallbackNetWorth);
  if (netWorth == null || !Number.isFinite(netWorth)) {
    return { action: 'wait', reason: 'net_worth_unresolved' };
  }

  const changeDiff = prevTrendNetWorth != null ? netWorth - prevTrendNetWorth : null;
  return {
    action: 'push',
    netWorth,
    changeDiff,
    authoritative: resolved.authoritative,
  };
}

module.exports = {
  accountsHaveInclusion,
  computeFallbackNetWorth,
  hasServerMetric,
  resolveMoneyMetric,
  resolveNetWorthAggregateDisplay,
  resolveWidgetNetWorthDecision,
};
