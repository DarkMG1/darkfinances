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

export function accountsHaveInclusion<T extends { inclusion?: unknown }>(accounts: T[]): boolean {
  return accounts.some((account) => account.inclusion != null);
}
