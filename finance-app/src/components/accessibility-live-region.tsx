import React, { useEffect, useRef } from 'react';
import { AccessibilityInfo, Platform, StyleSheet, View, ViewProps } from 'react-native';
import {
  resolveAccessibilityAnnouncement,
  shouldUseExplicitNativeMutationAnnouncement,
  shouldUseExplicitVisibleStatusAnnouncement,
  shouldUseVisibleStatusLiveRegion,
  shouldUseWebMutationLiveRegionSurface,
} from '@/lib/accessibility-announcement.js';

function useDedupedAccessibilityAnnouncement(message: string, enabled: boolean) {
  const previous = useRef('');
  useEffect(() => {
    if (!enabled) return;
    const result = resolveAccessibilityAnnouncement(previous.current, message);
    if (!result.announce || !result.message) return;
    previous.current = result.next;
    AccessibilityInfo.announceForAccessibility(result.message);
  }, [message, enabled]);
}

/** Visible status only: iOS explicit announce via effect. */
export function useVisibleStatusAnnouncement(message: string) {
  useDedupedAccessibilityAnnouncement(
    message,
    shouldUseExplicitVisibleStatusAnnouncement(Platform.OS),
  );
}

/** Mutation status only: native iOS and Android explicit announce via effect. */
export function useNativeMutationAnnouncement(message: string) {
  useDedupedAccessibilityAnnouncement(
    message,
    shouldUseExplicitNativeMutationAnnouncement(Platform.OS),
  );
}

/** Visible status only: iOS explicit announce; renders nothing and is never focusable. */
export function AccessibilityAnnouncementEffect({ message }: { message: string }) {
  useVisibleStatusAnnouncement(message);
  return null;
}

/** Visible status only: attach polite live region to the visible control (Android/web). */
export function visibleStatusLiveRegionProps(): Pick<ViewProps, 'accessibilityLiveRegion'> {
  return shouldUseVisibleStatusLiveRegion(Platform.OS) ? { accessibilityLiveRegion: 'polite' } : {};
}

/**
 * Mutation status only (no visible target).
 * Native iOS/Android: explicit announce, render null.
 * Web: non-keyboard-focusable polite live-region surface.
 */
export function MutationStatusLiveRegion({ message }: { message: string }) {
  useNativeMutationAnnouncement(message);
  const label = typeof message === 'string' ? message.trim() : '';
  if (!shouldUseWebMutationLiveRegionSurface(Platform.OS) || !label) return null;
  return (
    <View
      accessibilityLiveRegion="polite"
      accessibilityLabel={label}
      accessible
      focusable={false}
      style={styles.webMutationLiveRegion}
    />
  );
}

const styles = StyleSheet.create({
  webMutationLiveRegion: {
    position: 'absolute',
    width: 1,
    height: 1,
    opacity: 0,
    overflow: 'hidden',
  },
});
