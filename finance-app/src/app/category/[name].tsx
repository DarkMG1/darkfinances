import React, { useMemo, useState } from 'react';
import { Pressable, RefreshControl, ScrollView, StyleSheet, Text, View } from 'react-native';
import Animated, { FadeInDown } from 'react-native-reanimated';
import { SymbolView } from 'expo-symbols';
import { Stack, useLocalSearchParams, useRouter } from 'expo-router';
import { useSafeAreaInsets } from 'react-native-safe-area-context';
import { useTransactions } from '@/api/hooks/finance.hooks';
import { DemoRibbon } from '@/components/screen';
import { Avatar, EmptyState, ErrorState, PendingPill } from '@/components/ui';
import { SkeletonList } from '@/components/skeleton';
import { haptics } from '@/lib/haptics';
import { categoryIcon } from '@/theme/categoryIcons';
import { colors, fmtDate, fmtPos, monthLabel } from '@/theme/colors';

const pad = (n: number) => String(n).padStart(2, '0');
const ymd = (d: Date) => `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}`;

type CatRange = 'month' | '3m' | 'year' | 'all';
type SortKey = 'newest' | 'oldest' | 'amount';
const RANGES: { key: CatRange; label: string }[] = [
  { key: 'month', label: 'Month' },
  { key: '3m', label: '3M' },
  { key: 'year', label: 'Year' },
  { key: 'all', label: 'All' },
];

function rangeWindow(key: CatRange, month?: string, explicitStart?: string, explicitEnd?: string, explicitLabel?: string): { start: string; end: string; label: string } {
  if (explicitStart && explicitEnd) return { start: explicitStart, end: explicitEnd, label: explicitLabel || 'Selected period' };
  const now = new Date();
  const end = ymd(now);
  if (key === 'month') {
    if (month) {
      const [y, m] = month.split('-').map(Number);
      const last = new Date(y, m, 0).getDate();
      return { start: `${month}-01`, end: `${month}-${pad(last)}`, label: monthLabel(month) };
    }
    return { start: `${now.getFullYear()}-${pad(now.getMonth() + 1)}-01`, end, label: 'This month' };
  }
  if (key === '3m') { const d = new Date(now); d.setMonth(d.getMonth() - 2); return { start: `${d.getFullYear()}-${pad(d.getMonth() + 1)}-01`, end, label: 'Last 3 months' }; }
  if (key === 'year') return { start: `${now.getFullYear()}-01-01`, end, label: 'This year' };
  return { start: '2000-01-01', end, label: 'All time' };
}

