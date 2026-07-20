import React, { useMemo, useState } from 'react';
import { Modal, Pressable, ScrollView, StyleSheet, Text, View } from 'react-native';
import Animated, { FadeInDown } from 'react-native-reanimated';
import { SymbolView } from 'expo-symbols';
import { Stack, useLocalSearchParams, useRouter } from 'expo-router';
import { useSafeAreaInsets } from 'react-native-safe-area-context';
import { useTransactions } from '@/api/hooks/finance.hooks';
import { DemoRibbon } from '@/components/screen';
import { GestureRefreshControl } from '@/components/gesture-refresh-control';
import { Avatar, EmptyState, ErrorState, PendingPill } from '@/components/ui';
import { QueryRefetchBanner } from '@/components/query-refetch-banner';
import { resolveQueryDisplay } from '@/components/query-display';
import { SkeletonList } from '@/components/skeleton';
import { haptics } from '@/lib/haptics';
import {
  calendarMonthWindow,
  categoryRangeWindow,
  monthsThrough,
  relativePeriodLabel,
  sixMonthChartWindow,
  type CategoryRangeKey,
  useFinanceToday,
} from '@/lib/date-only';
import { categoryIcon } from '@/theme/categoryIcons';
import { colors, fmtDate, fmtPos, monthLabel } from '@/theme/colors';

type SortKey = 'newest' | 'oldest' | 'amountHigh' | 'amountLow';
type BucketKey = 'spending' | 'bills' | 'subscriptions';
const RANGES: { key: CategoryRangeKey; label: string }[] = [
  { key: 'month', label: 'Month' },
  { key: '3m', label: '3M' },
  { key: 'year', label: 'Year' },
  { key: 'all', label: 'All' },
];
const SORTS: { key: SortKey; label: string }[] = [
  { key: 'newest', label: 'Date: Newest' },
  { key: 'oldest', label: 'Date: Oldest' },
  { key: 'amountHigh', label: 'Amount: Highest' },
  { key: 'amountLow', label: 'Amount: Lowest' },
];

function rangeWindow(
  key: CategoryRangeKey,
  anchor: string,
  month?: string,
  explicitStart?: string,
  explicitEnd?: string,
  explicitLabel?: string,
): { start: string; end: string; label: string } {
  if (explicitStart && explicitEnd) {
    return {
      start: explicitStart,
      end: explicitEnd,
      label: relativePeriodLabel(explicitStart, explicitEnd, explicitLabel, anchor),
    };
  }
  if (key === 'month' && month) {
    return calendarMonthWindow(month, anchor);
  }
  return categoryRangeWindow(key, anchor);
}

function compactMoney(n: number) {
  const abs = Math.abs(n);
  if (abs >= 1000) return `$${(abs / 1000).toFixed(abs >= 10000 ? 0 : 1)}k`;
  return fmtPos(abs).replace('.00', '');
}

