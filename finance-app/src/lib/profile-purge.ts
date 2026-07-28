import * as FileSystem from 'expo-file-system/legacy';
import {
  clearFinanceOperationReconciliationDiagnostic,
  prepareFinanceOperationProfilePurge,
} from '@/lib/finance-operations';
import { purgeOtaProfileState } from '@/lib/auto-update';
import { mutationOutcomeHaptics } from '@/lib/haptics';
import { purgeMutationFormDrafts } from '@/lib/mutation-form-draft-store';
import { purgeNotificationProfileState } from '@/lib/notifications';
import { purgeProfileGeneration } from '@/lib/notification-reconciliation';
import { purgeReceiptImageCaches } from '@/lib/receipt-image-cache';
import { purgeReconnectRefreshProfileState } from '@/lib/reconnect-refresh-registry';
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
  await purgeReceiptImageCaches();
  prepareFinanceOperationProfilePurge(operationScope);
  purgeMutationFormDrafts(operationScope ?? undefined);
  purgeProfileGeneration(scope);
  purgeReconnectRefreshProfileState(scope);
  purgeOtaProfileState();
  if (operationScope) mutationOutcomeHaptics.purgeScope(operationScope);
  abortFinanceRequests();
  await clearFinanceQueries();
  queryClient.getMutationCache().clear();
  await purgeNotificationProfileState(scope).catch(() => {});
  clearFinanceWidget();
  await purgeReceiptCache();
  clearFinanceOperationReconciliationDiagnostic();
}
