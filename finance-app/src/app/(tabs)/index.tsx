import React, { useState } from 'react';
import { ActivityIndicator, Alert, Pressable, StyleSheet, Text, useWindowDimensions, View } from 'react-native';
import { useRouter } from 'expo-router';
import { SymbolView, SymbolViewProps } from 'expo-symbols';
import { useBankSync, useManualAssets, usePing, useRecurring, useToday, useTrends } from '@/api/hooks/finance.hooks';
import { Screen } from '@/components/screen';
import { Avatar, Card, CardTitle, EmptyState, ErrorState, ListRow, SectionLabel, StatCard } from '@/components/ui';
import { SkeletonList } from '@/components/skeleton';
import { AreaChart } from '@/components/charts';
import { Account } from '@/api/generated/types';
import { haptics } from '@/lib/haptics';
import { useDashboardWidgets } from '@/lib/dashboard-widgets';
import { financeToday } from '@/lib/date-only';
import { colors, dueLabel, fmtMoney, fmtPos } from '@/theme/colors';

const RANGES: { label: string; v: number }[] = [
  { label: '3M', v: 3 },
  { label: '6M', v: 6 },
  { label: '1Y', v: 12 },
  { label: '2Y', v: 24 },
  { label: '3Y', v: 36 },
];

const ACTIONS: { label: string; route: string; symbol: SymbolViewProps['name']; color: string }[] = [
  { label: 'Budgets', route: '/budgets', symbol: 'chart.pie.fill', color: colors.accentLight },
  { label: 'Cash Flow', route: '/cashflow', symbol: 'arrow.left.arrow.right', color: '#06b6d4' },
  { label: 'Goals', route: '/goals', symbol: 'target', color: '#f59e0b' },
  { label: 'Who Owes Me', route: '/reimbursement', symbol: 'person.2.fill', color: '#22c55e' },
];