export default function CategoryDetail() {
  const router = useRouter();
  const insets = useSafeAreaInsets();
  const financeToday = useFinanceToday();
  const params = useLocalSearchParams<{ name: string; month?: string; range?: string; start?: string; end?: string; label?: string; bucket?: BucketKey }>();
  const name = params.name ?? '';
  const isAllSpending = /^(spending|total spend)$/i.test(name);
  const isIncome = /^(income|earnings)$/i.test(name);
  const [range] = useState<CategoryRangeKey>(
    (RANGES.some((r) => r.key === params.range) ? (params.range as CategoryRangeKey) : 'month')
  );
  const [sort, setSort] = useState<SortKey>('newest');
  const [sortOpen, setSortOpen] = useState(false);
  const baseWindow = useMemo(
    () => rangeWindow(range, financeToday, params.month, params.start, params.end, params.label),
    [range, financeToday, params.month, params.start, params.end, params.label],
  );
  const windowKey = `${name}-${params.bucket || ''}-${baseWindow.start}-${baseWindow.end}`;
  const [monthOverride, setMonthOverride] = useState<{ key: string; month: string } | null>(null);
  const activeWindow = useMemo(() => {
    if (monthOverride?.key === windowKey) return calendarMonthWindow(monthOverride.month, financeToday);
    return baseWindow;
  }, [monthOverride, windowKey, baseWindow, financeToday]);
  const { start, end, label } = activeWindow;
  const chartAnchorMonth = params.month || baseWindow.end.slice(0, 7);
  const chartWindow = useMemo(() => sixMonthChartWindow(chartAnchorMonth), [chartAnchorMonth]);

  const selectedMonth = end.slice(0, 7);
  const queryCategory = params.bucket || isAllSpending ? undefined : name;
  const allTxns = useTransactions({ start: chartWindow.start, end: chartWindow.end, category: queryCategory, bucket: params.bucket, budgetOnly: isIncome, collapse: false });

  const isUncat = name.toLowerCase() === 'uncategorized';
  const rows = useMemo(() => {
    const list = (allTxns.data ?? []).filter((t) => {
      if (t.date < start || t.date > end) return false;
      if (isAllSpending) return t.amount < 0 && !/^reimbursement$/i.test(t.category || '');
      if (isIncome) return t.amount > 0;
      return isUncat ? !t.category : true;
    });
    return [...list].sort((a, b) => {
      if (sort === 'oldest') return a.date.localeCompare(b.date);
      if (sort === 'amountHigh') return Math.abs(b.amount) - Math.abs(a.amount);
      if (sort === 'amountLow') return Math.abs(a.amount) - Math.abs(b.amount);
      return b.date.localeCompare(a.date);
    });
  }, [allTxns.data, start, end, isUncat, isAllSpending, isIncome, sort]);

  const total = useMemo(() => rows.reduce((s, t) => {
    if (isIncome) return s + Math.max(0, t.amount);
    return s + (t.amount < 0 ? Math.abs(t.amount) : -Math.abs(t.amount));
  }, 0), [rows, isIncome]);
  const refunds = useMemo(() => rows.filter((t) => t.amount > 0).reduce((s, t) => s + t.amount, 0), [rows]);
  const chartMonths = useMemo(() => {
    const months = monthsThrough(chartAnchorMonth, 6);
    const totals = new Map(months.map((m) => [m, 0]));
    (allTxns.data ?? []).forEach((t) => {
      const ok = isAllSpending ? t.amount < 0 && !/^reimbursement$/i.test(t.category || '') : isIncome ? t.amount > 0 : isUncat ? !t.category : true;
      if (!ok) return;
      const key = t.date.slice(0, 7);
      if (totals.has(key)) totals.set(key, (totals.get(key) || 0) + (isIncome ? Math.max(0, t.amount) : t.amount < 0 ? Math.abs(t.amount) : -Math.abs(t.amount)));
    });
    return months.map((m) => ({ month: m, total: totals.get(m) || 0 }));
  }, [allTxns.data, chartAnchorMonth, isAllSpending, isIncome, isUncat]);
  const displayName = isAllSpending ? 'Spending' : isIncome ? 'Earnings' : name;
  const icon = categoryIcon(displayName);
  const txDisplay = resolveQueryDisplay(allTxns);
  const refresh = () => allTxns.refetch();

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
              setSortOpen(true);
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
        contentContainerStyle={{ paddingBottom: insets.bottom + 86 }}
        refreshControl={<GestureRefreshControl onRefresh={refresh} />}
      >
        {txDisplay.initialLoad ? (
          <View style={{ padding: 18 }}><SkeletonList hero rows={7} /></View>
        ) : txDisplay.fatalError ? (
          <View style={{ padding: 18 }}><ErrorState error={txDisplay.errorMessage} onRetry={refresh} /></View>
        ) : (
          <>
            {txDisplay.refetchError ? (
              <View style={{ paddingHorizontal: 18, paddingTop: 12 }}>
                <QueryRefetchBanner onRetry={refresh} testID="category-refetch-banner" />
              </View>
            ) : null}
            <View style={styles.chartPanel}>
              <Text style={styles.chartTitle}>{label}</Text>
              <MiniCategoryBars
                months={chartMonths}
                selected={selectedMonth}
                onSelect={(month) => {
                  haptics.tap();
                  setMonthOverride({ key: windowKey, month });
                }}
              />
            </View>

            <View style={styles.transactionHeader}>
              <Text style={styles.sectionLabel}>Transactions</Text>
              <Pressable
                testID="category-sort-control"
                onPress={() => {
                  setSortOpen(true);
                  haptics.tap();
                }}
                style={({ pressed }) => [styles.sortPill, pressed && { opacity: 0.7 }]}
              >
                <Text testID="category-sort-control-label" style={styles.sortText}>{SORTS.find((s) => s.key === sort)?.label ?? 'Date: Newest'}</Text>
                <SymbolView name="chevron.down" tintColor={colors.text} size={10} resizeMode="scaleAspectFit" />
              </Pressable>
            </View>

            {isAllSpending && refunds > 0 ? (
              <View style={styles.infoCard}>
                <SymbolView name="banknote" tintColor={colors.accentLight} size={22} resizeMode="scaleAspectFit" />
                <Text style={styles.infoText}>Your spending includes refunds for {fmtPos(refunds)}. Refunds may impact your spending totals and percentages.</Text>
                <SymbolView name="xmark" tintColor={colors.muted} size={18} resizeMode="scaleAspectFit" />
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
      <SortSheet
        visible={sortOpen}
        value={sort}
        onClose={() => setSortOpen(false)}
        onSelect={(next) => {
          setSort(next);
          setSortOpen(false);
          haptics.tap();
        }}
      />
      <View testID="category-total-footer" style={[styles.footer, { bottom: insets.bottom + 10 }]}>
        <Text style={styles.footerLabel}>Total of Transactions</Text>
        <Text style={styles.footerValue}>{total < 0 ? '-' : ''}{fmtPos(Math.abs(total))}</Text>
      </View>
    </View>
  );
}

function MiniCategoryBars({ months, selected, onSelect }: { months: { month: string; total: number }[]; selected: string; onSelect: (month: string) => void }) {
  const max = Math.max(1, ...months.map((m) => m.total));
  return (
    <View style={styles.barChart}>
      {months.map((m) => {
        const on = m.month === selected;
        const h = Math.max(2, (m.total / max) * 86);
        return (
          <Pressable
            key={m.month}
            testID={on ? `category-month-bar-${m.month}-selected` : `category-month-bar-${m.month}`}
            onPress={() => onSelect(m.month)}
            style={({ pressed }) => [styles.barCol, pressed && { opacity: 0.65 }]}
          >
            <Text style={styles.barValue}>{m.total > 0 ? compactMoney(m.total) : ''}</Text>
            <View style={[styles.bar, { height: h }, on && styles.barOn]} />
            <Text style={[styles.barLabel, on && styles.barLabelOn]}>{monthLabel(m.month).split(' ')[0]}</Text>
          </Pressable>
        );
      })}
    </View>
  );
}

function SortSheet({ visible, value, onSelect, onClose }: { visible: boolean; value: SortKey; onSelect: (key: SortKey) => void; onClose: () => void }) {
  return (
    <Modal visible={visible} transparent animationType="fade" onRequestClose={onClose}>
      <Pressable testID="category-sort-sheet-backdrop" style={styles.sheetBackdrop} onPress={onClose}>
        <Pressable testID="category-sort-sheet" style={styles.sheetCard} onPress={() => undefined}>
          <View style={styles.sheetHandle} />
          <Text style={styles.sheetTitle}>Sort transactions</Text>
          {SORTS.map((option) => {
            const selected = option.key === value;
            return (
              <Pressable
                key={option.key}
                testID={`category-sort-option-${option.key}`}
                accessibilityLabel={option.label}
                onPress={() => onSelect(option.key)}
                style={({ pressed }) => [styles.sheetOption, pressed && { opacity: 0.7 }]}
              >
                <Text style={[styles.sheetOptionText, selected && styles.sheetOptionTextOn]}>{option.label}</Text>
                {selected ? <SymbolView name="checkmark.circle.fill" tintColor={colors.accentLight} size={19} resizeMode="scaleAspectFit" /> : null}
              </Pressable>
            );
          })}
        </Pressable>
      </Pressable>
    </Modal>
  );
}

const styles = StyleSheet.create({
  root: { flex: 1, backgroundColor: colors.bg },
  header: { minHeight: 82, flexDirection: 'row', alignItems: 'center', justifyContent: 'space-between', paddingHorizontal: 20, borderBottomWidth: StyleSheet.hairlineWidth, borderBottomColor: colors.border },
  headerBtn: { width: 34, height: 34, alignItems: 'flex-start', justifyContent: 'center' },
  headerTitle: { flexDirection: 'row', alignItems: 'center', gap: 10 },
  title: { color: colors.text, fontSize: 19, fontWeight: '900', letterSpacing: -0.3 },
  headerActions: { width: 72, flexDirection: 'row', justifyContent: 'flex-end', gap: 16 },
  scroll: { flex: 1 },
  chartPanel: { backgroundColor: colors.surface, borderColor: colors.border, borderWidth: 1, borderRadius: 16, margin: 16, paddingHorizontal: 16, paddingTop: 16, paddingBottom: 14 },
  chartTitle: { color: colors.text, fontSize: 20, fontWeight: '800', marginBottom: 12, letterSpacing: -0.3 },
  barChart: { height: 132, flexDirection: 'row', alignItems: 'flex-end', justifyContent: 'space-between' },
  barCol: { flex: 1, alignItems: 'center', justifyContent: 'flex-end', minWidth: 48 },
  barValue: { color: colors.muted, fontSize: 11, fontWeight: '700', marginBottom: 5 },
  bar: { width: 34, borderRadius: 9, backgroundColor: 'rgba(124,110,247,0.35)' },
  barOn: { backgroundColor: colors.accentLight },
  barLabel: { color: colors.muted, fontSize: 12, marginTop: 8 },
  barLabelOn: { color: colors.accentLight, backgroundColor: 'rgba(124,110,247,0.16)', borderColor: 'rgba(168,152,255,0.35)', borderWidth: 1, borderRadius: 999, overflow: 'hidden', paddingHorizontal: 10, paddingVertical: 4, fontWeight: '800' },
  transactionHeader: { minHeight: 58, marginHorizontal: 16, marginBottom: 8, paddingHorizontal: 2, flexDirection: 'row', alignItems: 'center', justifyContent: 'space-between' },
  sectionLabel: { color: colors.text, textTransform: 'uppercase', letterSpacing: 1.1, fontSize: 12, fontWeight: '900' },
  sortPill: { flexDirection: 'row', alignItems: 'center', gap: 8, backgroundColor: colors.surface2, borderColor: colors.border, borderWidth: 1, borderRadius: 14, paddingHorizontal: 12, paddingVertical: 8 },
  sortText: { color: colors.text, fontSize: 13, fontWeight: '700' },
  infoCard: { margin: 16, marginTop: 0, backgroundColor: 'rgba(124,110,247,0.14)', borderColor: 'rgba(168,152,255,0.28)', borderWidth: 1, borderRadius: 14, flexDirection: 'row', alignItems: 'center', gap: 12, padding: 14 },
  infoText: { color: colors.text, fontSize: 13, lineHeight: 18, flex: 1 },
  list: { backgroundColor: colors.surface, borderColor: colors.border, borderWidth: 1, borderRadius: 16, marginHorizontal: 16, overflow: 'hidden' },
  row: { minHeight: 62, flexDirection: 'row', alignItems: 'center', gap: 12, paddingHorizontal: 14, paddingVertical: 10, borderBottomWidth: StyleSheet.hairlineWidth, borderBottomColor: colors.border },
  mid: { flex: 1, minWidth: 0 },
  payeeLine: { flexDirection: 'row', alignItems: 'center', gap: 6 },
  payee: { color: colors.text, fontSize: 15, fontWeight: '700' },
  sub: { color: colors.muted, fontSize: 12, marginTop: 3 },
  amt: { fontSize: 15, fontWeight: '800' },
  footer: { position: 'absolute', left: 14, right: 14, minHeight: 50, paddingHorizontal: 16, paddingVertical: 12, flexDirection: 'row', alignItems: 'center', justifyContent: 'space-between', backgroundColor: colors.surface, borderWidth: 1, borderColor: colors.border, borderRadius: 16 },
  footerLabel: { color: colors.muted, fontSize: 13, fontWeight: '700' },
  footerValue: { color: colors.text, fontSize: 17, fontWeight: '900' },
  sheetBackdrop: { flex: 1, justifyContent: 'flex-end', backgroundColor: 'rgba(0,0,0,0.48)' },
  sheetCard: { backgroundColor: colors.surface, borderTopLeftRadius: 22, borderTopRightRadius: 22, borderColor: colors.border, borderWidth: 1, paddingHorizontal: 18, paddingTop: 10, paddingBottom: 28 },
  sheetHandle: { alignSelf: 'center', width: 42, height: 4, borderRadius: 2, backgroundColor: colors.border, marginBottom: 16 },
  sheetTitle: { color: colors.text, fontSize: 18, fontWeight: '800', marginBottom: 10 },
  sheetOption: { minHeight: 52, flexDirection: 'row', alignItems: 'center', justifyContent: 'space-between', borderBottomWidth: StyleSheet.hairlineWidth, borderBottomColor: colors.border },
  sheetOptionText: { color: colors.text, fontSize: 15, fontWeight: '600' },
  sheetOptionTextOn: { color: colors.accentLight, fontWeight: '800' },
});
