import React, { useMemo, useState } from 'react';
import { ActivityIndicator, Pressable, StyleSheet, Text, View } from 'react-native';
import { useLocalSearchParams, useRouter } from 'expo-router';
import { SymbolView } from 'expo-symbols';
import { useReconciliation, useSetReconcileItem, useSetReconcileMonth } from '@/api/hooks/finance.hooks';
import { PushScreen } from '@/components/screen';
import { QueryScreenBody } from '@/components/query-display';
import { Card, EmptyState, ErrorState } from '@/components/ui';
import { MutationFormBanner, MutationLiveRegion } from '@/components/mutation-form';
import { SkeletonList } from '@/components/skeleton';
import { useMutationAction } from '@/hooks/useMutationAction';
import { useMutationBannerCoordinator } from '@/hooks/useMutationBannerCoordinator';
import { useMutationScreenAdmission } from '@/hooks/useMutationScreenAdmission';
import { useMutationScreen } from '@/hooks/useMutationScreen';
import { ReconItem } from '@/api/generated/types';
import { haptics } from '@/lib/haptics';
import { useCurrentMonthKey } from '@/lib/selectedMonth';
import { colors, fmtDate, fmtSignedMoney, monthLabel } from '@/theme/colors';

const stepMonth = (key: string, delta: number) => {
  const [y, m] = key.split('-').map(Number);
  const d = new Date(Date.UTC(y, m - 1 + delta, 1));
  return `${d.getUTCFullYear()}-${String(d.getUTCMonth() + 1).padStart(2, '0')}`;
};

export default function Reconcile() {
  const params = useLocalSearchParams<{ month?: string }>();
  const curKey = useCurrentMonthKey();
  const initialMonth = params.month || stepMonth(curKey, -1);
  return <ReconcileContent key={initialMonth} initialMonth={initialMonth} />;
}

function ReconcileContent({ initialMonth }: { initialMonth: string }) {
  const router = useRouter();
  const curKey = useCurrentMonthKey();
  // Deep-link (from the nag banner) wins; otherwise default to last month.
  const [month, setMonth] = useState(initialMonth);

  const recon = useReconciliation(month);
  const setItem = useSetReconcileItem();
  const closeMonth = useSetReconcileMonth();
  const admissionRef = useMutationScreenAdmission();
  const screen = useMutationScreen({ onRefetchStale: () => recon.refetch(), admissionRef });
  const closeAction = useMutationAction({
    mutation: closeMonth,
    mutationLabel: 'Close month',
    admissionRef,
    onActivate: () => screen.clear(),
    onRefetch: () => recon.refetch(),
    onSuccess: () => screen.clear(),
  });
  const toggleAction = screen.bind({ key: 'toggle', mutation: setItem, mutationLabel: 'Update reconciliation' });
  const banner = useMutationBannerCoordinator(useMemo(() => [
    { key: 'toggle', outcome: screen.outcome, retry: screen.retry, announce: screen.announce, isLocked: screen.isLocked, activitySeq: screen.activitySeq },
    { key: 'close', outcome: closeAction.outcome, retry: closeAction.retry, announce: closeAction.announce, isLocked: closeAction.isLocked, activitySeq: closeAction.activitySeq },
  ], [
    closeAction.activitySeq, closeAction.announce, closeAction.isLocked, closeAction.outcome, closeAction.retry,
    screen.activitySeq, screen.announce, screen.isLocked, screen.outcome, screen.retry,
  ]));

  const toggle = (it: ReconItem) => {
    if (banner.isLocked) return;
    haptics.tap();
    toggleAction.run({ month, id: it.id, reconciled: !it.reconciled });
  };

  const data = recon.data;
  const items = data?.items ?? [];
  const total = data?.total ?? 0;
  const done = data?.reconciledCount ?? 0;
  const allDone = total > 0 && done >= total;
  const monthClosed = !!data?.done;
  const pct = total > 0 ? (done / total) * 100 : 0;
  const canNext = month < curKey;

  const openTxn = (it: ReconItem) => {
    haptics.tap();
    router.push({
      pathname: '/transaction/[id]',
      params: { id: it.id, date: it.date, accountId: it.accountId },
    });
  };
  const doClose = () => {
    if (!allDone || monthClosed || banner.isLocked) return;
    closeAction.run({ month, done: true });
  };

  return (
    <PushScreen testID="reconcile-screen" onRefresh={recon.refetch}>
      <MutationLiveRegion message={banner.announce} />
      <MutationFormBanner
        outcome={banner.outcome}
        onRetry={banner.retry}
        onRefetch={() => { void screen.refetchStale(); recon.refetch(); }}
      />
      <View style={styles.nav}>
        <Pressable testID="reconcile-prev-month" onPress={() => { haptics.tap(); setMonth(stepMonth(month, -1)); }} hitSlop={12} style={({ pressed }) => [styles.navBtn, pressed && { opacity: 0.5 }]}>
          <Text style={styles.navArrow}>‹</Text>
        </Pressable>
        <Text style={styles.navTitle}>{monthLabel(month)}</Text>
        <Pressable testID="reconcile-next-month" disabled={!canNext} onPress={() => { haptics.tap(); setMonth(stepMonth(month, 1)); }} hitSlop={12} style={({ pressed }) => [styles.navBtn, pressed && canNext && { opacity: 0.5 }]}>
          <Text style={[styles.navArrow, !canNext && styles.navArrowOff]}>›</Text>
        </Pressable>
      </View>

      {recon.isLoading && !data ? (
        <SkeletonList rows={8} />
      ) : recon.isError && !data ? (
        <ErrorState error={recon.error?.error} onRetry={recon.refetch} />
      ) : (
        <QueryScreenBody
          query={recon}
          loading={null}
          empty={<EmptyState icon="checkmark.circle">No transactions to reconcile in {monthLabel(month)}</EmptyState>}
          hasContent={total > 0}
          refetchBannerTestID="reconcile-refetch-banner"
        >
          <Card style={styles.head}>
            {monthClosed ? (
              <View style={styles.closedRow}>
                <SymbolView name="checkmark.seal.fill" tintColor={colors.green} size={22} resizeMode="scaleAspectFit" />
                <Text style={styles.closedText}>{monthLabel(month)} reconciled</Text>
              </View>
            ) : (
              <>
                <Text style={styles.headTitle}>{done} of {total} reviewed</Text>
                <View style={styles.track}><View style={[styles.fill, { width: `${pct}%` }]} /></View>
                <Text style={styles.headSub}>{allDone ? 'All transactions reviewed — close the month below.' : `${total - done} left to review`}</Text>
              </>
            )}
          </Card>

          <Card style={styles.list}>
            {items.map((it, i) => (
              <View key={it.id} testID={`reconcile-item-${i}`} style={[styles.row, i > 0 && styles.rowDiv]}>
                <Pressable testID={`reconcile-item-toggle-${i}`} onPress={() => toggle(it)} hitSlop={8} disabled={banner.isLocked} style={({ pressed }) => [pressed && !banner.isLocked && { opacity: 0.6 }, banner.isLocked && { opacity: 0.5 }]}>
                  <SymbolView name={it.reconciled ? 'checkmark.circle.fill' : 'circle'} tintColor={it.reconciled ? colors.green : colors.muted} size={26} resizeMode="scaleAspectFit" />
                </Pressable>
                <Pressable testID={`reconcile-item-row-${i}`} style={styles.rowBody} onPress={() => openTxn(it)}>
                  <View style={{ flex: 1, minWidth: 0 }}>
                    <Text style={[styles.rowPayee, it.reconciled && styles.rowPayeeDone]} numberOfLines={1}>{it.payee}</Text>
                    <Text style={styles.rowSub} numberOfLines={1}>{fmtDate(it.date)} · {it.category}</Text>
                  </View>
                  <Text style={[styles.rowAmt, { color: it.amount > 0 ? colors.green : colors.text }]}>{fmtSignedMoney(it.amount)}</Text>
                </Pressable>
              </View>
            ))}
          </Card>

          {!monthClosed ? (
            <Pressable testID="reconcile-close-month-button" onPress={doClose} disabled={!allDone || banner.isLocked} style={({ pressed }) => [styles.closeBtn, (!allDone || banner.isLocked) && styles.closeBtnOff, pressed && allDone && !banner.isLocked && { opacity: 0.8 }]}>
              {closeAction.isLocked ? (
                <ActivityIndicator color="#fff" />
              ) : (
                <Text style={styles.closeBtnText}>{allDone ? `Reconcile ${monthLabel(month)}` : `${total - done} left to review`}</Text>
              )}
            </Pressable>
          ) : null}
        </QueryScreenBody>
      )}
    </PushScreen>
  );
}

