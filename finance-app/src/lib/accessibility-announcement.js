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
 * Visible query/status banners and ErrorState copy:
 * iOS VoiceOver needs explicit announcements for dynamically appearing status.
 *
 * @param {string} platform React Native Platform.OS value
 * @returns {boolean}
 */
function shouldUseExplicitVisibleStatusAnnouncement(platform) {
  return platform === 'ios';
}

/**
 * Visible query/status banners and ErrorState copy:
 * Android TalkBack and web read polite live-region updates from the visible surface.
 *
 * @param {string} platform React Native Platform.OS value
 * @returns {boolean}
 */
function shouldUseVisibleStatusLiveRegion(platform) {
  return platform === 'android' || platform === 'web';
}

/**
 * Mutation status has no visible target on native platforms.
 * Both iOS VoiceOver and Android TalkBack need explicit announcements.
 *
 * @param {string} platform React Native Platform.OS value
 * @returns {boolean}
 */
function shouldUseExplicitNativeMutationAnnouncement(platform) {
  return platform === 'ios' || platform === 'android';
}

/**
 * Mutation status on web uses a standards-compatible live-region surface only.
 *
 * @param {string} platform React Native Platform.OS value
 * @returns {boolean}
 */
function shouldUseWebMutationLiveRegionSurface(platform) {
  return platform === 'web';
}

/**
 * @param {string} platform React Native Platform.OS value
 * @param {string | undefined | null} message
 * @returns {{ explicitAnnounce: boolean; webLiveRegionSurface: boolean }}
 */
function resolveMutationStatusPresentation(platform, message) {
  const label = typeof message === 'string' ? message.trim() : '';
  return {
    explicitAnnounce: shouldUseExplicitNativeMutationAnnouncement(platform) && !!label,
    webLiveRegionSurface: shouldUseWebMutationLiveRegionSurface(platform) && !!label,
  };
}

module.exports = {
  resolveAccessibilityAnnouncement,
  shouldUseExplicitVisibleStatusAnnouncement,
  shouldUseVisibleStatusLiveRegion,
  shouldUseExplicitNativeMutationAnnouncement,
  shouldUseWebMutationLiveRegionSurface,
  resolveMutationStatusPresentation,
};
