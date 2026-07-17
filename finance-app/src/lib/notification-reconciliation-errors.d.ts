export const NOTIFICATION_RECONCILE_FAILED_CODE: 'NOTIFICATION_RECONCILE_FAILED';

export function createRedactedNotificationReconciliationError(error: unknown): {
  code: string;
  status: number;
  timestamp: number;
} | null;

export function reportUnexpectedReconciliationError(
  error: unknown,
  recordDiagnostic?: (error: unknown) => void,
): void;
