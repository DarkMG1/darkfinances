import React, { useMemo, useState } from 'react';
import { Pressable, RefreshControl, ScrollView, StyleSheet, Text, View } from 'react-native';
import { SymbolView, SymbolViewProps } from 'expo-symbols';
import { useRouter } from 'expo-router';
import { useSafeAreaInsets } from 'react-native-safe-area-context';
import { useBudgets, useInsights, useSpending, useTrends } from '@/api/hooks/finance.hooks';
import { DemoRibbon } from '@/components/screen';
import { Avatar, Card, CardTitle, EmptyState, ErrorState, PendingPill } from '@/components/ui';
import { SkeletonList } from '@/components/skeleton';
import { haptics } from '@/lib/haptics';
import { currentMonthKey, useSelectedMonth } from '@/lib/selectedMonth';
import { categoryColors, colors, fmtDate, fmtPos, monthLabel } from '@/theme/colors';

type Period = 'week' | 'month' | 'quarter' | 'year';
const PERIODS: { key: Period; label: string }[] = [
  { key: 'week', label: 'Week' },
  { key: 'month', label: 'Month' },
  { key: 'quarter', label: 'Quarter' },
  { key: 'year', label: 'Year' },
];

export default function Spending() {
  const router = useRouter();
  const insets = useSafeAreaInsets();
  const curKey = useMemo(() => currentMonthKey(), []);
  const [month, setMonth] = useSelectedMonth();
  const [period, setPeriod] = useState<Period>('month');
  // Current month keeps hitting the warmed `spending-current` cache (month=undefined).
  const apiMonth = month === curKey ? undefined : month;
  const trends = useTrends(60);
  const spending = useSpending(apiMonth);
  const budgets = useBudgets(apiMonth);
  const insights = useInsights(apiMonth);
  const cur = spending.data?.current;

  // Bars/navigation span exactly as far back as there's data: trim leading
  // buckets with no spend and no income from the (ascending) trends series.
  const availMonths = useMemo(() => {
    const ms = trends.data?.months ?? [];
    let i = 0;
    while (i < ms.length && ms[i].spend === 0 && ms[i].income === 0) i++;
    const trimmed = ms.slice(i);
    return trimmed.length ? trimmed : [{ month: curKey, spend: cur?.totalSpend ?? 0, income: cur?.totalIncome ?? 0, net: 0, netWorth: 0 }];
  }, [trends.data, curKey, cur]);
  const chartMonths = useMemo(() => availMonths.slice(-6), [availMonths]);

  const entries = useMemo(
    () => (cur ? Object.entries(cur.spending).sort((a, b) => b[1] - a[1]) : []),
    [cur]
  );
  // A category that nets negative is a pure credit/refund (e.g. Amazon returns
  // with no offsetting purchases that month) — surface it separately instead of
  // rendering it as if it were positive spend.
  const spendEntries = useMemo(() => entries.filter(([, v]) => v > 0.005), [entries]);
  const refundEntries = useMemo(() => entries.filter(([, v]) => v < -0.005).sort((a, b) => a[1] - b[1]), [entries]);
  const topCategories = spendEntries.slice(0, 5);
  const hiddenCategories = Math.max(0, spendEntries.length - topCategories.length);
  const breakdownCategories = spendEntries.filter(([cat]) => !/^reimbursement$/i.test(cat));
  const totalSpend = cur?.totalSpend ?? 0;
  const totalIncome = cur?.totalIncome ?? 0;
  const netIncome = totalIncome - totalSpend;
  const reimbursementTotal = Math.abs(entries.find(([cat]) => /^reimbursement$/i.test(cat))?.[1] ?? 0);
  const refundTotal = refundEntries.reduce((sum, [, amt]) => sum + Math.abs(amt), 0);
  const budgetLeft = budgets.data?.totalRemaining ?? 0;
  const budgetTarget = budgets.data?.totalTarget || budgets.data?.totalBudgeted || 0;
  const budgetSpent = budgets.data?.totalSpent ?? totalSpend;
  const budgetPct = budgetTarget > 0 ? Math.min(100, Math.max(0, (budgetSpent / budgetTarget) * 100)) : 0;

  // Real-spend merchants come from the backend (excludes transfers/investments/
  // CC payments/reimbursement), so savings moves and brokerage buys never show up.
  const topMerchants = insights.data?.topMerchants ?? [];
  const refreshing = spending.isFetching || insights.isFetching || trends.isFetching || budgets.isFetching;
  const refresh = () => { haptics.light(); spending.refetch(); insights.refetch(); trends.refetch(); budgets.refetch(); };

  return (
    <View style={styles.root} testID="spending-screen">
      <View style={[styles.header, { paddingTop: insets.top + 8 }]}>
        <Pressable hitSlop={10} onPress={() => haptics.tap()}>
          <SymbolView name="gearshape" tintColor={colors.text} size={22} resizeMode="scaleAspectFit" />
        </Pressable>
        <Text style={styles.title}>Spending</Text>
        <View style={{ width: 22 }} />
      </View>
      <DemoRibbon />
      <ScrollView
        style={styles.scroll}
        contentContainerStyle={{ padding: 18, paddingBottom: insets.bottom + 72 }}
        refreshControl={<RefreshControl tintColor={colors.accent} refreshing={refreshing} onRefresh={refresh} />}
      >
        <PeriodChips value={period} onChange={setPeriod} />
        <DualMonthBars months={chartMonths} selected={month} onSelect={setMonth} />

        {spending.isLoading ? (
          <SkeletonList rows={8} />
        ) : spending.isError ? (
          <ErrorState error={spending.error?.error} onRetry={refresh} />
        ) : !spendEntries.length && !refundEntries.length ? (
          <EmptyState icon="creditcard">{month === curKey ? 'No spending this month' : `No spending in ${monthLabel(month)}`}</EmptyState>
        ) : (
          <>
            <SummaryCard>
              <SummaryRow testID="spending-income-row" icon="dollarsign.circle" label="Income" value={fmtPos(totalIncome)} onPress={() => router.push({ pathname: '/category/[name]', params: { name: 'Income', ...(apiMonth ? { month: apiMonth } : {}) } })} />
              <SummaryRow testID="spending-total-row" icon="banknote" label="Total Spend" value={fmtPos(totalSpend)} expanded onPress={() => router.push({ pathname: '/category/[name]', params: { name: 'Spending', ...(apiMonth ? { month: apiMonth } : {}) } })} />
              {topCategories.slice(0, 2).map(([cat, amt], i) => (
                <SummaryRow
                  key={cat}
                  icon={i === 0 ? 'receipt' : 'wallet.pass'}
                  label={cat}
                  value={fmtPos(amt)}
                  inset
                  onPress={() => router.push({ pathname: '/category/[name]', params: { name: cat, ...(apiMonth ? { month: apiMonth } : {}) } })}
                />
              ))}
              <SummaryRow icon="minus.circle" label="Net Income" value={`${netIncome < 0 ? '-' : ''}${fmtPos(Math.abs(netIncome))}`} muted info last />
            </SummaryCard>

            <SectionTitle>Your Budget</SectionTitle>
            <Card style={styles.budgetCard}>
              <Pressable style={({ pressed }) => [styles.budgetHead, pressed && { opacity: 0.65 }]} onPress={() => router.push('/budgets')}>
                <SymbolView name="rectangle.grid.2x2" tintColor={colors.text} size={22} resizeMode="scaleAspectFit" />
                <Text style={styles.budgetTitle}>{monthLabel(month)} Budget</Text>
                <Text style={styles.chevron}>›</Text>
              </Pressable>
              <View style={styles.budgetBody}>
                <View>
                  <Text style={styles.mutedLabel}>Left for spending</Text>
                  <Text style={styles.budgetValue}>{budgetLeft < 0 ? '-' : ''}{fmtPos(Math.abs(budgetLeft))}</Text>
                </View>
                <View style={styles.ringRow}>
                  <Ring label="$" pct={budgetPct} />
                  <Ring label="!" pct={Math.min(100, (refundTotal / Math.max(1, totalSpend)) * 100)} warn />
                  <Ring label="∞" pct={100 - budgetPct} />
                </View>
              </View>
              <View style={styles.progressTrack}>
                <View style={[styles.progressFill, { width: `${budgetPct}%` }]} />
              </View>
            </Card>

            <SectionTitle>Breakdown</SectionTitle>
            <Card style={styles.breakdownCard}>
              <View style={styles.segmented}>
                <Text style={[styles.segmentText, styles.segmentOn]}>Categories</Text>
                <Text style={styles.segmentText}>Tags</Text>
              </View>
              {topCategories.map(([cat, amt], i) => (
                <CategoryRow
                  key={cat}
                  category={cat}
                  amount={amt}
                  pct={totalSpend > 0 ? amt / totalSpend : 0}
                  color={categoryColors[i % categoryColors.length]}
                  onPress={() => router.push({ pathname: '/category/[name]', params: { name: cat, ...(apiMonth ? { month: apiMonth } : {}) } })}
                />
              ))}
              {hiddenCategories ? <OutlineButton label="See More" onPress={() => haptics.tap()} /> : null}
            </Card>

            {topMerchants.length ? (
              <>
                <SectionTitle>Frequent Spend</SectionTitle>
                <Card style={styles.groupCard}>
                  {topMerchants.slice(0, 3).map((m, i) => (
                    <MerchantRow
                      key={m.payee}
                      merchant={m.payee}
                      category={m.category ?? undefined}
                      count={m.count}
                      total={m.total}
                      last={i === Math.min(topMerchants.length, 3) - 1}
                      onPress={() => { haptics.tap(); router.push({ pathname: '/merchant/[name]', params: { name: m.payee } }); }}
                    />
                  ))}
                </Card>
              </>
            ) : null}

            {insights.data?.largestCharges.length ? (
              <>
                <SectionTitle>Largest Purchases</SectionTitle>
                <Card style={styles.groupCard}>
                  <Text style={styles.cardCopy}>You can tap on a transaction to open it and adjust details.</Text>
                  {insights.data.largestCharges.slice(0, 3).map((c, i) => (
                    <PurchaseRow
                      key={c.id ?? i}
                      payee={c.payee}
                      category={c.category}
                      date={c.date}
                      pending={c.cleared === false}
                      amount={Math.abs(c.amount)}
                      last={i === Math.min(insights.data!.largestCharges.length, 3) - 1}
                      onPress={() => {
                        haptics.tap();
                        if (c.id) {
                          router.push({
                            pathname: '/transaction/[id]',
                            params: {
                              id: c.id,
                              payee: c.payee || '',
                              amount: String(c.amount),
                              date: c.date,
                              account: c.account || '',
                              accountId: c.accountId || '',
                              category: c.category || '',
                              categoryId: c.categoryId || '',
                              notes: c.notes || '',
                              isLeg: c.isLeg ? '1' : '',
                              parentId: c.parentId || '',
                              cleared: c.cleared === false ? '0' : '1',
                            },
                          });
                        } else {
                          router.push({ pathname: '/category/[name]', params: { name: c.category, ...(apiMonth ? { month: apiMonth } : {}) } });
                        }
                      }}
                    />
                  ))}
                  <OutlineButton label="See more" onPress={() => haptics.tap()} />
                </Card>
              </>
            ) : null}

            <SectionTitle>Non-Spending</SectionTitle>
            <Card style={styles.groupCard}>
              <PlainRow icon="cross.case" label="Tax Deductible" value="$0" />
              <PlainRow icon="arrow.uturn.backward.circle" label="Reimbursements" value={fmtPos(reimbursementTotal)} onPress={() => router.push({ pathname: '/category/[name]', params: { name: 'Reimbursement' } })} />
              <PlainRow icon="minus.circle" label="Refunds & Credits" value={refundTotal ? `-${fmtPos(refundTotal)}` : '$0'} />
              <PlainRow icon="arrow.left.arrow.right.circle" label="Transfers" value="0" last />
            </Card>

            <View style={styles.problemCard}>
              <Text style={styles.problemTitle}>Data not looking right?</Text>
              <Text style={styles.problemText}>Make adjustments when transactions are missing categories, marked pending, or counted in the wrong bucket.</Text>
              <OutlineButton label="Review spending data" onPress={() => router.push('/review')} />
            </View>
          </>
        )}
      </ScrollView>
    </View>
  );
}

