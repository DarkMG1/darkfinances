import React from 'react';
import { Pressable, ScrollView, StyleSheet, Text, View, useWindowDimensions } from 'react-native';
import { Stack, useLocalSearchParams, useRouter } from 'expo-router';
import { useSafeAreaInsets } from 'react-native-safe-area-context';
import * as WebBrowser from 'expo-web-browser';
import { useRecurring, useSetRecurringOverride } from '@/api/hooks/finance.hooks';
import { AreaChart } from '@/components/charts';
import { Card, CardTitle, ErrorState, Loading } from '@/components/ui';
import { useFinanceToday } from '@/lib/date-only';
import { cancelInfoFor } from '@/theme/cancelDirectory';
import { cadenceLabel, colors, fmtDay, fmtMoney, fmtPos } from '@/theme/colors';

export default function RecurringDetail() {
  const { key } = useLocalSearchParams<{ key: string }>();
  const financeToday = useFinanceToday();
  const router = useRouter();
  const { width } = useWindowDimensions();
  const insets = useSafeAreaInsets();
  const recurring = useRecurring();
  const override = useSetRecurringOverride();

  const item = recurring.data?.items.find((i) => i.key === key);

  if (recurring.isLoading && !recurring.data) {
    return (
      <View testID="recurring-detail-screen" style={styles.root}>
        <Stack.Screen options={{ title: 'Subscription' }} />
        <Loading />
      </View>
    );
  }
  if (recurring.isError && !recurring.data) {
    return (
      <View testID="recurring-detail-screen" style={styles.root}>
        <Stack.Screen options={{ title: 'Subscription' }} />
        <ErrorState error={recurring.error?.error} onRetry={recurring.refetch} />
      </View>
    );
  }
  if (!item) {
    return (
      <View testID="recurring-detail-screen" style={[styles.root, styles.center]}>
        <Stack.Screen options={{ title: 'Subscription' }} />
        <Text style={styles.muted}>Subscription not found.</Text>
      </View>
    );
  }

  const points = item.history.map((h) => ({ value: h.amount, label: h.date.slice(0, 7) }));
  const cancelled = item.status === 'cancelled';

  const setCancelled = () => override.mutate({ key: item.key, status: cancelled ? 'active' : 'cancelled' });
  const hide = () => override.mutate({ key: item.key, hidden: true }, { onSuccess: () => router.back() });
  const setIsBill = (isBill: boolean) => override.mutate({ key: item.key, isBill });
  const unforce = () => override.mutate({ key: item.key, forced: false }, { onSuccess: () => router.back() });
  const cancelInfo = cancelInfoFor(item.payee);
  const openCancel = () => WebBrowser.openBrowserAsync(cancelInfo.url).catch(() => {});

  return (
    <ScrollView testID="recurring-detail-screen" style={styles.root} contentContainerStyle={{ padding: 16, paddingBottom: insets.bottom + 32 }}>
      <Stack.Screen options={{ title: item.payee }} />

      <View style={styles.hero}>
        <Text style={styles.amount}>{fmtPos(item.amount)}</Text>
        <Text style={styles.cadence}>{cadenceLabel(item.cadence)} · {item.category}</Text>
      </View>

      {item.priceChange ? (
        <View style={[styles.banner, { borderColor: item.priceChange.pct > 0 ? colors.red : colors.green }]}>
          <Text style={[styles.bannerText, { color: item.priceChange.pct > 0 ? colors.red : colors.green }]}>
            Price {item.priceChange.pct > 0 ? 'increased' : 'dropped'} {Math.abs(item.priceChange.pct)}% — {fmtPos(item.priceChange.from)} → {fmtPos(item.priceChange.to)}
          </Text>
        </View>
      ) : null}

      <Card style={styles.statsCard}>
        <Stat label="Status" value={cancelled ? 'Cancelled' : item.status === 'active' ? 'Active' : 'Inactive'} />
        <Stat label="Next renewal" value={item.status === 'active' ? fmtDay(item.nextRenewal) : '—'} />
        <Stat label="Renewal window" value={`${fmtDay(item.renewalWindow?.start ?? item.nextRenewal)} - ${fmtDay(item.renewalWindow?.end ?? item.nextRenewal)}`} />
        <Stat label="Last charged" value={fmtDay(item.lastCharged)} />
        <Stat label="Last amount" value={item.previousAmount ? `${fmtPos(item.previousAmount)} -> ${fmtPos(item.lastAmount)}` : fmtPos(item.lastAmount ?? item.amount)} />
        <Stat label="Confidence" value={`${item.confidence ?? 0}%`} />
        <Stat label="Seen" value={`${item.occurrences}× since ${fmtDay(item.firstCharged)}`} />
        <Stat label="Yearly cost" value={fmtMoney(item.monthlyEquivalent * 12)} last />
      </Card>

      {points.length > 1 ? (
        <Card style={{ marginTop: 16 }}>
          <CardTitle>Charge History</CardTitle>
          <AreaChart width={width - 64} points={points} color={colors.accentLight} />
        </Card>
      ) : null}

      <CardTitle style={{ marginTop: 16 }}>Type</CardTitle>
      <View style={styles.segment}>
        <Pressable testID="recurring-type-subscription-button" style={[styles.segBtn, !item.isBill && styles.segActive]} onPress={() => setIsBill(false)} disabled={override.isPending}>
          <Text style={[styles.segText, !item.isBill && styles.segTextActive]}>Subscription</Text>
        </Pressable>
        <Pressable testID="recurring-type-bill-button" style={[styles.segBtn, item.isBill && styles.segActive]} onPress={() => setIsBill(true)} disabled={override.isPending}>
          <Text style={[styles.segText, item.isBill && styles.segTextActive]}>Bill</Text>
        </Pressable>
      </View>
      <Text style={styles.segHint}>Bills show in Upcoming Bills; subscriptions in the Subscriptions list.</Text>

      {!item.isBill ? (
        <>
          <CardTitle style={{ marginTop: 16 }}>Cancellation Workflow</CardTitle>
          <Card style={styles.statsCard}>
            <Stat label="Workflow" value={item.cancellation?.status || (cancelled ? 'cancelled' : 'not started')} />
            <Stat label="Refund requested" value={item.cancellation?.refundRequested ? 'Yes' : 'No'} />
            <Stat label="Watch next renewal" value={item.cancellation?.watchNextRenewal ? 'Yes' : 'No'} />
            <Stat label="Confirmation" value={item.cancellation?.confirmationDate ? fmtDay(item.cancellation.confirmationDate) : '—'} last />
          </Card>
          <View style={styles.workflowGrid}>
            <Pressable testID="recurring-start-cancellation-button" style={styles.workflowBtn} onPress={() => override.mutate({ key: item.key, cancellation: { status: 'in_progress' } })} disabled={override.isPending}>
              <Text style={styles.workflowText}>Start cancellation</Text>
            </Pressable>
            <Pressable testID="recurring-refund-button" style={styles.workflowBtn} onPress={() => override.mutate({ key: item.key, cancellation: { refundRequested: !item.cancellation?.refundRequested } })} disabled={override.isPending}>
              <Text style={styles.workflowText}>{item.cancellation?.refundRequested ? 'Clear refund' : 'Request refund'}</Text>
            </Pressable>
            <Pressable testID="recurring-watch-renewal-button" style={styles.workflowBtn} onPress={() => override.mutate({ key: item.key, cancellation: { watchNextRenewal: !item.cancellation?.watchNextRenewal } })} disabled={override.isPending}>
              <Text style={styles.workflowText}>{item.cancellation?.watchNextRenewal ? 'Stop watching' : 'Watch renewal'}</Text>
            </Pressable>
            <Pressable testID="recurring-confirm-cancelled-button" style={styles.workflowBtn} onPress={() => override.mutate({ key: item.key, status: 'cancelled', cancellation: { status: 'confirmed', confirmationDate: financeToday } })} disabled={override.isPending}>
              <Text style={styles.workflowText}>Confirm cancelled</Text>
            </Pressable>
          </View>
        </>
      ) : null}

      <View style={styles.actions}>
        {item.forced ? (
          <Pressable testID="recurring-remove-button" style={({ pressed }) => [styles.btn, styles.btnGhost, pressed && { opacity: 0.8 }]} onPress={unforce} disabled={override.isPending}>
            <Text style={[styles.btnText, { color: colors.muted }]}>Remove from recurring</Text>
          </Pressable>
        ) : null}
        {!item.isBill ? (
          <Pressable testID="recurring-how-to-cancel-button" style={({ pressed }) => [styles.btn, styles.btnPrimary, pressed && { opacity: 0.85 }]} onPress={openCancel}>
            <Text style={[styles.btnText, { color: '#fff' }]}>How to cancel{cancelInfo.known ? '' : ' (search)'}</Text>
          </Pressable>
        ) : null}
        <Pressable testID="recurring-toggle-cancelled-button" style={({ pressed }) => [styles.btn, cancelled ? styles.btnPrimary : styles.btnDanger, pressed && { opacity: 0.8 }]} onPress={setCancelled} disabled={override.isPending}>
          <Text style={[styles.btnText, { color: cancelled ? '#fff' : colors.red }]}>
            {cancelled ? 'Mark as active' : 'Mark as cancelled'}
          </Text>
        </Pressable>
        <Pressable testID="recurring-hide-button" style={({ pressed }) => [styles.btn, styles.btnGhost, pressed && { opacity: 0.8 }]} onPress={hide} disabled={override.isPending}>
          <Text style={[styles.btnText, { color: colors.muted }]}>Hide from list</Text>
        </Pressable>
      </View>
    </ScrollView>
  );
}

