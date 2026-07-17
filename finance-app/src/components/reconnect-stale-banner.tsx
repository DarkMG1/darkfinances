import React, { useSyncExternalStore } from 'react';
import { Pressable, StyleSheet, Text } from 'react-native';
import { useSafeAreaInsets } from 'react-native-safe-area-context';
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
    case 'RECONNECT_SOURCE_SERVER':
      return 'Finance data may be stale · server error';
    case 'RECONNECT_REFETCH_FAILED':
      return 'Finance data may be stale · refresh failed';
    default:
      return 'Finance data may be stale · tap to retry';
  }
}

export function ReconnectStaleBanner() {
  const insets = useSafeAreaInsets();
  const { scope } = useServerConfig();
  const store = getReconnectStaleWarningStore();
  const warning = useSyncExternalStore(
    (listener) => store.subscribe(listener),
    () => store.get(scope),
    () => store.get(scope),
  );

  if (!warning) return null;

  const text = staleMessage(warning.code);

  return (
    <Pressable
      testID="reconnect-stale-banner"
      accessibilityRole="button"
      accessibilityLabel={`${text}. Tap to retry refresh.`}
      accessibilityLiveRegion="polite"
      onPress={() => {
        requestReconnectRefreshRetry();
      }}
      style={({ pressed }) => [
        styles.banner,
        { top: insets.top + 44 },
        pressed && { opacity: 0.85 },
      ]}
    >
      <Text style={styles.text}>{text}</Text>
    </Pressable>
  );
}

const styles = StyleSheet.create({
  banner: {
    position: 'absolute',
    zIndex: 9999,
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