function PeriodChips({ value, onChange }: { value: Period; onChange: (p: Period) => void }) {
  return (
    <View style={styles.periodRow}>
      {PERIODS.map((p) => {
        const on = p.key === value;
        return (
          <Pressable key={p.key} onPress={() => { haptics.tap(); onChange(p.key); }} style={({ pressed }) => [styles.periodChip, on && styles.periodChipOn, pressed && { opacity: 0.7 }]}>
            <Text style={[styles.periodText, on && styles.periodTextOn]}>{p.label}</Text>
          </Pressable>
        );
      })}
    </View>
  );
}

function DualMonthBars({ months, selected, onSelect }: { months: { month: string; spend: number; income: number }[]; selected: string; onSelect: (m: string) => void }) {
  const max = Math.max(1, ...months.map((m) => Math.max(m.spend, m.income)));
  return (
    <View style={styles.monthWrap}>
      <View style={styles.monthBars}>
        {months.map((m) => {
          const on = m.month === selected;
          return (
            <Pressable key={m.month} onPress={() => { haptics.tap(); onSelect(m.month); }} style={[styles.monthCell, on && styles.monthCellOn]}>
              <View style={styles.barStage}>
                <View style={[styles.incomeBar, { height: Math.max(2, (m.income / max) * 72) }]} />
                <View style={[styles.spendBar, { height: Math.max(2, (m.spend / max) * 72) }]} />
              </View>
              <Text style={[styles.monthText, on && styles.monthTextOn]}>{monthLabel(m.month).split(' ')[0]}</Text>
            </Pressable>
          );
        })}
      </View>
      <View style={styles.legendRow}>
        <View style={styles.legendDot} />
        <Text style={styles.legendText}>Income</Text>
        <View style={[styles.legendDot, styles.spendDot]} />
        <Text style={styles.legendText}>Total Spend</Text>
      </View>
    </View>
  );
}

