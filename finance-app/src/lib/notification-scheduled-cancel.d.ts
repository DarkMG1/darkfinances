export const NOTIFICATION_SCHEDULE_CLEANUP_INCOMPLETE_CODE: 'NOTIFICATION_SCHEDULE_CLEANUP_INCOMPLETE';

export type CancelConfirmation = 'confirmed' | 'still_present' | 'unknown';

export interface CancelConfirmationResult {
  id: string;
  confirmation: CancelConfirmation;
  error?: unknown;
}

export interface ConfirmCancelScheduledIdsResult {
  results: CancelConfirmationResult[];
  confirmed: string[];
  retained: string[];
}

export function confirmCancelScheduledIds(
  deps: {
    cancelScheduledNotificationAsync: (id: string) => Promise<void>;
    getAllScheduledNotificationsAsync?: () => Promise<unknown[]>;
  },
  ids: string[],
): Promise<ConfirmCancelScheduledIdsResult>;

export function createConfirmedScheduledCanceller(deps: {
  cancelScheduledNotificationAsync: (id: string) => Promise<void>;
  getAllScheduledNotificationsAsync?: () => Promise<unknown[]>;
}): {
  confirmCancelScheduledIds: (ids: string[]) => Promise<ConfirmCancelScheduledIdsResult>;
};
