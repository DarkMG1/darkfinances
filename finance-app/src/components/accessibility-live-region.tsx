import React, { useEffect, useRef } from 'react';
import { AccessibilityInfo, StyleSheet, View } from 'react-native';
import { resolveAccessibilityAnnouncement } from '@/lib/accessibility-announcement.js';

export function useAccessibilityAnnouncement(message: string) {
  const previous = useRef('');
  useEffect(() => {
    const result = resolveAccessibilityAnnouncement(previous.current, message);
    if (!result.announce || !result.message) return;
    previous.current = result.next;
    AccessibilityInfo.announceForAccessibility(result.message);
  }, [message]);
}

export function AccessibilityLiveRegion({ message }: { message: string }) {
  useAccessibilityAnnouncement(message);
  const label = typeof message === 'string' ? message.trim() : '';
  return (
    <View
      accessibilityLiveRegion="polite"
      importantForAccessibility="yes"
      accessible={!!label}
      accessibilityLabel={label || undefined}
      style={styles.srOnly}
    />
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
});