function SummaryCard({ children }: { children: React.ReactNode }) {
  return <Card style={styles.summaryCard}>{children}</Card>;
}

function SummaryRow({ icon, label, value, onPress, expanded, inset, muted, info, last, testID }: {
  icon: SymbolViewProps['name']; label: string; value: string; onPress?: () => void; expanded?: boolean; inset?: boolean; muted?: boolean; info?: boolean; last?: boolean; testID?: string;
}) {
  const body = (
    <>
      <SymbolView name={icon} tintColor={muted ? colors.muted : colors.text} size={20} resizeMode="scaleAspectFit" />
      <Text style={[styles.summaryLabel, inset && styles.summaryInset, muted && { color: colors.muted }]}>{label}</Text>
      <Text style={[styles.summaryValue, muted && { color: colors.muted }]}>{value}</Text>
      {info ? <SymbolView name="info.circle" tintColor={colors.muted} size={16} resizeMode="scaleAspectFit" /> : <Text style={styles.chevron}>{expanded ? '⌃' : '›'}</Text>}
    </>
  );
  if (onPress) {
    return <Pressable testID={testID} onPress={onPress} style={({ pressed }) => [styles.summaryRow, last && styles.lastRow, pressed && { opacity: 0.65 }]}>{body}</Pressable>;
  }
  return <View testID={testID} style={[styles.summaryRow, last && styles.lastRow]}>{body}</View>;
}