export default function CategoryDetail() {
  const router = useRouter();
  const insets = useSafeAreaInsets();
  const params = useLocalSearchParams<{ name: string; month?: string; range?: string; start?: string; end?: string; label?: string }>();
  // expo-router already decodes route params; use as-is.
  const name = params.name ?? '';
  const isAllSpending = /^(spending|total spend)$/i.test(name);
  const isIncome = /^(income|earnings)$/i.test(name);
  const [range, setRange] = useState<CatRange>(
    (RANGES.some((r) => r.key === params.range) ? (params.range as CatRange) : 'month')
  );
  const [sort, setSort] = useState<SortKey>('newest');
  const { start, end, label } = rangeWindow(range, params.month, params.start, params.end, params.label);
  const chartWindow = useMemo(() => {
    const base = params.month ? (() => { const [y, m] = params.month!.split('-').map(Number); return new Date(y, m - 1, 1); })() : new Date();
    const first = new Date(base.getFullYear(), base.getMonth() - 5, 1);
    const last = new Date(base.getFullYear(), base.getMonth() + 1, 0);
    return { start: ymd(first), end: ymd(last) };
  }, [params.month]);

  const queryCategory = isAllSpending ? undefined : name;
  const txns = useTransactions({ start, end, category: queryCategory, collapse: false });
  const chartTxns = useTransactions({ start: chartWindow.start, end: chartWindow.end, category: queryCategory, collapse: false });

  const isUncat = name.toLowerCase() === 'uncategorized';
  const rows = useMemo(() => {
    const list = (txns.data ?? []).filter((t) => {
      if (isAllSpending) return t.amount < 0 && !/^reimbursement$/i.test(t.category || '');
      if (isIncome) return t.amount > 0;
      return isUncat ? !t.category : true;
    });
    return [...list].sort((a, b) => {
      if (sort === 'oldest') return a.date.localeCompare(b.date);
      if (sort === 'amount') return Math.abs(b.amount) - Math.abs(a.amount);
      return b.date.localeCompare(a.date);
    });
  }, [txns.data, name, isUncat, isAllSpending, isIncome, sort]);

  const total = useMemo(() => rows.reduce((s, t) => s + Math.abs(t.amount), 0), [rows]);
  const refunds = useMemo(() => rows.filter((t) => t.amount > 0).reduce((s, t) => s + t.amount, 0), [rows]);
  const chartMonths = useMemo(() => {
    const base = params.month ? (() => { const [y, m] = params.month!.split('-').map(Number); return new Date(y, m - 1, 1); })() : new Date();
    const months = Array.from({ length: 6 }, (_, i) => {
      const d = new Date(base.getFullYear(), base.getMonth() - 5 + i, 1);
      return ymd(d).slice(0, 7);
    });
    const totals = new Map(months.map((m) => [m, 0]));
    (chartTxns.data ?? []).forEach((t) => {
      const ok = isAllSpending ? t.amount < 0 && !/^reimbursement$/i.test(t.category || '') : isIncome ? t.amount > 0 : isUncat ? !t.category : true;
      if (!ok) return;
      const key = t.date.slice(0, 7);
      if (totals.has(key)) totals.set(key, (totals.get(key) || 0) + Math.abs(t.amount));
    });
    return months.map((m) => ({ month: m, total: totals.get(m) || 0 }));
  }, [chartTxns.data, params.month, isAllSpending, isIncome, isUncat, name]);
  const displayName = isAllSpending ? 'Spending' : isIncome ? 'Earnings' : name;
  const icon = categoryIcon(displayName);
  const loading = txns.isLoading && !txns.data;
  const refreshing = txns.isFetching || chartTxns.isFetching;
  const refresh = () => { haptics.light(); txns.refetch(); chartTxns.refetch(); };

  return (
    <View style={styles.root} testID="category-detail-screen">
      <Stack.Screen options={{ headerShown: false }} />
      <View style={[styles.header, { paddingTop: insets.top + 12 }]}>
        <Pressable onPress={() => router.back()} hitSlop={12} style={styles.headerBtn}>
          <SymbolView name="chevron.left" tintColor={colors.text} size={19} resizeMode="scaleAspectFit" />
        </Pressable>
        <View style={styles.headerTitle}>
          <SymbolView name={icon.symbol} tintColor={colors.text} size={21} resizeMode="scaleAspectFit" />
          <Text style={styles.title}>{displayName || 'Category'}</Text>
        </View>
        <View style={styles.headerActions}>
          <SymbolView name="doc.text" tintColor={colors.text} size={20} resizeMode="scaleAspectFit" />
          <Pressable
            testID="category-header-sort-control"
            onPress={() => {
              const next: SortKey = sort === 'newest' ? 'oldest' : sort === 'oldest' ? 'amount' : 'newest';
              setSort(next);
              haptics.tap();
            }}
            hitSlop={10}
          >
            <SymbolView name="line.3.horizontal.decrease.circle" tintColor={colors.text} size={24} resizeMode="scaleAspectFit" />
          </Pressable>
        </View>
      </View>
      <DemoRibbon />
      <ScrollView
        style={styles.scroll}
        contentContainerStyle={{ paddingBottom: insets.bottom + 96 }}
        refreshControl={<RefreshControl tintColor={colors.accent} refreshing={refreshing} onRefresh={refresh} />}
      >
        {loading ? (
          <View style={{ padding: 18 }}><SkeletonList hero rows={7} /></View>
        ) : txns.isError && !txns.data ? (
          <View style={{ padding: 18 }}><ErrorState error={txns.error?.error} onRetry={refresh} /></View>
        ) : (
          <>
            <View style={styles.chartPanel}>
              <Text style={styles.chartTitle}>{label === 'This month' ? 'This Month' : label}</Text>
              <MiniCategoryBars months={chartMonths} selected={params.month ?? ymd(new Date()).slice(0, 7)} />
            </View>

            <View style={styles.transactionHeader}>
              <Text style={styles.sectionLabel}>Transactions</Text>
              <Pressable
                testID="category-sort-control"
                onPress={() => {
                  const next: SortKey = sort === 'newest' ? 'oldest' : sort === 'oldest' ? 'amount' : 'newest';
                  setSort(next);
                  haptics.tap();
                }}
                style={({ pressed }) => [styles.sortPill, pressed && { opacity: 0.7 }]}
              >
                <Text style={styles.sortText}>{sort === 'newest' ? 'Newest' : sort === 'oldest' ? 'Oldest' : 'Amount'}</Text>
                <SymbolView name="chevron.down" tintColor={colors.text} size={10} resizeMode="scaleAspectFit" />
              </Pressable>
            </View>

            {isAllSpending && refunds > 0 ? (
              <View style={styles.infoCard}>
                <SymbolView name="banknote" tintColor="#111" size={22} resizeMode="scaleAspectFit" />
                <Text style={styles.infoText}>Your spending includes refunds for {fmtPos(refunds)}. Refunds may impact your spending totals and percentages.</Text>
                <SymbolView name="xmark" tintColor="#111" size={18} resizeMode="scaleAspectFit" />
              </View>
            ) : null}

            {rows.length === 0 ? (
              <View style={{ padding: 18 }}>
                <EmptyState icon="tray">No transactions in {displayName} for {label}</EmptyState>
              </View>
            ) : (
              <View style={styles.list}>
                {rows.map((t, i) => (
                  <Animated.View key={t.id} entering={FadeInDown.duration(180).delay(Math.min(i * 14, 160))}>
                    <Pressable
                      testID={`category-transaction-row-${i}`}
                      style={({ pressed }) => [styles.row, pressed && { opacity: 0.6 }]}
                      onPress={() =>
                        router.push({
                          pathname: '/transaction/[id]',
                          params: {
                            id: t.id,
                            payee: t.payee || '',
                            amount: String(t.amount),
                            date: t.date,
                            account: t.account,
                            accountId: t.accountId,
                            category: t.category || '',
                            categoryId: t.categoryId || '',
                            notes: t.notes || '',
                            isLeg: t.isLeg ? '1' : '',
                            parentId: t.parentId || '',
                            cleared: t.cleared === false ? '0' : '1',
                            isSplit: t.isSplit ? '1' : '',
                            splitCount: t.splitCount ? String(t.splitCount) : '',
                            imported: t.imported ? '1' : '',
                          },
                        })
                      }
                    >
                      <Avatar label={t.payee} category={t.category ?? displayName} size={42} />
                      <View style={styles.mid}>
                        <View style={styles.payeeLine}>
                          <Text style={[styles.payee, { flexShrink: 1 }]} numberOfLines={1}>{t.payee || '(no payee)'}</Text>
                          {t.cleared === false ? <PendingPill /> : null}
                        </View>
                        <Text style={styles.sub} numberOfLines={1}>{fmtDate(t.date)}{t.cleared === false ? ' | Pending' : ''}</Text>
                      </View>
                      <Text style={[styles.amt, { color: t.amount < 0 ? colors.text : colors.green }]}>
                        {t.amount < 0 ? fmtPos(Math.abs(t.amount)) : `+${fmtPos(t.amount)}`}
                      </Text>
                    </Pressable>
                  </Animated.View>
                ))}
              </View>
            )}
          </>
        )}
      </ScrollView>
      <View testID="category-total-footer" style={[styles.footer, { paddingBottom: insets.bottom + 12 }]}>
        <Text style={styles.footerLabel}>Total of Transactions</Text>
        <Text style={styles.footerValue}>{fmtPos(total)}</Text>
      </View>
    </View>
  );
}

