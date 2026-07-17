import {
  buildQuery,
  reconcilePendingFinanceOperations,
} from '@/api/client/requests';
import { API_ENDPOINTS } from '@/api/generated/endpoints';
import {
  clearFinanceOperationReconciliationDiagnostic,
  recordFinanceOperationReconciliationError,
} from '@/lib/finance-operations';
import {
  reconcileFinanceOperationsOnForeground,
  refreshActiveFinanceQueriesForScope,
} from '@/lib/foreground-operation-reconciliation';
import { queryClient } from '@/lib/query-client';

export interface ReconnectRefreshConfig {
  scope: string;
  serverUrl: string | null;
  token: string | null;
  demo: boolean;
}

export interface ReconnectRefreshRunToken {
  scope: string;
  profileGeneration: number;
  reason: string;
  id: number;
}

export async function fetchReconnectSourceFreshness(
  config: ReconnectRefreshConfig,
  token: ReconnectRefreshRunToken,
) {
  if (token.scope !== config.scope) {
    const error = new Error('Reconnect refresh scope changed') as Error & { code?: string };
    error.code = 'RECONNECT_REFRESH_STALE';
    throw error;
  }
  return buildQuery({
    serverUrl: config.serverUrl,
    token: config.token,
    demo: config.demo,
    endpoint: API_ENDPOINTS.ping.endpoint,
    method: API_ENDPOINTS.ping.method,
    timeoutMs: 10_000,
  });
}

export async function reconcileReconnectOperations(
  config: ReconnectRefreshConfig,
  token: ReconnectRefreshRunToken,
) {
  if (token.scope !== config.scope) {
    const error = new Error('Reconnect refresh scope changed') as Error & { code?: string };
    error.code = 'RECONNECT_REFRESH_STALE';
    throw error;
  }
  if (config.demo || !config.serverUrl || !config.token) {
    return { checked: 0, completed: 0, failed: 0, unresolved: 0 };
  }
  return reconcileFinanceOperationsOnForeground({
    reconcile: () => reconcilePendingFinanceOperations({
      serverUrl: config.serverUrl,
      token: config.token,
      demo: config.demo,
    }),
    refreshCompletedQueries: async () => {},
    clearDiagnostic: clearFinanceOperationReconciliationDiagnostic,
    recordDiagnostic: recordFinanceOperationReconciliationError,
  }) ?? { checked: 0, completed: 0, failed: 0, unresolved: 0 };
}

export async function refreshReconnectActiveQueries(
  config: ReconnectRefreshConfig,
  token: ReconnectRefreshRunToken,
) {
  if (token.scope !== config.scope) {
    const error = new Error('Reconnect refresh scope changed') as Error & { code?: string };
    error.code = 'RECONNECT_REFRESH_STALE';
    throw error;
  }
  try {
    await refreshActiveFinanceQueriesForScope(queryClient, config.scope);
  } catch (error) {
    const wrapped = Object.assign(new Error('Reconnect refetch failed'), {
      code: 'RECONNECT_REFETCH_FAILED',
      status: Number((error as { status?: number })?.status) || undefined,
    });
    throw wrapped;
  }
}
