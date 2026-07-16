import type { Query, QueryClient } from '@tanstack/react-query';

export interface FinanceOperationReconciliationSummary {
  checked: number;
  completed: number;
  failed: number;
  unresolved: number;
}

export const FINANCE_QUERY_SCOPE_META_KEY: 'financeServerScope';
export const FOREGROUND_COMPLETION_REFRESH_ERROR_CODE: 'FOREGROUND_COMPLETION_REFRESH_FAILED';

export function isFinanceQueryForScope(query: Query, scope: string): boolean;

export function refreshActiveFinanceQueriesForScope(
  queryClient: QueryClient,
  scope: string,
): Promise<void>;

export function reconcileFinanceOperationsOnForeground(input: {
  reconcile: () => Promise<FinanceOperationReconciliationSummary>;
  refreshCompletedQueries: () => Promise<void>;
  clearDiagnostic: () => void;
  recordDiagnostic: (error: unknown) => void;
}): Promise<FinanceOperationReconciliationSummary | null>;
