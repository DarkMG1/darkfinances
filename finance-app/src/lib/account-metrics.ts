export type ResolvedMoneyMetric = {
  value: number | null;
  unavailable: boolean;
  authoritative: boolean;
  reasons: string[];
};

export type WidgetNetWorthAction = 'wait' | 'clear' | 'push';

export type WidgetNetWorthDecision = {
  action: WidgetNetWorthAction;
  reason?: string;
  netWorth?: number;
  changeDiff?: number | null;
  authoritative?: boolean;
  incompleteReasons?: string[];
};

export type NetWorthAggregateDisplay = {
  showAggregates: boolean;
  unavailableLabel: string | null;
  assets: number | null;
  liabilities: number | null;
};

export {
  accountsHaveInclusion,
  computeFallbackNetWorth,
  hasServerMetric,
  resolveMoneyMetric,
  resolveNetWorthAggregateDisplay,
  resolveWidgetNetWorthDecision,
} from './account-metrics-core.js';