const styles = StyleSheet.create({
  nav: { flexDirection: 'row', alignItems: 'center', justifyContent: 'space-between', marginBottom: 14, paddingHorizontal: 4 },
  navBtn: { width: 44, height: 32, alignItems: 'center', justifyContent: 'center' },
  navArrow: { color: colors.accentLight, fontSize: 26, fontWeight: '700' },
  navArrowOff: { color: colors.border },
  navTitle: { color: colors.text, fontSize: 17, fontWeight: '700' },
  head: { marginBottom: 0 },
  headTitle: { color: colors.text, fontSize: 18, fontWeight: '800' },
  track: { height: 8, borderRadius: 4, backgroundColor: colors.surface2, marginTop: 10, overflow: 'hidden' },
  fill: { height: '100%', borderRadius: 4, backgroundColor: colors.green },
  headSub: { color: colors.muted, fontSize: 12, marginTop: 8 },
  closedRow: { flexDirection: 'row', alignItems: 'center', gap: 8 },
  closedText: { color: colors.green, fontSize: 16, fontWeight: '700' },
  list: { paddingVertical: 2, marginTop: 12 },
  row: { flexDirection: 'row', alignItems: 'center', gap: 12, paddingVertical: 10 },
  rowDiv: { borderTopWidth: StyleSheet.hairlineWidth, borderTopColor: colors.border },
  rowBody: { flex: 1, flexDirection: 'row', alignItems: 'center', gap: 10 },
  rowPayee: { color: colors.text, fontSize: 14, fontWeight: '600' },
  rowPayeeDone: { color: colors.muted, textDecorationLine: 'line-through' },
  rowSub: { color: colors.muted, fontSize: 11, marginTop: 2 },
  rowAmt: { color: colors.text, fontSize: 14, fontWeight: '700' },
  closeBtn: { backgroundColor: colors.green, borderRadius: 12, paddingVertical: 15, alignItems: 'center', marginTop: 16 },
  closeBtnOff: { backgroundColor: colors.surface2 },
  closeBtnText: { color: '#fff', fontSize: 15, fontWeight: '700' },
});
