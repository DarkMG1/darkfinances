import React, { useCallback, useEffect, useRef, useState } from 'react';
import { AppState, AppStateStatus, Pressable, StyleSheet, Text, View } from 'react-native';
import { GestureHandlerRootView } from 'react-native-gesture-handler';
import Reanimated, {
  Easing,
  runOnJS,
  useAnimatedStyle,
  useSharedValue,
  withDelay,
  withTiming,
} from 'react-native-reanimated';
import { SafeAreaProvider } from 'react-native-safe-area-context';
import { StatusBar } from 'expo-status-bar';
import { ErrorBoundaryProps, Stack } from 'expo-router';
import { focusManager, QueryClientProvider } from '@tanstack/react-query';
import { reconcilePendingFinanceOperations } from '@/api/client/requests';
import { ServerProvider, useServerConfig } from '@/state/server';
import { FinanceDateProvider } from '@/state/finance-date';
import { authenticate } from '@/lib/biometric';
import { useAutoUpdate } from '@/lib/auto-update';
import {
  clearFinanceOperationReconciliationDiagnostic,
  recordFinanceOperationReconciliationError,
} from '@/lib/finance-operations';
import {
  reconcileFinanceOperationsOnForeground,
  refreshActiveFinanceQueriesForScope,
} from '@/lib/foreground-operation-reconciliation';
import { queryClient } from '@/lib/query-client';
import { purgeLegacyReceiptCopies } from '@/lib/receipts';
import { Loading } from '@/components/ui';
import { NotificationRouter } from '@/components/notification-router';
import { colors } from '@/theme/colors';

const UNLOCK_FADE_ACTIVE_SETTLE_MS = 40;
const UNLOCK_FADE_DELAY_MS = 0;
const UNLOCK_FADE_DURATION_MS = 260;

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

function PrivacyMark() {
  return (
    <View testID="privacy-mark" style={styles.privacyMark}>
      <Text style={styles.privacyTitle}>dark<Text style={{ color: colors.accentLight }}>finances</Text></Text>
      <Text style={styles.privacySub}>Private finances</Text>
    </View>
  );
}

function PrivacyGateOverlay({
  fading,
  fadeKey,
  showPrivacy,
  onFadeDone,
  onUnlock,
}: {
  fading: boolean;
  fadeKey: number;
  showPrivacy: boolean;
  onFadeDone: () => void;
  onUnlock: () => void;
}) {
  const opacity = useSharedValue(1);
  const animatedStyle = useAnimatedStyle(() => ({ opacity: opacity.get() }));

  useEffect(() => {
    opacity.set(1);
    if (!fading) return;

    opacity.set(withDelay(
      UNLOCK_FADE_DELAY_MS,
      withTiming(0, { duration: UNLOCK_FADE_DURATION_MS, easing: Easing.out(Easing.cubic) }, (finished) => {
        if (finished) runOnJS(onFadeDone)();
      })
    ));
  }, [fadeKey, fading, onFadeDone, opacity]);

  return (
    <Reanimated.View
      testID="privacy-lock-overlay"
      shouldRasterizeIOS={fading}
      needsOffscreenAlphaCompositing={fading}
      pointerEvents="auto"
      style={[styles.lockOverlay, showPrivacy && styles.privacyCover, animatedStyle]}
    >
      {showPrivacy ? (fading ? null : <PrivacyMark />) : <LockScreen onUnlock={onUnlock} />}
    </Reanimated.View>
  );
}