function SectionTitle({ children }: { children: React.ReactNode }) {
  return <Text style={styles.section}>{children}</Text>;
}

function Ring({ label, pct, warn }: { label: string; pct: number; warn?: boolean }) {
  return (
    <View style={[styles.ring, { borderColor: warn ? colors.yellow : colors.accent }]}>
      <Text style={[styles.ringText, warn && { color: colors.yellow }]}>{label}</Text>
    </View>
  );
}

function CategoryRow({ category, amount, pct, color, onPress }: { category: string; amount: number; pct: number; color: string; onPress: () => void }) {
  return (
    <Pressable onPress={onPress} style={({ pressed }) => [styles.categoryRow, pressed && { opacity: 0.65 }]}>
      <Avatar category={category} size={42} />
      <View style={styles.rowMid}>
        <Text style={styles.rowTitle}>{category}</Text>
        <Text style={styles.rowSub}>{Math.round(pct * 100)}% of spend</Text>
      </View>
      <Text style={styles.rowValue}>{fmtPos(amount)}</Text>
      <View style={[styles.categoryColor, { backgroundColor: color }]} />
    </Pressable>
  );
}

function MerchantRow({ merchant, category, count, total, onPress, last }: { merchant: string; category?: string; count: number; total: number; onPress: () => void; last?: boolean }) {
  return (
    <Pressable onPress={onPress} style={({ pressed }) => [styles.listRow, last && styles.lastRow, pressed && { opacity: 0.65 }]}>
      <View style={styles.countBubble}><Text style={styles.countText}>{count}x</Text></View>
      <View style={styles.rowMid}>
        <Text style={styles.rowTitle} numberOfLines={1}>{merchant}</Text>
        <Text style={styles.rowSub}>{category || `Average ${fmtPos(total / Math.max(1, count))}`}</Text>
      </View>
      <Text style={styles.rowValue}>{fmtPos(total)}</Text>
    </Pressable>
  );
}