function MiniCategoryBars({ months, selected }: { months: { month: string; total: number }[]; selected: string }) {
  const max = Math.max(1, ...months.map((m) => m.total));
  return (
    <View style={styles.barChart}>
      {months.map((m) => {
        const on = m.month === selected;
        const h = Math.max(2, (m.total / max) * 86);
        return (
          <View key={m.month} style={styles.barCol}>
            <Text style={styles.barValue}>{m.total > 0 ? fmtPos(m.total).replace('.00', '') : ''}</Text>
            <View style={[styles.bar, { height: h }, on && styles.barOn]} />
            <Text style={[styles.barLabel, on && styles.barLabelOn]}>{monthLabel(m.month).split(' ')[0]}</Text>
          </View>
        );
      })}
    </View>
  );
}

const styles = StyleSheet.create({
  root: { flex: 1, backgroundColor: colors.bg },
  header: { minHeight: 82, flexDirection: 'row', alignItems: 'center', justifyContent: 'space-between', paddingHorizontal: 22, borderBottomWidth: StyleSheet.hairlineWidth, borderBottomColor: 'rgba(255,255,255,0.08)' },
  headerBtn: { width: 34, height: 34, alignItems: 'flex-start', justifyContent: 'center' },
  headerTitle: { flexDirection: 'row', alignItems: 'center', gap: 10 },
  title: { color: colors.text, fontSize: 19, fontWeight: '900', letterSpacing: -0.3 },
  headerActions: { width: 72, flexDirection: 'row', justifyContent: 'flex-end', gap: 16 },
  scroll: { flex: 1 },
  chartPanel: { backgroundColor: '#242426', paddingHorizontal: 24, paddingTop: 18, paddingBottom: 18 },
  chartTitle: { color: colors.text, fontSize: 21, fontWeight: '900', marginBottom: 12 },
  barChart: { height: 150, flexDirection: 'row', alignItems: 'flex-end', justifyContent: 'space-between' },
  barCol: { flex: 1, alignItems: 'center', justifyContent: 'flex-end', minWidth: 48 },
  barValue: { color: colors.text, fontSize: 12, fontWeight: '700', marginBottom: 4 },
  bar: { width: 42, borderRadius: 9, backgroundColor: '#6f8df7' },
  barOn: { backgroundColor: '#7f99ff' },
  barLabel: { color: colors.muted, fontSize: 12, marginTop: 8 },
  barLabelOn: { color: '#111', backgroundColor: '#fff', borderRadius: 999, overflow: 'hidden', paddingHorizontal: 10, paddingVertical: 4, fontWeight: '800' },
  transactionHeader: { minHeight: 72, paddingHorizontal: 23, flexDirection: 'row', alignItems: 'center', justifyContent: 'space-between', backgroundColor: colors.bg, borderTopWidth: StyleSheet.hairlineWidth, borderBottomWidth: StyleSheet.hairlineWidth, borderColor: 'rgba(255,255,255,0.12)' },
  sectionLabel: { color: colors.text, textTransform: 'uppercase', letterSpacing: 1.1, fontSize: 13, fontWeight: '900' },
  sortPill: { flexDirection: 'row', alignItems: 'center', gap: 8, backgroundColor: '#4a4a4d', borderRadius: 22, paddingHorizontal: 15, paddingVertical: 10 },
  sortText: { color: colors.text, fontSize: 16, fontWeight: '800' },
  infoCard: { margin: 23, marginBottom: 8, backgroundColor: '#b6cbff', borderRadius: 16, flexDirection: 'row', alignItems: 'center', gap: 14, padding: 18 },
  infoText: { color: '#111', fontSize: 14, lineHeight: 19, flex: 1 },
  list: { backgroundColor: '#242426' },
  row: { minHeight: 86, flexDirection: 'row', alignItems: 'center', gap: 16, paddingHorizontal: 18, borderBottomWidth: StyleSheet.hairlineWidth, borderBottomColor: 'rgba(255,255,255,0.14)' },
  mid: { flex: 1, minWidth: 0 },
  payeeLine: { flexDirection: 'row', alignItems: 'center', gap: 6 },
  payee: { color: colors.text, fontSize: 18, fontWeight: '700' },
  sub: { color: colors.text, opacity: 0.62, fontSize: 15, marginTop: 5 },
  amt: { fontSize: 18, fontWeight: '800' },
  footer: { position: 'absolute', left: 0, right: 0, bottom: 0, minHeight: 64, paddingHorizontal: 28, paddingTop: 14, flexDirection: 'row', alignItems: 'flex-start', justifyContent: 'space-between', backgroundColor: '#242426', borderTopWidth: StyleSheet.hairlineWidth, borderTopColor: 'rgba(255,255,255,0.16)' },
  footerLabel: { color: colors.text, opacity: 0.6, fontSize: 15, fontWeight: '700' },
  footerValue: { color: colors.text, fontSize: 18, fontWeight: '900' },
});
