import React, { useEffect, useRef } from 'react';
import { Pressable, StyleSheet, Text } from 'react-native';
import { useSafeAreaInsets } from 'react-native-safe-area-context';
import { usePing } from '@/api/hooks/finance.hooks';
import { applyPingAvailabilityTransition } from '@/lib/finance-status-ping-recovery';
import {
  getReconnectConnectivityPhase,
  requestReconnectServerRecovery,
} from '@/lib/reconnect-refresh-registry';
import { colors } from '@/theme/colors';

export function FinanceStatusBanner({ top }: { top?: number }) {
  const insets = useSafeAreaInsets();
  const ping = usePing();
  const bannerTop = top ?? insets.top + 4;
  const recoveryState = useRef({ wasUnavailable: false });

  useEffect(() => {
    const next = applyPingAvailabilityTransition(recoveryState.current, {
      isError: ping.isError,
      isSuccess: ping.isSuccess,
      connectivityPhase: getReconnectConnectivityPhase(),
    });
    if (next.recoveryRequested) {
      requestReconnectServerRecovery();
    }
    recoveryState.current = { wasUnavailable: next.wasUnavailable };
  }, [ping.isError, ping.isSuccess]);

  const syncError = ping.data?.actual?.lastError;
  if (!ping.isError && !syncError) return null;

  const text = ping.isError
    ? 'Server unavailable · tap to retry'
    : 'Finance sync needs attention · tap to retry';
  return (
    <Pressable
      accessibilityRole="button"
      accessibilityLabel={text}
      onPress={() => {
        ping.refetch();
        if (getReconnectConnectivityPhase() === 'online') {
          requestReconnectServerRecovery();
        }
      }}
      style={({ pressed }) => [
        styles.banner,
        { top: bannerTop },
        pressed && { opacity: 0.8 },
      ]}
    >
      <Text style={styles.text}>{text}</Text>
    </Pressable>
  );
}

const styles = StyleSheet.create({
  banner: {
    position: 'absolute',
    alignSelf: 'center',
    maxWidth: '92%',
    borderRadius: 999,
    borderWidth: 1,
    borderColor: colors.red,
    backgroundColor: colors.surface,
    paddingHorizontal: 14,
    paddingVertical: 8,
  },
  text: { color: colors.red, fontSize: 12, fontWeight: '700', textAlign: 'center' },
});