function RootNav() {
  const { ready, configured, faceId, demo, serverUrl, token, scope } = useServerConfig();
  const [unlocked, setUnlocked] = useState(false);
  const [lockFading, setLockFading] = useState(false);
  const [unlockFadeRunning, setUnlockFadeRunning] = useState(false);
  const [unlockFadeKey, setUnlockFadeKey] = useState(0);
  const [privacyVisible, setPrivacyVisible] = useState(false);
  const [appActive, setAppActive] = useState(() => AppState.currentState === 'active');
  const appState = useRef<AppStateStatus>(AppState.currentState);
  const authenticating = useRef(false);
  const authGraceUntil = useRef(0);
  const lastActiveAt = useRef(0);
  const lockedForBackground = useRef(false);
  const unlockTimer = useRef<ReturnType<typeof setTimeout> | null>(null);
  const unlockFadeTimer = useRef<ReturnType<typeof setTimeout> | null>(null);
  const canPromptForUpdate = ready && appActive && (
    !configured ||
    !faceId ||
    (unlocked && !privacyVisible && !lockFading && !unlockFadeRunning)
  );
  useAutoUpdate(canPromptForUpdate);

  const reconcileOperations = useCallback(() => {
    if (!ready || !configured || demo) return;
    void reconcileFinanceOperationsOnForeground({
      reconcile: () => reconcilePendingFinanceOperations({ serverUrl, token, demo }),
      refreshCompletedQueries: () => refreshActiveFinanceQueriesForScope(queryClient, scope),
      clearDiagnostic: clearFinanceOperationReconciliationDiagnostic,
      recordDiagnostic: recordFinanceOperationReconciliationError,
    });
  }, [configured, demo, ready, scope, serverUrl, token]);

  useEffect(() => {
    if (AppState.currentState === 'active') reconcileOperations();
    const sub = AppState.addEventListener('change', (next) => {
      if (next === 'active') reconcileOperations();
    });
    return () => sub.remove();
  }, [reconcileOperations]);

  const clearUnlockTimer = useCallback(() => {
    if (unlockTimer.current) {
      clearTimeout(unlockTimer.current);
      unlockTimer.current = null;
    }
  }, []);

  const clearUnlockFadeTimer = useCallback(() => {
    if (unlockFadeTimer.current) {
      clearTimeout(unlockFadeTimer.current);
      unlockFadeTimer.current = null;
    }
  }, []);

  const startUnlockFadeWhenActive = useCallback(() => {
    clearUnlockFadeTimer();
    setLockFading(true);
    setUnlockFadeRunning(false);

    const startIfReady = () => {
      if (appState.current !== 'active') {
        unlockFadeTimer.current = setTimeout(startIfReady, 100);
        return;
      }

      const activeFor = Date.now() - lastActiveAt.current;
      if (activeFor < UNLOCK_FADE_ACTIVE_SETTLE_MS) {
        unlockFadeTimer.current = setTimeout(startIfReady, UNLOCK_FADE_ACTIVE_SETTLE_MS - activeFor);
        return;
      }

      unlockFadeTimer.current = null;
      setUnlockFadeRunning(true);
      setUnlockFadeKey((key) => key + 1);
    };

    startIfReady();
  }, [clearUnlockFadeTimer]);

  const lockNow = useCallback(() => {
    clearUnlockTimer();
    clearUnlockFadeTimer();
    setLockFading(false);
    setUnlockFadeRunning(false);
    setUnlocked(false);
  }, [clearUnlockFadeTimer, clearUnlockTimer]);

  const finishUnlock = useCallback(() => {
    setUnlocked(true);
    startUnlockFadeWhenActive();
  }, [startUnlockFadeWhenActive]);

  const finishUnlockFade = useCallback(() => {
    setPrivacyVisible(false);
    setLockFading(false);
    setUnlockFadeRunning(false);
  }, []);

  const tryUnlock = useCallback(async () => {
    if (appState.current !== 'active') return;
    if (authenticating.current) return;
    clearUnlockTimer();
    authenticating.current = true;
    authGraceUntil.current = Date.now() + 8000;
    try {
      const ok = await authenticate('Unlock Finances');
      if (ok) {
        finishUnlock();
      } else {
        setPrivacyVisible(false);
      }
    } finally {
      authenticating.current = false;
      // iOS may deliver the final active event just after authenticateAsync resolves.
      authGraceUntil.current = Date.now() + 3000;
    }
  }, [clearUnlockTimer, finishUnlock]);

  const scheduleUnlock = useCallback((delayMs: number) => {
    if (appState.current !== 'active') return;
    if (authenticating.current) return;
    clearUnlockTimer();
    unlockTimer.current = setTimeout(() => {
      unlockTimer.current = null;
      if (appState.current === 'active') void tryUnlock();
    }, delayMs);
  }, [clearUnlockTimer, tryUnlock]);

  useEffect(() => {
    if (!configured || !faceId || unlocked || !appActive) return;
    scheduleUnlock(250);
    return clearUnlockTimer;
  }, [appActive, clearUnlockTimer, configured, faceId, scheduleUnlock, unlocked]);

  useEffect(() => () => {
    clearUnlockTimer();
    clearUnlockFadeTimer();
  }, [clearUnlockFadeTimer, clearUnlockTimer]);

  useEffect(() => {
    const sub = AppState.addEventListener('change', (next) => {
      const returningToApp = appState.current.match(/inactive|background/) && next === 'active';
      appState.current = next;
      if (next === 'active') lastActiveAt.current = Date.now();
      setAppActive(next === 'active');

      // LocalAuthentication briefly moves the app through inactive/active while
      // Face ID is onscreen, and the final active event can arrive just after
      // authenticateAsync resolves. Do not relock for biometric-owned transitions.
      if (authenticating.current) {
        return;
      }
      if (next === 'inactive' && Date.now() < authGraceUntil.current && !lockedForBackground.current) {
        return;
      }
      if (next === 'active' && Date.now() < authGraceUntil.current && !lockedForBackground.current) {
        return;
      }

      if (next === 'inactive' || next === 'background') {
        lockedForBackground.current = true;
        clearUnlockTimer();
        setPrivacyVisible(true);
        if (configured && faceId) lockNow();
        return;
      }

      if (returningToApp && configured && faceId) {
        lockedForBackground.current = false;
        lockNow();
        scheduleUnlock(450);
      } else if (next === 'active') {
        lockedForBackground.current = false;
        setPrivacyVisible(false);
      }
    });
    return () => sub.remove();
  }, [clearUnlockTimer, configured, faceId, lockNow, scheduleUnlock]);

  let content: React.ReactNode;
  if (!ready) {
    content = (
      <View style={styles.splash}>
        <Loading />
      </View>
    );
  } else {
    const pushHeader = {
      headerShown: true,
      headerStyle: { backgroundColor: colors.surface },
      headerTintColor: colors.text,
      headerTitleStyle: { color: colors.text },
      headerShadowVisible: false,
      headerBackButtonDisplayMode: 'minimal', // just the chevron, not "(tabs)"
    } as const;

    content = (
      <Stack screenOptions={{ headerShown: false, contentStyle: { backgroundColor: colors.bg } }}>
        <Stack.Protected guard={configured}>
          <Stack.Screen name="(tabs)" />
          <Stack.Screen name="networth" options={{ ...pushHeader, title: 'Net Worth' }} />
          <Stack.Screen name="investments" options={{ ...pushHeader, title: 'Investments' }} />
          <Stack.Screen name="debt" options={{ ...pushHeader, title: 'Debt Payoff' }} />
          <Stack.Screen name="budgets" options={{ ...pushHeader, title: 'Budgets' }} />
          <Stack.Screen name="cashflow" options={{ ...pushHeader, title: 'Cash Flow' }} />
          <Stack.Screen name="forecast" options={{ ...pushHeader, title: 'Forecast' }} />
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

  return (
    <View style={styles.appShell}>
      {content}
      {configured ? <NotificationRouter /> : null}
      {configured && demo ? (
        <View pointerEvents="none" style={styles.demoWatermark}>
          <Text style={styles.demoWatermarkText}>DEMO · SYNTHETIC DATA</Text>
        </View>
      ) : null}
      {configured && faceId && (privacyVisible || !unlocked || lockFading) ? (
        <PrivacyGateOverlay
          fading={unlockFadeRunning}
          fadeKey={unlockFadeKey}
          showPrivacy={privacyVisible || lockFading}
          onFadeDone={finishUnlockFade}
          onUnlock={tryUnlock}
        />
      ) : null}
    </View>
  );
}

export default function RootLayout() {
  useEffect(() => {
    void purgeLegacyReceiptCopies();
  }, []);
  useEffect(() => {
    const updateFocus = (state: AppStateStatus) => {
      const focused = state === 'active';
      focusManager.setFocused(focused);
    };
    updateFocus(AppState.currentState);
    const sub = AppState.addEventListener('change', updateFocus);
    return () => sub.remove();
  }, []);
  return (
    <GestureHandlerRootView style={{ flex: 1 }}>
      <QueryClientProvider client={queryClient}>
        <ServerProvider>
          <FinanceDateProvider>
            <SafeAreaProvider>
              <StatusBar style="light" />
              <RootNav />
            </SafeAreaProvider>
          </FinanceDateProvider>
        </ServerProvider>
      </QueryClientProvider>
    </GestureHandlerRootView>
  );
}

const styles = StyleSheet.create({
  appShell: { flex: 1, backgroundColor: colors.bg },
  demoWatermark: { position: 'absolute', top: 52, alignSelf: 'center', zIndex: 9000, backgroundColor: colors.yellow + 'EE', borderRadius: 999, paddingHorizontal: 10, paddingVertical: 4 },
  demoWatermarkText: { color: colors.bg, fontSize: 10, fontWeight: '900', letterSpacing: 0.8 },
  lockOverlay: { ...StyleSheet.absoluteFill, zIndex: 9998, elevation: 9998, backgroundColor: colors.bg },
  splash: { flex: 1, backgroundColor: colors.bg, alignItems: 'center', justifyContent: 'center' },
  lock: { flex: 1, backgroundColor: colors.bg, alignItems: 'center', justifyContent: 'center', gap: 12 },
  lockTitle: { color: colors.text, fontSize: 22, fontWeight: '700' },
  lockSub: { color: colors.muted, fontSize: 14, marginBottom: 12 },
  unlockBtn: { backgroundColor: colors.accent, paddingHorizontal: 22, paddingVertical: 12, borderRadius: 12 },
  unlockText: { color: '#fff', fontWeight: '600', fontSize: 15 },
  errBox: { flex: 1, backgroundColor: colors.bg, alignItems: 'center', justifyContent: 'center', gap: 12, padding: 28 },
  errTitle: { color: colors.text, fontSize: 18, fontWeight: '700' },
  errMsg: { color: colors.muted, fontSize: 13, textAlign: 'center', lineHeight: 18 },
  privacyCover: { zIndex: 9999, elevation: 9999, backgroundColor: colors.bg, alignItems: 'center', justifyContent: 'center' },
  privacyMark: { alignItems: 'center', justifyContent: 'center', paddingHorizontal: 30, paddingVertical: 26, borderRadius: 24, backgroundColor: colors.surface, borderWidth: 1, borderColor: colors.border },
  privacyTitle: { color: colors.text, fontSize: 28, fontWeight: '700' },
  privacySub: { color: colors.muted, fontSize: 13, fontWeight: '700', marginTop: 8, textTransform: 'uppercase', letterSpacing: 1 },
});
