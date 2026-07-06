import React, { useEffect, useState } from 'react';
import { Pressable, StyleSheet, Text, View } from 'react-native';
import { GestureHandlerRootView } from 'react-native-gesture-handler';
import { SafeAreaProvider } from 'react-native-safe-area-context';
import { StatusBar } from 'expo-status-bar';
import { ErrorBoundaryProps, Stack } from 'expo-router';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { ServerProvider, useServerConfig } from '@/state/server';
import { authenticate } from '@/lib/biometric';
import { useAutoUpdate } from '@/lib/auto-update';
import { hydrateQueryClient, startPersistingQueryClient } from '@/lib/query-persist';
import { Loading } from '@/components/ui';
import { colors } from '@/theme/colors';

const queryClient = new QueryClient({
  defaultOptions: {
    queries: {
      retry: 1,
      refetchOnWindowFocus: false,
      // Keep cached data around long enough to survive a cold start and be
      // persisted to disk (see query-persist). 24h matches the persist max age.
      gcTime: 1000 * 60 * 60 * 24,
    },
  },
});

// Restore the persisted cache synchronously, before the first render, so warm
// starts show data immediately instead of spinners.
hydrateQueryClient(queryClient);

// Catch-all: a thrown render error anywhere below the root used to drop the app
// to a frozen blank screen (release builds have no red box). This shows a
// recoverable screen with a Reload instead of a dead app.
export function ErrorBoundary({ error, retry }: ErrorBoundaryProps) {
  return (
    <View style={styles.errBox}>
      <Text style={styles.errTitle}>Something went wrong</Text>
      <Text style={styles.errMsg} numberOfLines={8}>{error?.message || 'Unexpected error'}</Text>
      <Pressable style={({ pressed }) => [styles.unlockBtn, pressed && { opacity: 0.85 }]} onPress={retry}>
        <Text style={styles.unlockText}>Reload</Text>
      </Pressable>
    </View>
  );
}

function LockScreen({ onUnlock }: { onUnlock: () => void }) {
  return (
    <View style={styles.lock}>
      <Text style={styles.lockTitle}>dark<Text style={{ color: colors.accentLight }}>finances</Text></Text>
      <Text style={styles.lockSub}>Locked</Text>
      <Pressable style={({ pressed }) => [styles.unlockBtn, pressed && { opacity: 0.85 }]} onPress={onUnlock}>
        <Text style={styles.unlockText}>Unlock with Face ID</Text>
      </Pressable>
    </View>
  );
}

function RootNav() {
  const { ready, configured, faceId } = useServerConfig();
  const [unlocked, setUnlocked] = useState(false);

  const tryUnlock = () => authenticate('Unlock Finances').then((ok) => ok && setUnlocked(true));

  useEffect(() => {
    if (configured && faceId && !unlocked) tryUnlock();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [configured, faceId]);

  if (!ready) {
    return (
      <View style={styles.splash}>
        <Loading />
      </View>
    );
  }

  if (configured && faceId && !unlocked) return <LockScreen onUnlock={tryUnlock} />;

  const pushHeader = {
    headerShown: true,
    headerStyle: { backgroundColor: colors.surface },
    headerTintColor: colors.text,
    headerTitleStyle: { color: colors.text },
    headerShadowVisible: false,
    headerBackButtonDisplayMode: 'minimal', // just the chevron, not "(tabs)"
  } as const;

  return (
    <Stack screenOptions={{ headerShown: false, contentStyle: { backgroundColor: colors.bg } }}>
      <Stack.Protected guard={configured}>
        <Stack.Screen name="(tabs)" />
        <Stack.Screen name="networth" options={{ ...pushHeader, title: 'Net Worth' }} />
        <Stack.Screen name="investments" options={{ ...pushHeader, title: 'Investments' }} />
        <Stack.Screen name="debt" options={{ ...pushHeader, title: 'Debt Payoff' }} />
        <Stack.Screen name="budgets" options={{ ...pushHeader, title: 'Budgets' }} />
        <Stack.Screen name="cashflow" options={{ ...pushHeader, title: 'Cash Flow' }} />
        <Stack.Screen name="forecast" options={{ ...pushHeader, title: 'Forecast' }} />
        <Stack.Screen name="reports" options={{ ...pushHeader, title: 'Reports' }} />
        <Stack.Screen name="bills" options={{ ...pushHeader, title: 'Upcoming Bills' }} />
        <Stack.Screen name="income" options={{ ...pushHeader, title: 'Income' }} />
        <Stack.Screen name="subscriptions" options={{ ...pushHeader, title: 'Subscriptions' }} />
        <Stack.Screen name="add-transaction" options={{ ...pushHeader, title: 'Add Transaction' }} />
        <Stack.Screen name="goals" options={{ ...pushHeader, title: 'Goals' }} />
        <Stack.Screen name="review" options={{ ...pushHeader, title: 'Review' }} />
        <Stack.Screen name="rules" options={{ ...pushHeader, title: 'Rules' }} />
        <Stack.Screen name="events" options={{ ...pushHeader, title: 'Trips & Events' }} />
        <Stack.Screen name="reconcile" options={{ ...pushHeader, title: 'Reconcile' }} />
        <Stack.Screen name="reimbursement" options={{ ...pushHeader, title: 'Who Owes Me' }} />
        <Stack.Screen name="recurring/[key]" options={pushHeader} />
        <Stack.Screen name="category/[name]" options={pushHeader} />
        <Stack.Screen name="merchant/[name]" options={pushHeader} />
        <Stack.Screen name="tag/[tag]" options={pushHeader} />
        <Stack.Screen name="account/[id]" options={pushHeader} />
        <Stack.Screen name="transaction/[id]" options={pushHeader} />
        <Stack.Screen name="split/[id]" options={{ headerShown: false, presentation: 'fullScreenModal', contentStyle: { backgroundColor: colors.bg } }} />
      </Stack.Protected>
      <Stack.Protected guard={!configured}>
        <Stack.Screen name="onboarding" />
      </Stack.Protected>
    </Stack>
  );
}

export default function RootLayout() {
  useAutoUpdate();
  useEffect(() => startPersistingQueryClient(queryClient), []);
  return (
    <GestureHandlerRootView style={{ flex: 1 }}>
      <QueryClientProvider client={queryClient}>
        <ServerProvider>
          <SafeAreaProvider>
            <StatusBar style="light" />
            <RootNav />
          </SafeAreaProvider>
        </ServerProvider>
      </QueryClientProvider>
    </GestureHandlerRootView>
  );
}

const styles = StyleSheet.create({
  splash: { flex: 1, backgroundColor: colors.bg, alignItems: 'center', justifyContent: 'center' },
  lock: { flex: 1, backgroundColor: colors.bg, alignItems: 'center', justifyContent: 'center', gap: 12 },
  lockTitle: { color: colors.text, fontSize: 22, fontWeight: '700' },
  lockSub: { color: colors.muted, fontSize: 14, marginBottom: 12 },
  unlockBtn: { backgroundColor: colors.accent, paddingHorizontal: 22, paddingVertical: 12, borderRadius: 12 },
  unlockText: { color: '#fff', fontWeight: '600', fontSize: 15 },
  errBox: { flex: 1, backgroundColor: colors.bg, alignItems: 'center', justifyContent: 'center', gap: 12, padding: 28 },
  errTitle: { color: colors.text, fontSize: 18, fontWeight: '700' },
  errMsg: { color: colors.muted, fontSize: 13, textAlign: 'center', lineHeight: 18 },
});
