import React from 'react';
import { Pressable, StyleSheet, Text } from 'react-native';
import {
  AccessibilityAnnouncementEffect,
  visibleStatusLiveRegionProps,
} from '@/components/accessibility-live-region';
import { colors } from '@/theme/colors';

export function QueryRefetchBanner({ message = 'Could not refresh · showing cached data · tap to retry', onRetry, testID = 'query-refetch-banner' }: {
  message?: string;
  onRetry: () => void;
  testID?: string;
}) {
  return (
    <>
      <AccessibilityAnnouncementEffect message={message} />
      <Pressable
        testID={testID}
        accessibilityRole="button"
        accessibilityLabel={message}
        {...visibleStatusLiveRegionProps()}
        onPress={onRetry}
        style={({ pressed }) => [styles.banner, pressed && { opacity: 0.8 }]}
      >
        <Text accessibilityElementsHidden importantForAccessibility="no" style={styles.text}>{message}</Text>
      </Pressable>
    </>
  );
}

const styles = StyleSheet.create({
  banner: {
    borderRadius: 10,
    borderWidth: 1,
    borderColor: colors.red,
    backgroundColor: colors.surface2,
    paddingHorizontal: 12,
    paddingVertical: 10,
    marginBottom: 12,
  },
  text: { color: colors.red, fontSize: 12, fontWeight: '700', textAlign: 'center' },
});
