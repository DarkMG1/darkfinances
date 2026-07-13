import React from 'react';
import { ScrollView, StyleSheet, Text, View } from 'react-native';
import { useSafeAreaInsets } from 'react-native-safe-area-context';
import { useServerConfig } from '@/state/server';
import { GestureRefreshControl, RefreshAction } from '@/components/gesture-refresh-control';
import { colors } from '@/theme/colors';

export function DemoRibbon() {
  const { demo } = useServerConfig();
  if (!demo) return null;
  return (
    <View style={styles.ribbon}>
      <Text style={styles.ribbonText}>DEMO MODE · SAMPLE DATA</Text>
    </View>
  );
}

export function Screen({ title, accent, right, onRefresh, children, testID }: {
  title: string;
  accent?: string;
  right?: React.ReactNode;
  onRefresh?: RefreshAction;
  children: React.ReactNode;
  testID?: string;
}) {
  const insets = useSafeAreaInsets();
  return (
    <View style={styles.root} testID={testID}>
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
            <GestureRefreshControl onRefresh={onRefresh} />
          ) : undefined
        }
      >
        {children}
      </ScrollView>
    </View>
  );
}

// For pushed (stack) routes that render under the native back-button header.
export function PushScreen({ onRefresh, children, testID }: {
  onRefresh?: RefreshAction;
  children: React.ReactNode;
  testID?: string;
}) {
  const insets = useSafeAreaInsets();
  return (
    <View style={styles.root} testID={testID}>
      <DemoRibbon />
      <ScrollView
        style={styles.scroll}
        contentContainerStyle={{ padding: 16, paddingBottom: insets.bottom + 32 }}
        refreshControl={
          onRefresh ? (
            <GestureRefreshControl onRefresh={onRefresh} />
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
