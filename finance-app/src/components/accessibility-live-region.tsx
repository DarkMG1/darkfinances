import React, { useEffect, useRef } from 'react';
import { AccessibilityInfo, Platform, StyleSheet, Text, View } from 'react-native';
import {
  resolveAccessibilityAnnouncement,
  shouldUseExplicitAccessibilityAnnouncement,
  shouldUseVisibleLiveRegion,
} from '@/lib/accessibility-announcement.js';

export function useAccessibilityAnnouncement(message: string) {
  const previous = useRef('');
  useEffect(() => {
    if (!shouldUseExplicitAccessibilityAnnouncement(Platform.OS)) return;
    const result = resolveAccessibilityAnnouncement(previous.current, message);
    if (!result.announce || !result.message) return;
    previous.current = result.next;
    AccessibilityInfo.announceForAccessibility(result.message);
  }, [message]);
}

/** iOS-only explicit announce; renders nothing and is never focusable. */
export function AccessibilityAnnouncementEffect({ message }: { message: string }) {
  useAccessibilityAnnouncement(message);
  return null;
}

/** Live region on visible status surfaces (Android/web only). */
export function visibleStatusLiveRegionProps(): { accessibilityLiveRegion?: 'polite' } {
  return shouldUseVisibleLiveRegion(Platform.OS) ? { accessibilityLiveRegion: 'polite' } : {};
}

/**
 * Screen-reader-only live region for mutation status (no visible target).
 * iOS: explicit announce only. Android/web: non-focusable polite live region.
 */
export function MutationStatusLiveRegion({ message }: { message: string }) {
  useAccessibilityAnnouncement(message);
  const label = typeof message === 'string' ? message.trim() : '';
  if (!shouldUseVisibleLiveRegion(Platform.OS)) return null;
  if (!label) return null;
  return (
    <View
      accessibilityLiveRegion="polite"
      importantForAccessibility="no"
      accessible={false}
      style={styles.srOnly}
    >
      <Text style={styles.srOnlyText}>{label}</Text>
    </View>
  );
}

const styles = StyleSheet.create({
  srOnly: {
    position: 'absolute',
    width: 1,
    height: 1,
    opacity: 0,
    overflow: 'hidden',
  },
  srOnlyText: {
    position: 'absolute',
    width: 1,
    height: 1,
    opacity: 0,
  },
});
