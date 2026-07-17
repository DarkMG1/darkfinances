import type { NotificationReconciliationToken } from '@/lib/notification-reconciliation';

export interface CategoryScheduleState {
  canonical: string[];
  pending: string[];
  retiring: string[];
  cleanup: string[];
  laneToken: Pick<NotificationReconciliationToken, 'generation' | 'sessionId' | 'lane'> | null;
  purgeTombstone?: boolean;
}

export function normalizeCategoryState(raw: unknown): CategoryScheduleState;

export function readCategoryState(tracked: Record<string, unknown>, category: string): CategoryScheduleState;

export function readCommittedCategoryIds(tracked: Record<string, unknown>, category: string): string[];

export function osLiveIds(state: CategoryScheduleState): string[];

export function allTrackedIds(state: CategoryScheduleState): string[];

export function hasStageEvidence(state: CategoryScheduleState): boolean;

export function writeCategoryState(
  tracked: Record<string, unknown>,
  category: string,
  state: CategoryScheduleState,
): void;

export function casWriteStage(
  tracked: Record<string, unknown>,
  category: string,
  state: CategoryScheduleState,
  laneToken: Pick<NotificationReconciliationToken, 'generation' | 'sessionId' | 'lane'>,
): void;

export function mergeCleanup(state: CategoryScheduleState, ids: string[]): CategoryScheduleState;
