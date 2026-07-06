import React from 'react';
import { RefreshControl, ScrollView, StyleSheet, Text, View } from 'react-native';
import { useSafeAreaInsets } from 'react-native-safe-area-context';
import { useServerConfig } from '@/state/server';
import { haptics } from '@/lib/haptics';
import { colors } from '@/theme/colors';

// Wraps a consumer onRefresh with a light haptic so every pull-to-refresh
// confirms the gesture, without each screen wiring it up.
function withRefreshHaptic(onRefresh?: () => void): (() => void) | undefined {
  if (!onRefresh) return undefined;
  return () => {
    haptics.light();
    onRefresh();
  };
}

export function DemoRibbon() {
  const { demo } = useServerConfig();
  if (!demo) return null;
  return (
    <View style={styles.ribbon}>
      <Text style={styles.ribbonText}>DEMO MODE · SAMPLE DATA</Text>
    </View>
  );
}

export function Screen({ title, accent, right, refreshing, onRefresh, children }: {
  title: string;
  accent?: string;
  right?: React.ReactNode;
  refreshing?: boolean;
  onRefresh?: () => void;
  children: React.ReactNode;
}) {
  const insets = useSafeAreaInsets();
  return (
    <View style={styles.root}>
      <View style={[styles.header, { paddingTop: insets.top + 6 }]}>
        <Text style={styles.logo}>
          {title}
          {accent ? <Text style={{ color: colors.accentLight }}>{accent}</Text> : null}
        </Text>
        <View style={styles.headerRight}>{right}</View>
      </View>
      <DemoRibbon />
      <ScrollView
        style={styles.scroll}
        contentContainerStyle={{ padding: 16, paddingBottom: insets.bottom + 60 }}
        refreshControl={
          onRefresh ? (
            <RefreshControl tintColor={colors.accent} refreshing={!!refreshing} onRefresh={withRefreshHaptic(onRefresh)} />
          ) : undefined
        }
      >
        {children}
      </ScrollView>
    </View>
  );
}

// For pushed (stack) routes that render under the native back-button header.
export function PushScreen({ refreshing, onRefresh, children }: {
  refreshing?: boolean;
  onRefresh?: () => void;
  children: React.ReactNode;
}) {
  const insets = useSafeAreaInsets();
  return (
    <View style={styles.root}>
      <DemoRibbon />
      <ScrollView
        style={styles.scroll}
        contentContainerStyle={{ padding: 16, paddingBottom: insets.bottom + 32 }}
        refreshControl={
          onRefresh ? (
            <RefreshControl tintColor={colors.accent} refreshing={!!refreshing} onRefresh={withRefreshHaptic(onRefresh)} />
          ) : undefined
        }
      >
        {children}
      </ScrollView>
    </View>
  );
}

const styles = StyleSheet.create({
  root: { flex: 1, backgroundColor: colors.bg },
  header: {
    paddingHorizontal: 16,
    paddingBottom: 10,
    borderBottomWidth: 1,
    borderBottomColor: colors.border,
    flexDirection: 'row',
    alignItems: 'center',
    justifyContent: 'space-between',
  },
  logo: { color: colors.text, fontSize: 17, fontWeight: '700', letterSpacing: -0.3 },
  headerRight: { flexDirection: 'row', alignItems: 'center', gap: 8 },
  scroll: { flex: 1 },
  ribbon: { backgroundColor: colors.accent, paddingVertical: 4, alignItems: 'center' },
  ribbonText: { color: '#fff', fontSize: 11, fontWeight: '700', letterSpacing: 1 },
});
