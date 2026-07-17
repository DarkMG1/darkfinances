export const NOTIFICATION_RECONCILIATION_STALE_CODE: 'NOTIFICATION_RECONCILIATION_STALE';

export type ReconciliationLane = 'scheduled' | 'event';

export interface NotificationReconciliationToken {
  lane: ReconciliationLane;
  generation: number;
  sessionId: number;
  scope: string;
}

export function subscribeProfileGeneration(listener: () => void): () => void;

export function getProfileGeneration(): number;

export function getReconciliationSessionId(lane?: ReconciliationLane): number;

export function createReconciliationToken(
  lane: ReconciliationLane,
  generation?: number,
  sessionId?: number,
  scope?: string,
): NotificationReconciliationToken;

export function bumpProfileGeneration(): number;

export function purgeProfileGeneration(scope?: string): number;

export function suspendNotificationScope(scope?: string): void;

export function activateNotificationScope(scope: string | undefined, generation: number): void;

export function isNotificationScopeAdmissionAllowed(scope?: string): boolean;

export function isNotificationScopeSuspended(scope?: string): boolean;

export function cancelReconciliation(token: NotificationReconciliationToken): void;

export function cancelReconciliationLane(lane: ReconciliationLane): void;

export function cancelAllReconciliationLanes(): void;

/** @deprecated */
export function cancelActiveReconciliation(): void;

export function beginReconciliation(
  lane: ReconciliationLane,
  generation?: number,
  scope?: string,
): NotificationReconciliationToken;

export function endReconciliation(token: NotificationReconciliationToken): void;

export function isReconciliationCurrent(token: NotificationReconciliationToken): boolean;

export function isStaleGeneration(generation: number): boolean;

export function isExpectedReconciliationError(error: unknown): boolean;

export function assertReconciliationCurrent(token: NotificationReconciliationToken): void;

export function withReconciliationGuard<T>(
  token: NotificationReconciliationToken,
  fn: () => Promise<T> | T,
): Promise<T>;

export function resetNotificationReconciliationState(): void;
