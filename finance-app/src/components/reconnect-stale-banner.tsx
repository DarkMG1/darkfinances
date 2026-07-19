import React, { useSyncExternalStore } from 'react';
import { Pressable, StyleSheet, Text } from 'react-native';
import { useSafeAreaInsets } from 'react-native-safe-area-context';
import {
  AccessibilityAnnouncementEffect,
  visibleStatusLiveRegionProps,
} from '@/components/accessibility-live-region';
import { getReconnectStaleWarningStore } from '@/lib/reconnect-refresh';
import { requestReconnectRefreshRetry } from '@/lib/reconnect-refresh-registry';
import { useServerConfig } from '@/state/server';
import { colors } from '@/theme/colors';

function staleMessage(code: string): string {
  switch (code) {
    case 'RECONNECT_SOURCE_TIMEOUT':
      return 'Finance data may be stale · connection timed out';
    case 'RECONNECT_SOURCE_AUTH':
      return 'Finance data may be stale · sign in again from Settings';
    case 'RECONNECT_SOURCE_NOT_READY':
      return 'Finance data may be stale · server is still starting';
    case 'RECONNECT_REFETCH_FAILED':
      return 'Finance data may be stale · refresh failed';
    default:
      return 'Finance data may be stale · tap to retry';
  }
}

export function ReconnectStaleBanner({ top }: { top?: number }) {
  const insets = useSafeAreaInsets();
  const { scope } = useServerConfig();
  const bannerTop = top ?? insets.top + 44;
  const store = getReconnectStaleWarningStore();
  const warning = useSyncExternalStore(
    (listener) => store.subscribe(listener),
    () => store.get(scope),
    () => store.get(scope),
  );

  if (!warning) return null;

  const text = staleMessage(warning.code);
  const announcement = `${text}. Tap to retry refresh.`;

  return (
    <>
      <AccessibilityAnnouncementEffect message={announcement} />
      <Pressable
        testID="reconnect-stale-banner"
        accessibilityRole="button"
        accessibilityLabel={announcement}
        {...visibleStatusLiveRegionProps()}
        onPress={() => {
          requestReconnectRefreshRetry();
        }}
        style={({ pressed }) => [
          styles.banner,
          { top: bannerTop },
          pressed && { opacity: 0.85 },
        ]}
      >
        <Text accessibilityElementsHidden importantForAccessibility="no" style={styles.text}>{text}</Text>
      </Pressable>
    </>
  );
}

const styles = StyleSheet.create({
  banner: {
    position: 'absolute',
    alignSelf: 'center',
    maxWidth: '92%',
    borderRadius: 999,
    borderWidth: 1,
    borderColor: colors.yellow,
    backgroundColor: colors.surface,
    paddingHorizontal: 14,
    paddingVertical: 8,
  },
  text: { color: colors.yellow, fontSize: 12, fontWeight: '700', textAlign: 'center' },
});
