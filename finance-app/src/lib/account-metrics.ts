import type { MetricValue } from '@/api/generated/types';

export type ResolvedMoneyMetric = {
  value: number | null;
  unavailable: boolean;
  authoritative: boolean;
  reasons: string[];
};

export function hasServerMetric(metric: MetricValue | undefined): boolean {
  return metric != null && typeof metric.complete === 'boolean';
}

export function resolveMoneyMetric(
  metric: MetricValue | undefined,
  fallback: number | null,
): ResolvedMoneyMetric {
  if (!hasServerMetric(metric)) {
    return { value: fallback, unavailable: false, authoritative: false, reasons: [] };
  }
  if (metric!.complete === true && metric!.value != null) {
    return { value: metric!.value!, unavailable: false, authoritative: true, reasons: [] };
  }
  return {
    value: null,
    unavailable: true,
    authoritative: false,
    reasons: metric!.incompleteReasons ?? [],
  };
}

export function computeFallbackNetWorth(
  accounts: Array<{ hidden?: boolean; balance: number; inclusion?: { netWorth?: boolean } }>,
  manual?: { complete?: boolean; assets?: number | null; liabilities?: number | null },
): number {
  const visible = accounts.filter((account) => !account.hidden);
  const hasInclusion = accountsHaveInclusion(visible);
  const nwAccounts = hasInclusion ? visible.filter((account) => account.inclusion?.netWorth) : visible;
  const acctSum = nwAccounts.reduce((sum, account) => sum + account.balance, 0);
  const manualComplete = manual?.complete !== false;
  const manualAssets = manualComplete ? (manual?.assets ?? 0) : 0;
  const manualLiabilities = manualComplete ? (manual?.liabilities ?? 0) : 0;
  return acctSum + manualAssets - manualLiabilities;
}

export function accountsHaveInclusion<T extends { inclusion?: unknown }>(accounts: T[]): boolean {
  return accounts.some((account) => account.inclusion != null);
}
