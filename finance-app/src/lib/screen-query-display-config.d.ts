import type { RefetchQueryEntry } from '@/components/query-display';

type RefetchCtx = Record<string, RefetchQueryEntry | boolean | { netWorth: boolean; subscriptions: boolean }>;

export const PRIMARY_QUERY_GATE_ORDER: readonly string[];

export function buildHomeRefetchQueries(ctx: {
  today: RefetchQueryEntry;
  trends: RefetchQueryEntry;
  manual: RefetchQueryEntry;
  recurring: RefetchQueryEntry;
  widgets: { netWorth: boolean; subscriptions: boolean };
}): RefetchQueryEntry[];

export function buildSpendingRefetchQueries(ctx: {
  spendingQuery: RefetchQueryEntry;
  trends: RefetchQueryEntry;
  budgets: RefetchQueryEntry;
  reimb: RefetchQueryEntry;
  insights: RefetchQueryEntry;
  tags: RefetchQueryEntry;
}): RefetchQueryEntry[];

export function buildActivityRefetchQueries(ctx: {
  listQuery: RefetchQueryEntry;
  accounts: RefetchQueryEntry;
  categories: RefetchQueryEntry;
  events: RefetchQueryEntry;
  groupEvents: boolean;
  searching: boolean;
}): RefetchQueryEntry[];

export function buildGoalsRefetchQueries(ctx: {
  goals: RefetchQueryEntry;
  accounts: RefetchQueryEntry;
}): RefetchQueryEntry[];

export function buildRulesRefetchQueries(ctx: {
  rules: RefetchQueryEntry;
  categories: RefetchQueryEntry;
}): RefetchQueryEntry[];

export function buildBudgetsRefetchQueries(ctx: {
  budgets: RefetchQueryEntry;
  trends: RefetchQueryEntry;
}): RefetchQueryEntry[];

export function buildNetworthRefetchQueries(ctx: {
  accounts: RefetchQueryEntry;
  today: RefetchQueryEntry;
  trends: RefetchQueryEntry;
  manual: RefetchQueryEntry;
}): RefetchQueryEntry[];

export function buildReimbursementRefetchQueries(ctx: {
  reimb: RefetchQueryEntry;
  suggestions: RefetchQueryEntry;
}): RefetchQueryEntry[];

export function buildAddTransactionRefetchQueries(ctx: {
  accounts: RefetchQueryEntry;
  categories: RefetchQueryEntry;
}): RefetchQueryEntry[];

export const COMPOUND_SCREEN_QUERY_CONTRACTS: Record<string, {
  file: string;
  primaryQuery: string;
  gateOrder: readonly string[];
  buildRefetchQueries: (...args: unknown[]) => RefetchQueryEntry[];
  refetchMemberKeys: string[];
  enableConditions: Record<string, string>;
  categoriesOptional?: boolean;
}>;