function PurchaseRow({ payee, category, date, pending, amount, onPress, last }: { payee: string; category: string; date: string; pending?: boolean; amount: number; onPress: () => void; last?: boolean }) {
  return (
    <Pressable onPress={onPress} style={({ pressed }) => [styles.listRow, last && styles.lastRow, pressed && { opacity: 0.65 }]}>
      <Avatar label={payee} category={category} size={42} />
      <View style={styles.rowMid}>
        <View style={styles.nameLine}>
          <Text style={styles.rowTitle} numberOfLines={1}>{payee || '(no payee)'}</Text>
          {pending ? <PendingPill /> : null}
        </View>
        <Text style={styles.rowSub}>{fmtDate(date)}{pending ? ' | Pending' : ''}</Text>
      </View>
      <Text style={styles.rowValue}>{fmtPos(amount)}</Text>
    </Pressable>
  );
}

function PlainRow({ icon, label, value, onPress, last }: { icon: SymbolViewProps['name']; label: string; value: string; onPress?: () => void; last?: boolean }) {
  const inner = (
    <>
      <SymbolView name={icon} tintColor={colors.text} size={20} resizeMode="scaleAspectFit" style={styles.plainIcon} />
      <Text style={[styles.rowTitle, { flex: 1 }]}>{label}</Text>
      <Text style={styles.rowValue}>{value}</Text>
    </>
  );
  if (onPress) return <Pressable onPress={onPress} style={({ pressed }) => [styles.listRow, last && styles.lastRow, pressed && { opacity: 0.65 }]}>{inner}</Pressable>;
  return <View style={[styles.listRow, last && styles.lastRow]}>{inner}</View>;
}

function OutlineButton({ label, onPress }: { label: string; onPress: () => void }) {
  return (
    <Pressable onPress={onPress} style={({ pressed }) => [styles.outlineBtn, pressed && { opacity: 0.65 }]}>
      <Text style={styles.outlineText}>{label}</Text>
    </Pressable>
  );
}