export default function Overview() {
  const { width } = useWindowDimensions();
  const router = useRouter();
  const [months, setMonths] = useState(12);
  const { visible: widgets } = useDashboardWidgets();

  const today = useToday();
  const ping = usePing();
  const trends = useTrends(months);
  const recurring = useRecurring();
  const manual = useManualAssets();
  const bankSync = useBankSync();
  const reviewCount = today.data?.review.count ?? 0;
  const topReview = today.data?.review.tasks?.[0] ?? null;

  const doBankSync = () => {
    if (bankSync.isPending) return;
    haptics.tap();
    bankSync.mutate(undefined, {
      onSuccess: (r) => {
        haptics.success();
        const cleared = r?.phantom?.deletedCount ?? 0;
        if (r?.warning) Alert.alert('Synced with a warning', `Your ledger was refreshed, but the bank fetch reported: ${r.warning}`);
        else if (cleared > 0) Alert.alert('Synced', `${cleared} stale pending charge${cleared === 1 ? '' : 's'} may need cleanup. Nothing was deleted.`);
      },
      onError: (e) => { haptics.warning(); Alert.alert('Sync failed', e.error || 'Please try again.'); },
    });
  };

  const onRefresh = () => Promise.all([
    today.refetch(),
    trends.refetch(),
    recurring.refetch(),
    manual.refetch(),
  ]);

  const accts = (today.data?.accounts ?? []).filter((a) => !a.hidden);
  const acctAssets = accts.filter((a) => a.balance > 0).reduce((s, a) => s + a.balance, 0);
  const acctLiab = accts.filter((a) => a.balance < 0).reduce((s, a) => s + a.balance, 0);
  const assets = acctAssets + (manual.data?.assets ?? 0);
  const liabilities = acctLiab - (manual.data?.liabilities ?? 0);
  const netWorth = assets + liabilities;

  const curMonth = financeToday().slice(0, 7);
  const cur = today.data?.spending.current;
  const prev = today.data?.spending.prev;
  const net = cur ? cur.totalIncome - cur.totalSpend : 0;
  const spendDelta = cur && prev && prev.totalSpend > 0 ? ((cur.totalSpend - prev.totalSpend) / prev.totalSpend) * 100 : null;

  const nwPoints = (trends.data?.months ?? []).map((m) => ({ value: m.netWorth, label: m.month }));
  // "This month" net-worth change ≈ now vs the previous monthly snapshot. Based on
  // synced accounts only, since manual assets have no monthly history.
  const nwHist = trends.data?.months ?? [];
  const prevNW = nwHist.length >= 2 ? nwHist[nwHist.length - 2].netWorth : null;
  const nwDelta = prevNW != null ? acctAssets + acctLiab - prevNW : null;

  const cash = accts.filter((a) => a.role === 'operating_cash' || a.role === 'protected_savings');
  const credit = accts.filter((a) => a.role === 'credit_card' || a.role === 'loan');
  const invest = accts.filter((a) => a.role === 'investment' || a.role === 'excluded' || a.role === 'unknown');
  const groups: { title: string; items: Account[] }[] = [
    { title: 'Cash', items: cash },
    { title: 'Credit & Loans', items: credit },
    { title: 'Investments & Other', items: invest },
  ].filter((g) => g.items.length);

  const upcoming = (today.data?.obligations.bills ?? []).slice(0, 3);
  const nextIncome = today.data?.obligations.nextIncome;
  const safeToSpend = today.data?.liquidity.safeToSpend;

  return (
    <Screen title="dark" accent="finances" onRefresh={onRefresh} testID="home-screen">
      {!today.data && today.isLoading ? (
        <SkeletonList hero rows={4} />
      ) : !today.data && today.isError ? (
        <ErrorState error={today.error?.error} onRetry={onRefresh} />
      ) : (
        <>
          <View testID="today-health-strip" style={styles.healthStrip}>
            <View style={[styles.healthDot, { backgroundColor: ping.isError ? colors.red : today.data?.health.ready ? colors.green : colors.yellow }]} />
            <Text style={styles.healthText}>
              {ping.isError
                ? `Offline · showing data loaded this session · as of ${today.data?.asOf ?? today.data?.financeDate}`
                : `${today.data?.health.ready ? 'Ledger ready' : 'Ledger needs attention'} · as of ${today.data?.financeDate}`}
            </Text>
          </View>

          {reviewCount > 0 ? (
            <Pressable testID="home-review-banner" onPress={() => { haptics.tap(); router.push('/review' as never); }} style={({ pressed }) => pressed && { opacity: 0.6 }}>
              <Card style={{ ...styles.bannerCard, ...styles.reviewBanner }}>
                <View style={[styles.bannerIcon, { backgroundColor: colors.yellow + '22' }]}>
                  <SymbolView name="checklist" tintColor={colors.yellow} size={22} resizeMode="scaleAspectFit" />
                </View>
                <View style={{ flex: 1 }}>
                  <Text style={styles.bannerLabel}>Review today</Text>
                  <Text style={styles.bannerSub}>{topReview ? `${topReview.title} · ${topReview.subtitle}` : `${reviewCount} item${reviewCount === 1 ? '' : 's'} need attention`}</Text>
                </View>
                <Text style={[styles.bannerValue, { color: colors.yellow }]}>{reviewCount} ›</Text>
              </Card>
            </Pressable>
          ) : (
            <Card style={styles.allClearCard}>
              <SymbolView name="checkmark.circle.fill" tintColor={colors.green} size={20} resizeMode="scaleAspectFit" />
              <Text style={styles.allClearText}>Nothing needs review</Text>
            </Card>
          )}

          {safeToSpend?.complete && safeToSpend.value != null ? (
            <Card testID="today-safe-to-spend" style={styles.liquidityCard}>
              <View style={{ flex: 1 }}>
                <Text style={styles.heroLabel}>AVAILABLE AFTER THIS MONTH&apos;S PLAN</Text>
                <Text style={[styles.liquidityValue, { color: safeToSpend.value >= 0 ? colors.text : colors.red }]}>{fmtMoney(safeToSpend.value)}</Text>
                <Text style={styles.heroSub}>{safeToSpend.provenance.method}</Text>
              </View>
              <SymbolView name="wallet.pass.fill" tintColor={colors.accentLight} size={28} resizeMode="scaleAspectFit" />
            </Card>
          ) : safeToSpend ? (
            <Pressable onPress={() => router.push('/networth' as never)} style={({ pressed }) => pressed && { opacity: 0.7 }}>
              <Card style={styles.incompleteCard}>
                <Text style={styles.incompleteTitle}>Liquidity estimate hidden</Text>
                <Text style={styles.incompleteText}>{safeToSpend.incompleteReasons.join(' · ')}. Assign each account&apos;s financial role to enable it.</Text>
              </Card>
            </Pressable>
          ) : null}

          {widgets.netWorth ? (
            <Pressable testID="home-networth-hero" onPress={() => { haptics.tap(); router.push('/networth' as never); }} style={({ pressed }) => [styles.hero, pressed && { opacity: 0.7 }]}>
              <Text style={styles.heroLabel}>NET WORTH</Text>
              <Text style={[styles.heroValue, { color: netWorth >= 0 ? colors.text : colors.red }]}>{fmtMoney(netWorth)}</Text>
              <View style={styles.heroMetaRow}>
                {nwDelta != null ? (
                  <Text style={[styles.heroDelta, { color: nwDelta >= 0 ? colors.green : colors.red }]}>
                    {nwDelta >= 0 ? '▲' : '▼'} {fmtPos(Math.abs(nwDelta))} this month
                  </Text>
                ) : null}
                <Text style={styles.heroSub}>{fmtPos(assets)} assets · {fmtPos(Math.abs(liabilities))} liabilities · details ›</Text>
              </View>
            </Pressable>
          ) : null}

          {widgets.netWorth && nwPoints.length > 1 ? (
            <Card style={{ marginBottom: 16 }}>
              <View style={styles.chartHead}>
                <CardTitle>Net Worth</CardTitle>
                <Text style={styles.chartHint}>Touch & drag</Text>
              </View>
              <AreaChart width={width - 64} points={nwPoints} />
              <View style={styles.rangeRow}>
                {RANGES.map((r) => (
                  <Pressable
                    key={r.label}
                    onPress={() => { haptics.tap(); setMonths(r.v); }}
                    style={({ pressed }) => [styles.range, months === r.v && styles.rangeActive, pressed && { opacity: 0.7 }]}
                  >
                    <Text style={[styles.rangeText, months === r.v && styles.rangeTextActive]}>{r.label}</Text>
                  </Pressable>
                ))}
              </View>
            </Card>
          ) : null}

          {widgets.actions ? <View style={styles.tiles}>
            {ACTIONS.map((a) => (
              <Pressable
                testID={`home-action-${a.label.toLowerCase().replace(/[^a-z0-9]+/g, '-')}`}
                key={a.route}
                style={({ pressed }) => [styles.tile, pressed && { opacity: 0.6, transform: [{ scale: 0.97 }] }]}
                onPress={() => { haptics.tap(); router.push(a.route as never); }}
              >
                <View style={[styles.tileIcon, { backgroundColor: a.color + '22' }]}>
                  <SymbolView name={a.symbol} tintColor={a.color} size={22} resizeMode="scaleAspectFit" />
                </View>
                <Text style={styles.tileLabel} numberOfLines={2}>{a.label}</Text>
              </Pressable>
            ))}
          </View> : null}

          {widgets.monthlyStats ? <>
          <SectionLabel>This Month</SectionLabel>
          <View style={styles.statsRow}>
            <StatCard
              testID="home-stat-spent"
              label="Spent"
              value={cur ? fmtPos(cur.totalSpend) : '—'}
              sub={spendDelta != null ? `${spendDelta > 0 ? '▲' : '▼'} ${Math.abs(spendDelta).toFixed(0)}% vs prev` : undefined}
              subColor={spendDelta != null ? (spendDelta > 0 ? colors.red : colors.green) : undefined}
            />
            <StatCard
              testID="home-stat-income"
              label="Income"
              value={cur ? fmtPos(cur.totalIncome) : '—'}
              sub="sources ›"
              onPress={() => router.push(`/category/${encodeURIComponent('Income')}?month=${curMonth}` as never)}
            />
            <StatCard testID="home-stat-net" label="Net" value={cur ? fmtMoney(net) : '—'} valueColor={net >= 0 ? colors.green : colors.red} />
          </View>
          </> : null}

          {widgets.income && nextIncome?.nextPay ? (
            <Pressable testID="home-income-banner" onPress={() => router.push('/income' as never)} style={({ pressed }) => pressed && { opacity: 0.6 }}>
              <Card style={styles.bannerCard}>
                <View style={[styles.bannerIcon, { backgroundColor: colors.green + '22' }]}>
                  <SymbolView name="dollarsign.circle.fill" tintColor={colors.green} size={22} resizeMode="scaleAspectFit" />
                </View>
                <View style={{ flex: 1, paddingRight: 12 }}>
                  <Text style={styles.bannerLabel}>Next income</Text>
                  <Text style={styles.bannerSub} numberOfLines={1}>{nextIncome.payee || 'Income'} · estimated {dueLabel(nextIncome.nextPay)}</Text>
                </View>
                <Text style={[styles.bannerValue, { color: colors.green }]}>+{fmtPos(nextIncome.amount ?? 0)} ›</Text>
              </Card>
            </Pressable>
          ) : null}

          {widgets.subscriptions && recurring.data && (recurring.data.subMonthlyTotal ?? recurring.data.monthlyTotal) > 0 ? (
            <Pressable testID="home-subscriptions-banner" onPress={() => router.push('/subscriptions' as never)} style={({ pressed }) => pressed && { opacity: 0.6 }}>
              <Card style={styles.bannerCard}>
                <View style={[styles.bannerIcon, { backgroundColor: colors.accentLight + '22' }]}>
                  <SymbolView name="repeat" tintColor={colors.accentLight} size={20} resizeMode="scaleAspectFit" />
                </View>
                <View style={{ flex: 1 }}>
                  <Text style={styles.bannerLabel}>Subscriptions</Text>
                  <Text style={styles.bannerSub}>{recurring.data.subActiveCount ?? recurring.data.activeCount} active</Text>
                </View>
                <Text style={styles.bannerValue}>{fmtMoney(recurring.data.subMonthlyTotal ?? recurring.data.monthlyTotal)}/mo ›</Text>
              </Card>
            </Pressable>
          ) : null}

          {widgets.bills && upcoming.length ? (
            <View style={{ marginTop: 4 }}>
              <SectionLabel right={<Text style={styles.seeAll} onPress={() => router.push('/bills' as never)}>See all</Text>}>Upcoming Bills</SectionLabel>
              <Card style={styles.list}>
                {upcoming.map((b, i) => (
                  <ListRow
                    key={`${b.key}-${i}`}
                    testID={`home-bill-row-${i}`}
                    avatar={<Avatar label={b.payee} category={b.category} size={34} />}
                    title={b.payee}
                    subtitle={`Estimated ${dueLabel(b.dueDate)}`}
                    value={fmtPos(b.amount)}
                    chevron={false}
                  />
                ))}
              </Card>
            </View>
          ) : null}

          {widgets.accounts ? <>
          <SectionLabel>Accounts</SectionLabel>
          {accts.length === 0 ? (
            <EmptyState icon="building.columns">No accounts</EmptyState>
          ) : (
            groups.map((g) => (
              <View key={g.title} style={{ marginBottom: 14 }}>
                <View style={styles.groupHead}>
                  <Text style={styles.groupTitle}>{g.title}</Text>
                  <Text style={styles.groupTotal}>{fmtMoney(g.items.reduce((s, a) => s + a.balance, 0))}</Text>
                </View>
                <View style={styles.accountsGrid}>
                  {g.items.map((a) => (
                    <Pressable
                      testID={`home-account-${a.id}`}
                      key={a.id}
                      style={({ pressed }) => [styles.accountCard, pressed && { opacity: 0.6 }]}
                      onPress={() => router.push({ pathname: '/account/[id]', params: { id: a.id, name: a.name, balance: String(a.balance), hidden: a.hidden ? '1' : '', role: a.role } })}
                    >
                      <Card>
                        <Text style={styles.accountName} numberOfLines={1}>{a.name}</Text>
                        <Text style={[styles.accountBalance, { color: a.balance < 0 ? colors.red : colors.text }]}>{fmtMoney(a.balance)}</Text>
                      </Card>
                    </Pressable>
                  ))}
                </View>
              </View>
            ))
          )}
          </> : null}

          {accts.length ? (
            <Pressable
              testID="home-sync-button"
              onPress={doBankSync}
              disabled={bankSync.isPending}
              style={({ pressed }) => [styles.syncBtn, pressed && { opacity: 0.6 }]}
            >
              {bankSync.isPending ? (
                <ActivityIndicator color={colors.accentLight} size="small" />
              ) : (
                <SymbolView name="arrow.triangle.2.circlepath" tintColor={colors.accentLight} size={18} resizeMode="scaleAspectFit" />
              )}
              <Text style={styles.syncText}>{bankSync.isPending ? 'Syncing…' : 'Sync with bank'}</Text>
            </Pressable>
          ) : null}
        </>
      )}
    </Screen>
  );
}

