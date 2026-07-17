import * as FileSystem from 'expo-file-system/legacy';
import {
  clearFinanceOperationReconciliationDiagnostic,
  prepareFinanceOperationProfilePurge,
} from '@/lib/finance-operations';
import { purgeNotificationProfileState } from '@/lib/notifications';
import { purgeProfileGeneration } from '@/lib/notification-reconciliation';
import { abortFinanceRequests } from '@/lib/request-lifecycle';
import { clearFinanceQueries, queryClient } from '@/lib/query-client';
import { clearFinanceWidget } from '@/lib/widgets';

const RECEIPT_DIR = (FileSystem.documentDirectory ?? '') + 'receipts/';

export async function purgeReceiptCache(): Promise<void> {
  try {
    await FileSystem.deleteAsync(RECEIPT_DIR, { idempotent: true });
  } catch {
    /* best effort */
  }
}

export async function purgeFinanceProfile(
  scope: string | undefined,
  operationScope: string | null,
): Promise<void> {
  prepareFinanceOperationProfilePurge(operationScope);
  purgeProfileGeneration(scope);
  abortFinanceRequests();
  await clearFinanceQueries();
  queryClient.getMutationCache().clear();
  await purgeNotificationProfileState(scope).catch(() => {});
  clearFinanceWidget();
  await purgeReceiptCache();
  clearFinanceOperationReconciliationDiagnostic();
}
