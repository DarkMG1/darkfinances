import type { CategoryScheduleState } from '@/lib/notification-scheduled-stage';
import type { ConfirmCancelScheduledIdsResult } from '@/lib/notification-scheduled-cancel';
import type { NotificationReconciliationToken } from '@/lib/notification-reconciliation';

export interface ReplaceCategorySchedulesResult {
  newIds: string[];
  incompleteCleanup: boolean;
}

export interface ConvergeCategoryResult {
  state: CategoryScheduleState;
  incomplete: boolean;
}

export interface CategoryScheduleReplacer {
  replaceCategorySchedules: (
    token: NotificationReconciliationToken,
    scope: string,
    category: string,
    buildNewSet: (stage: { scheduleOne: (request: unknown) => Promise<string> }) => Promise<string[]>,
  ) => Promise<ReplaceCategorySchedulesResult>;
  convergeCategory: (scope: string, category: string) => Promise<ConvergeCategoryResult>;
  abortCategoryReplacement: (
    scope: string,
    category: string,
    laneToken: Pick<NotificationReconciliationToken, 'generation' | 'sessionId' | 'lane'>,
    previousCanonical: string[],
  ) => Promise<void>;
}

export function createCategoryScheduleReplacer(deps: {
  readTracked: (scope: string) => Record<string, unknown>;
  writeTracked: (scope: string, tracked: Record<string, unknown>) => void;
  confirmCancelScheduledIds: (ids: string[]) => Promise<ConfirmCancelScheduledIdsResult>;
  scheduleNotificationAsync: (request: unknown) => Promise<string>;
  assertReconciliationCurrent: (token: NotificationReconciliationToken) => void;
  onStageEvent?: (event: string, context: Record<string, unknown>) => void | Promise<void>;
}): CategoryScheduleReplacer;