const styles = StyleSheet.create({
  root: { flex: 1, backgroundColor: colors.bg },
  header: { paddingHorizontal: 28, paddingBottom: 13, flexDirection: 'row', alignItems: 'center', justifyContent: 'space-between' },
  title: { color: colors.text, fontSize: 19, fontWeight: '700', letterSpacing: -0.3 },
  scroll: { flex: 1 },
  periodRow: { flexDirection: 'row', justifyContent: 'center', gap: 9, marginBottom: 17 },
  periodChip: { backgroundColor: '#3a3a3d', borderRadius: 18, paddingHorizontal: 16, paddingVertical: 8 },
  periodChipOn: { backgroundColor: '#fff' },
  periodText: { color: colors.text, fontSize: 14, fontWeight: '700' },
  periodTextOn: { color: '#19191d' },
  monthWrap: { marginHorizontal: -12, marginBottom: 18 },
  monthBars: { flexDirection: 'row', justifyContent: 'space-between', gap: 10 },
  monthCell: { flex: 1, minHeight: 102, borderWidth: 1, borderColor: 'rgba(255,255,255,0.22)', borderRadius: 6, alignItems: 'center', justifyContent: 'flex-end', paddingBottom: 8 },
  monthCellOn: { borderColor: '#fff', borderWidth: 2 },
  barStage: { height: 74, flexDirection: 'row', alignItems: 'flex-end', gap: 6 },
  incomeBar: { width: 9, borderRadius: 5, backgroundColor: '#6f8df7' },
  spendBar: { width: 9, borderRadius: 5, backgroundColor: 'rgba(255,255,255,0.55)' },
  monthText: { color: colors.muted, fontSize: 12, marginTop: 6 },
  monthTextOn: { color: colors.text, fontWeight: '800' },
  legendRow: { flexDirection: 'row', alignItems: 'center', justifyContent: 'center', gap: 7, marginTop: 10 },
  legendDot: { width: 9, height: 9, borderRadius: 5, backgroundColor: '#6f8df7' },
  spendDot: { backgroundColor: 'rgba(255,255,255,0.55)' },
  legendText: { color: colors.text, fontSize: 13, opacity: 0.82 },
  summaryCard: { paddingVertical: 0, overflow: 'hidden', marginBottom: 26 },
  summaryRow: { minHeight: 58, flexDirection: 'row', alignItems: 'center', gap: 14, borderBottomWidth: StyleSheet.hairlineWidth, borderBottomColor: 'rgba(255,255,255,0.12)', paddingHorizontal: 22 },
  summaryLabel: { color: colors.text, fontSize: 16, fontWeight: '600', flex: 1 },
  summaryInset: { fontSize: 15, color: colors.muted },
  summaryValue: { color: colors.text, fontSize: 16, fontWeight: '700' },
  section: { color: colors.text, textTransform: 'uppercase', letterSpacing: 1.1, fontSize: 12, fontWeight: '800', marginBottom: 10, marginLeft: 8 },
  budgetCard: { padding: 0, overflow: 'hidden', marginBottom: 26 },
  budgetHead: { flexDirection: 'row', alignItems: 'center', gap: 16, minHeight: 60, paddingHorizontal: 22, borderBottomWidth: StyleSheet.hairlineWidth, borderBottomColor: 'rgba(255,255,255,0.12)' },
  budgetTitle: { color: colors.text, fontSize: 17, fontWeight: '600', flex: 1 },
  budgetBody: { flexDirection: 'row', alignItems: 'center', justifyContent: 'space-between', paddingHorizontal: 22, paddingTop: 16 },
  mutedLabel: { color: colors.muted, fontSize: 12, fontWeight: '600' },
  budgetValue: { color: colors.text, fontSize: 26, fontWeight: '800', marginTop: 4 },
  ringRow: { flexDirection: 'row', gap: 9 },
  ring: { width: 44, height: 44, borderRadius: 22, borderWidth: 3, alignItems: 'center', justifyContent: 'center' },
  ringText: { color: colors.accentLight, fontSize: 15, fontWeight: '800' },
  progressTrack: { height: 6, borderRadius: 3, backgroundColor: 'rgba(255,255,255,0.17)', margin: 22, marginTop: 14, overflow: 'hidden' },
  progressFill: { height: 6, borderRadius: 3, backgroundColor: '#8aa0ff' },
  breakdownCard: { padding: 0, overflow: 'hidden', marginBottom: 26 },
  segmented: { flexDirection: 'row', borderBottomWidth: StyleSheet.hairlineWidth, borderBottomColor: 'rgba(255,255,255,0.12)' },
  segmentText: { flex: 1, textAlign: 'center', color: colors.muted, fontSize: 15, fontWeight: '700', paddingVertical: 15 },
  segmentOn: { color: colors.text },
  categoryRow: { minHeight: 74, flexDirection: 'row', alignItems: 'center', gap: 13, paddingHorizontal: 18, borderBottomWidth: StyleSheet.hairlineWidth, borderBottomColor: 'rgba(255,255,255,0.12)' },
  rowMid: { flex: 1, minWidth: 0 },
  rowTitle: { color: colors.text, fontSize: 16, fontWeight: '600' },
  rowSub: { color: colors.text, opacity: 0.56, fontSize: 14, marginTop: 4 },
  rowValue: { color: colors.text, fontSize: 16, fontWeight: '700' },
  categoryColor: { width: 4, height: 36, borderRadius: 2 },
  groupCard: { padding: 0, overflow: 'hidden', marginBottom: 26 },
  listRow: { minHeight: 76, flexDirection: 'row', alignItems: 'center', gap: 13, paddingHorizontal: 18, borderBottomWidth: StyleSheet.hairlineWidth, borderBottomColor: 'rgba(255,255,255,0.12)' },
  lastRow: { borderBottomWidth: 0 },
  countBubble: { width: 38, height: 38, borderRadius: 19, backgroundColor: 'rgba(255,255,255,0.08)', alignItems: 'center', justifyContent: 'center' },
  countText: { color: colors.text, fontSize: 15, fontWeight: '700', opacity: 0.72 },
  nameLine: { flexDirection: 'row', alignItems: 'center', gap: 6 },
  cardCopy: { color: colors.text, opacity: 0.68, fontSize: 14, lineHeight: 20, padding: 20, borderBottomWidth: StyleSheet.hairlineWidth, borderBottomColor: 'rgba(255,255,255,0.12)' },
  plainIcon: { width: 38 },
  outlineBtn: { borderWidth: 1.2, borderColor: colors.text, borderRadius: 999, alignItems: 'center', paddingVertical: 13, marginHorizontal: 22, marginVertical: 17 },
  outlineText: { color: colors.text, fontSize: 16, fontWeight: '700' },
  problemCard: { borderWidth: 1, borderColor: 'rgba(255,255,255,0.22)', borderRadius: 24, padding: 22, marginBottom: 26 },
  problemTitle: { color: colors.text, fontSize: 18, fontWeight: '800' },
  problemText: { color: colors.text, opacity: 0.68, fontSize: 15, lineHeight: 22, marginTop: 12, marginBottom: 10 },
  chevron: { color: colors.text, opacity: 0.82, fontSize: 18, fontWeight: '700' },
});