const styles = StyleSheet.create({
  healthStrip: { flexDirection: 'row', alignItems: 'center', gap: 7, marginTop: 4, marginBottom: 12 },
  healthDot: { width: 8, height: 8, borderRadius: 4 },
  healthText: { color: colors.muted, fontSize: 11, fontWeight: '600' },
  allClearCard: { flexDirection: 'row', alignItems: 'center', gap: 10, marginBottom: 14 },
  allClearText: { color: colors.text, fontSize: 14, fontWeight: '700' },
  liquidityCard: { flexDirection: 'row', alignItems: 'center', gap: 12, marginBottom: 18 },
  liquidityValue: { fontSize: 30, fontWeight: '800', letterSpacing: -1, marginTop: 4 },
  incompleteCard: { marginBottom: 18, borderColor: colors.yellow + '55', borderWidth: 1 },
  incompleteTitle: { color: colors.yellow, fontSize: 13, fontWeight: '800' },
  incompleteText: { color: colors.muted, fontSize: 12, lineHeight: 17, marginTop: 4 },
  chartHead: { flexDirection: 'row', alignItems: 'center', justifyContent: 'space-between' },
  chartHint: { color: colors.muted, fontSize: 10, fontWeight: '600', textTransform: 'uppercase', letterSpacing: 0.5 },
  rangeRow: { flexDirection: 'row', justifyContent: 'space-between', marginTop: 12, gap: 6 },
  range: { flex: 1, paddingVertical: 6, borderRadius: 8, alignItems: 'center', backgroundColor: colors.surface2 },
  rangeActive: { backgroundColor: colors.accent },
  rangeText: { color: colors.muted, fontSize: 12, fontWeight: '700' },
  rangeTextActive: { color: '#fff' },
  hero: { marginBottom: 18, marginTop: 8 },
  heroLabel: { color: colors.muted, fontSize: 11, fontWeight: '700', letterSpacing: 1 },
  heroValue: { fontSize: 42, fontWeight: '800', letterSpacing: -1.5, marginTop: 4 },
  heroMetaRow: { marginTop: 6, gap: 2 },
  heroDelta: { fontSize: 13, fontWeight: '700' },
  heroSub: { color: colors.muted, fontSize: 13 },
  tiles: { flexDirection: 'row', gap: 8, marginBottom: 20 },
  tile: { flex: 1, alignItems: 'center', gap: 8, paddingVertical: 14, backgroundColor: colors.surface, borderColor: colors.border, borderWidth: 1, borderRadius: 14 },
  tileIcon: { width: 44, height: 44, borderRadius: 22, alignItems: 'center', justifyContent: 'center' },
  tileLabel: { color: colors.text, fontSize: 11, fontWeight: '600', textAlign: 'center', paddingHorizontal: 2 },
  statsRow: { flexDirection: 'row', gap: 10, marginBottom: 16 },
  bannerCard: { flexDirection: 'row', alignItems: 'center', gap: 12, marginBottom: 12 },
  reviewBanner: { borderColor: colors.yellow + '55', borderWidth: 1 },
  bannerIcon: { width: 38, height: 38, borderRadius: 19, alignItems: 'center', justifyContent: 'center' },
  bannerLabel: { color: colors.text, fontSize: 15, fontWeight: '700' },
  bannerSub: { color: colors.muted, fontSize: 12, marginTop: 2 },
  bannerValue: { color: colors.accentLight, fontSize: 15, fontWeight: '700' },
  seeAll: { color: colors.accentLight, fontSize: 12, fontWeight: '600' },
  list: { paddingVertical: 2 },
  groupHead: { flexDirection: 'row', justifyContent: 'space-between', alignItems: 'center', marginBottom: 8 },
  groupTitle: { color: colors.text, fontSize: 14, fontWeight: '700' },
  groupTotal: { color: colors.muted, fontSize: 13, fontWeight: '600' },
  accountsGrid: { flexDirection: 'row', flexWrap: 'wrap', gap: 10 },
  accountCard: { width: '47.5%', flexGrow: 1 },
  accountName: { color: colors.muted, fontSize: 12, marginBottom: 6 },
  accountBalance: { fontSize: 20, fontWeight: '700', letterSpacing: -0.5 },
  syncBtn: { flexDirection: 'row', alignItems: 'center', justifyContent: 'center', gap: 8, paddingVertical: 13, borderRadius: 12, borderWidth: 1, borderColor: colors.border, backgroundColor: colors.surface, marginTop: 2, marginBottom: 8 },
  syncText: { color: colors.accentLight, fontSize: 14, fontWeight: '700' },
});