function Stat({ label, value, last }: { label: string; value: string; last?: boolean }) {
  return (
    <View style={[styles.statRow, last && { borderBottomWidth: 0 }]}>
      <Text style={styles.statLabel}>{label}</Text>
      <Text style={styles.statValue}>{value}</Text>
    </View>
  );
}

const styles = StyleSheet.create({
  root: { flex: 1, backgroundColor: colors.bg },
  center: { alignItems: 'center', justifyContent: 'center' },
  muted: { color: colors.muted, fontSize: 14 },
  hero: { alignItems: 'center', marginVertical: 12 },
  amount: { color: colors.text, fontSize: 40, fontWeight: '800', letterSpacing: -1.5 },
  cadence: { color: colors.muted, fontSize: 14, marginTop: 4 },
  banner: { borderWidth: 1, borderRadius: 12, padding: 12, marginBottom: 12 },
  bannerText: { fontSize: 13, fontWeight: '600', textAlign: 'center' },
  statsCard: { paddingVertical: 4 },
  statRow: { flexDirection: 'row', justifyContent: 'space-between', alignItems: 'center', paddingVertical: 12, borderBottomWidth: StyleSheet.hairlineWidth, borderBottomColor: colors.border },
  statLabel: { color: colors.muted, fontSize: 13 },
  statValue: { color: colors.text, fontSize: 14, fontWeight: '600' },
  segment: { flexDirection: 'row', gap: 8, marginTop: 4 },
  segBtn: { flex: 1, paddingVertical: 12, borderRadius: 10, alignItems: 'center', borderWidth: 1, borderColor: colors.border, backgroundColor: colors.surface },
  segActive: { borderColor: colors.accent, backgroundColor: 'rgba(124,110,247,0.12)' },
  segText: { color: colors.muted, fontSize: 14, fontWeight: '600' },
  segTextActive: { color: colors.accentLight },
  segHint: { color: colors.muted, fontSize: 11, marginTop: 8 },
  actions: { marginTop: 20, gap: 10 },
  workflowGrid: { flexDirection: 'row', flexWrap: 'wrap', gap: 8, marginTop: 10 },
  workflowBtn: { width: '48%', flexGrow: 1, paddingVertical: 11, paddingHorizontal: 10, borderRadius: 10, borderWidth: 1, borderColor: colors.border, backgroundColor: colors.surface },
  workflowText: { color: colors.accentLight, fontSize: 12, fontWeight: '700', textAlign: 'center' },
  btn: { paddingVertical: 14, borderRadius: 12, alignItems: 'center', borderWidth: 1 },
  btnPrimary: { backgroundColor: colors.accent, borderColor: colors.accent },
  btnDanger: { borderColor: colors.red, backgroundColor: 'rgba(239,68,68,0.08)' },
  btnGhost: { borderColor: colors.border },
  btnText: { fontSize: 15, fontWeight: '600' },
});
