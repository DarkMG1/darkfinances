import { AppState, Platform } from 'react-native';
import Constants from 'expo-constants';
import * as Updates from 'expo-updates';
import { getServerBaseUrl } from '@/api/client/server-url';
import { getFinanceOperationReconciliationDiagnostic } from '@/lib/finance-operations';
import { queryClient } from '@/lib/query-client';

export function buildRedactedDiagnostics(input: {
  serverUrl: string | null;
  demo: boolean;
  faceId: boolean;
}) {
  let serverHost = 'not-configured';
  try { serverHost = new URL(getServerBaseUrl(input.serverUrl)).host; } catch {}
  const now = Date.now();
  const queries = queryClient.getQueryCache().getAll().map((query) => ({
    key: String(query.queryKey[0] ?? 'unknown'),
    status: query.state.status,
    fetchStatus: query.state.fetchStatus,
    ageSeconds: query.state.dataUpdatedAt ? Math.max(0, Math.round((now - query.state.dataUpdatedAt) / 1000)) : null,
    errorCode: (query.state.error as { code?: string; status?: number } | null)?.code ??
      (query.state.error as { status?: number } | null)?.status ??
      null,
  }));
  return {
    generatedAt: new Date().toISOString(),
    app: {
      version: Constants.expoConfig?.version ?? 'unknown',
      nativeBuild: Constants.nativeBuildVersion ?? 'unknown',
      runtimeVersion: Updates.runtimeVersion ?? 'unknown',
      updateChannel: Updates.channel ?? 'development',
    },
    device: {
      platform: Platform.OS,
      platformVersion: Platform.Version,
      appState: AppState.currentState,
    },
    configuration: {
      serverHost,
      demo: input.demo,
      faceId: input.faceId,
    },
    queries,
    operationReconciliation: getFinanceOperationReconciliationDiagnostic(),
  };
}
