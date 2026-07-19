/**
 * Pure helper for deduping accessibility announcements within a mount.
 *
 * @param {string} previous previously announced message for this mount
 * @param {string | undefined | null} next candidate message
 * @returns {{ announce: boolean; next: string; message?: string }}
 */
function resolveAccessibilityAnnouncement(previous, next) {
  const normalized = typeof next === 'string' ? next.trim() : '';
  if (!normalized) {
    return { announce: false, next: previous };
  }
  if (normalized === previous) {
    return { announce: false, next: previous };
  }
  return { announce: true, next: normalized, message: normalized };
}

module.exports = {
  resolveAccessibilityAnnouncement,
};
