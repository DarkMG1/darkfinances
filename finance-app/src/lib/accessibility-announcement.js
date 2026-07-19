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

/**
 * iOS VoiceOver needs explicit announcements for dynamically appearing status.
 * Android TalkBack and web rely on accessibilityLiveRegion on the visible surface.
 *
 * @param {string} platform React Native Platform.OS value
 * @returns {boolean}
 */
function shouldUseExplicitAccessibilityAnnouncement(platform) {
  return platform === 'ios';
}

/**
 * @param {string} platform React Native Platform.OS value
 * @returns {boolean}
 */
function shouldUseVisibleLiveRegion(platform) {
  return platform === 'android' || platform === 'web';
}

module.exports = {
  resolveAccessibilityAnnouncement,
  shouldUseExplicitAccessibilityAnnouncement,
  shouldUseVisibleLiveRegion,
};
