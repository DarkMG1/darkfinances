'use strict';

const NOTIFICATION_SCHEDULE_CLEANUP_INCOMPLETE_CODE = 'NOTIFICATION_SCHEDULE_CLEANUP_INCOMPLETE';

/** @typedef {'confirmed' | 'still_present' | 'unknown'} CancelConfirmation */

function notificationIdentifier(notification) {
  return notification?.identifier ?? notification?.request?.identifier ?? null;
}

/**
 * Cancel scheduled IDs and confirm removal via OS enumeration when available.
 * Never fabricates success: retained IDs must stay in KV evidence for retry.
 *
 * @param {{
 *   cancelScheduledNotificationAsync: (id: string) => Promise<void>;
 *   getAllScheduledNotificationsAsync?: () => Promise<unknown[]>;
 * }} deps
 * @param {string[]} ids
 */
async function confirmCancelScheduledIds(deps, ids) {
  const {
    cancelScheduledNotificationAsync,
    getAllScheduledNotificationsAsync,
  } = deps;

  /** @type {{ id: string, confirmation: CancelConfirmation, error?: unknown }[]} */
  const results = [];

  for (const id of ids) {
    let cancelError = null;
    try {
      await cancelScheduledNotificationAsync(id);
    } catch (error) {
      cancelError = error;
    }

    if (typeof getAllScheduledNotificationsAsync === 'function') {
      try {
        const scheduled = await getAllScheduledNotificationsAsync();
        const osIds = new Set(
          scheduled.map(notificationIdentifier).filter((value) => typeof value === 'string'),
        );
        if (!osIds.has(id)) {
          results.push({ id, confirmation: 'confirmed', error: cancelError ?? undefined });
          continue;
        }
        results.push({
          id,
          confirmation: 'still_present',
          error: cancelError ?? undefined,
        });
        continue;
      } catch (enumError) {
        results.push({
          id,
          confirmation: 'unknown',
          error: cancelError ?? enumError,
        });
        continue;
      }
    }

    results.push({
      id,
      confirmation: 'unknown',
      error: cancelError ?? undefined,
    });
  }

  const confirmed = results
    .filter((entry) => entry.confirmation === 'confirmed')
    .map((entry) => entry.id);
  const retained = results
    .filter((entry) => entry.confirmation !== 'confirmed')
    .map((entry) => entry.id);

  return { results, confirmed, retained };
}

function createConfirmedScheduledCanceller(deps) {
  return {
    confirmCancelScheduledIds: (ids) => confirmCancelScheduledIds(deps, ids),
  };
}

module.exports = {
  NOTIFICATION_SCHEDULE_CLEANUP_INCOMPLETE_CODE,
  confirmCancelScheduledIds,
  createConfirmedScheduledCanceller,
  notificationIdentifier,
};
