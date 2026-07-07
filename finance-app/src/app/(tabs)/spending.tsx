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

const pad = (n: number) => String(n).padStart(2, '0');
const ymd = (d: Date) => `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}`;
const monthEnd = (month: string) => {
  const [year, m] = month.split('-').map(Number);
  return new Date(year, m, 0);
};

function periodWindow(period: Period, month: string, currentMonth: string) {
  const now = new Date();
  const selectedIsCurrent = month === currentMonth;
  const anchor = selectedIsCurrent ? now : monthEnd(month);
  let start: Date;
  let end: Date;

  if (period === 'week') {
    end = anchor;
    start = new Date(anchor);
    start.setDate(anchor.getDate() - 6);
    return { start: ymd(start), end: ymd(end), label: selectedIsCurrent ? 'This Week' : `Week ending ${monthLabel(ymd(end).slice(0, 7)).split(' ')[0]} ${end.getDate()}` };
  }
  if (period === 'quarter') {
    const qStartMonth = Math.floor(anchor.getMonth() / 3) * 3;
    start = new Date(anchor.getFullYear(), qStartMonth, 1);
    end = selectedIsCurrent ? now : new Date(anchor.getFullYear(), qStartMonth + 3, 0);
    return { start: ymd(start), end: ymd(end), label: `Q${Math.floor(anchor.getMonth() / 3) + 1} ${anchor.getFullYear()}` };
  }
  if (period === 'year') {
    start = new Date(anchor.getFullYear(), 0, 1);
    end = selectedIsCurrent ? now : new Date(anchor.getFullYear(), 11, 31);
    return { start: ymd(start), end: ymd(end), label: `${anchor.getFullYear()}` };
  }

  start = new Date(anchor.getFullYear(), anchor.getMonth(), 1);
  end = selectedIsCurrent ? now : monthEnd(month);
  return { start: ymd(start), end: ymd(end), label: monthLabel(month) };
}

function totalSpendBucket(category: string, group?: string) {
  const key = `${category} ${group || ''}`.toLowerCase();
  if (/rent|housing|electric|internet|phone|utilities?|water|sewer|trash|insurance|loan|mortgage/.test(key)) return 'bills';
  if (/subscription|streaming|software|cloud/.test(key)) return 'subscriptions';
  return 'spending';
}

export default function Spending() {
  const router = useRouter();
  const insets = useSafeAreaInsets();
  const curKey = useMemo(() => currentMonthKey(), []);
  const [month, setMonth] = useSelectedMonth();
  const [period, setPeriod] = useState<Period>('month');
  const [totalExpanded, setTotalExpanded] = useState(true);
  // Current month keeps hitting the warmed `spending-current` cache (month=undefined).
  const apiMonth = month === curKey ? undefined : month;
  const selectedWindow = useMemo(() => periodWindow(period, month, curKey), [period, month, curKey]);
  const spendingParams = period === 'month' ? apiMonth : { start: selectedWindow.start, end: selectedWindow.end };
  const trends = useTrends(60);
  const spending = useSpending(spendingParams);
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
  const groupByCategory = useMemo(() => {
    const map = new Map<string, string>();
    for (const group of budgets.data?.groups ?? []) {
      for (const cat of group.categories ?? []) map.set(cat.name.toLowerCase(), group.name);
    }
    return map;
  }, [budgets.data]);
  const totalSpendRows = useMemo(() => {
    let bills = 0;
    let subscriptions = 0;
    let everyday = 0;
    for (const [cat, amt] of spendEntries) {
      const bucket = totalSpendBucket(cat, groupByCategory.get(cat.toLowerCase()));
      if (bucket === 'bills') bills += amt;
      else if (bucket === 'subscriptions') subscriptions += amt;
      else everyday += amt;
    }
    return [
      { key: 'spending', label: 'Spending', amount: everyday, target: 'Spending' },
      { key: 'bills', label: 'Bills & Utilities', amount: bills, target: 'Bills & Utilities' },
      { key: 'subscriptions', label: 'Subscriptions', amount: subscriptions, target: 'Subscriptions' },
    ].filter((row) => row.amount > 0.005);
  }, [groupByCategory, spendEntries]);
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
  const categoryParams = (name: string) => ({
    name,
    start: selectedWindow.start,
    end: selectedWindow.end,
    label: selectedWindow.label,
  });

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
              <SummaryRow testID="spending-income-row" icon="dollarsign.circle" label="Income" value={fmtPos(totalIncome)} onPress={() => router.push({ pathname: '/category/[name]', params: categoryParams('Income') })} />
              <SummaryRow testID="spending-total-row" icon="banknote" label="Total Spend" value={fmtPos(totalSpend)} expanded={totalExpanded} onPress={() => { haptics.tap(); setTotalExpanded((v) => !v); }} />
              {totalExpanded ? totalSpendRows.map((row, i) => (
                <SummaryRow
                  key={row.key}
                  testID={`spending-expanded-category-row-${i}`}
                  accessibilityID={`spending-summary-${row.key}-row`}
                  icon={row.key === 'spending' ? 'creditcard' : row.key === 'bills' ? 'bolt.fill' : 'play.rectangle.fill'}
                  label={row.label}
                  value={fmtPos(row.amount)}
                  inset
                  onPress={() => router.push({ pathname: '/category/[name]', params: categoryParams(row.target) })}
                />
              )) : null}
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
                  onPress={() => router.push({ pathname: '/category/[name]', params: categoryParams(cat) })}
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
                          router.push({ pathname: '/category/[name]', params: categoryParams(c.category) });
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
              <PlainRow icon="arrow.uturn.backward.circle" label="Reimbursements" value={fmtPos(reimbursementTotal)} onPress={() => router.push({ pathname: '/category/[name]', params: categoryParams('Reimbursement') })} />
              <PlainRow icon="minus.circle" label="Refunds & Credits" value={refundTotal ? `-${fmtPos(refundTotal)}` : '$0'} />
              <PlainRow icon="arrow.left.arrow.right.circle" label="Transfers" value="0" last />
            </Card>

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
          <Pressable testID={`spending-period-${p.key}`} key={p.key} onPress={() => { haptics.tap(); onChange(p.key); }} style={({ pressed }) => [styles.periodChip, on && styles.periodChipOn, pressed && { opacity: 0.7 }]}>
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

function SummaryRow({ icon, label, value, onPress, expanded, inset, muted, info, last, testID, accessibilityID }: {
  icon: SymbolViewProps['name']; label: string; value: string; onPress?: () => void; expanded?: boolean; inset?: boolean; muted?: boolean; info?: boolean; last?: boolean; testID?: string; accessibilityID?: string;
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
    return <Pressable testID={accessibilityID || testID} onPress={onPress} style={({ pressed }) => [styles.summaryRow, last && styles.lastRow, pressed && { opacity: 0.65 }]}>{body}</Pressable>;
  }
  return <View testID={accessibilityID || testID} style={[styles.summaryRow, last && styles.lastRow]}>{body}</View>;
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
      <SymbolView name={icon} tintColor={colors.text} size={18} resizeMode="scaleAspectFit" style={styles.plainIcon} />
      <Text style={styles.plainTitle}>{label}</Text>
      <Text style={styles.plainValue}>{value}</Text>
    </>
  );
  if (onPress) return <Pressable onPress={onPress} style={({ pressed }) => [styles.plainRow, last && styles.lastRow, pressed && { opacity: 0.65 }]}>{inner}</Pressable>;
  return <View style={[styles.plainRow, last && styles.lastRow]}>{inner}</View>;
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
  periodRow: { flexDirection: 'row', justifyContent: 'center', gap: 8, marginBottom: 15 },
  periodChip: { backgroundColor: '#343438', borderRadius: 999, paddingHorizontal: 15, paddingVertical: 7 },
  periodChipOn: { backgroundColor: '#fff' },
  periodText: { color: colors.text, fontSize: 13, fontWeight: '700' },
  periodTextOn: { color: '#19191d' },
  monthWrap: { marginHorizontal: -12, marginBottom: 18 },
  monthBars: { flexDirection: 'row', justifyContent: 'space-between', gap: 10 },
  monthCell: { flex: 1, minHeight: 100, borderRadius: 18, alignItems: 'center', justifyContent: 'flex-end', paddingBottom: 8 },
  monthCellOn: { backgroundColor: 'rgba(255,255,255,0.08)' },
  barStage: { height: 74, flexDirection: 'row', alignItems: 'flex-end', gap: 6 },
  incomeBar: { width: 9, borderRadius: 5, backgroundColor: '#6f8df7' },
  spendBar: { width: 9, borderRadius: 5, backgroundColor: 'rgba(255,255,255,0.55)' },
  monthText: { color: colors.muted, fontSize: 12, marginTop: 6 },
  monthTextOn: { color: colors.text, fontWeight: '800' },
  legendRow: { flexDirection: 'row', alignItems: 'center', justifyContent: 'center', gap: 7, marginTop: 10 },
  legendDot: { width: 9, height: 9, borderRadius: 5, backgroundColor: '#6f8df7' },
  spendDot: { backgroundColor: 'rgba(255,255,255,0.55)' },
  legendText: { color: colors.text, fontSize: 13, opacity: 0.82 },
  summaryCard: { paddingVertical: 0, overflow: 'hidden', marginBottom: 22, borderWidth: 0, borderRadius: 30, backgroundColor: '#242426' },
  summaryRow: { minHeight: 54, flexDirection: 'row', alignItems: 'center', gap: 12, borderBottomWidth: StyleSheet.hairlineWidth, borderBottomColor: 'rgba(255,255,255,0.10)', paddingHorizontal: 20 },
  summaryLabel: { color: colors.text, fontSize: 16, fontWeight: '600', flex: 1 },
  summaryInset: { fontSize: 15, color: colors.muted },
  summaryValue: { color: colors.text, fontSize: 16, fontWeight: '700' },
  section: { color: colors.text, textTransform: 'uppercase', letterSpacing: 1.1, fontSize: 12, fontWeight: '800', marginBottom: 10, marginLeft: 8 },
  budgetCard: { padding: 0, overflow: 'hidden', marginBottom: 22, borderWidth: 0, borderRadius: 30, backgroundColor: '#242426' },
  budgetHead: { flexDirection: 'row', alignItems: 'center', gap: 14, minHeight: 56, paddingHorizontal: 20, borderBottomWidth: StyleSheet.hairlineWidth, borderBottomColor: 'rgba(255,255,255,0.10)' },
  budgetTitle: { color: colors.text, fontSize: 17, fontWeight: '600', flex: 1 },
  budgetBody: { flexDirection: 'row', alignItems: 'center', justifyContent: 'space-between', paddingHorizontal: 20, paddingTop: 15 },
  mutedLabel: { color: colors.muted, fontSize: 12, fontWeight: '600' },
  budgetValue: { color: colors.text, fontSize: 26, fontWeight: '800', marginTop: 4 },
  ringRow: { flexDirection: 'row', gap: 9 },
  ring: { width: 44, height: 44, borderRadius: 22, borderWidth: 3, alignItems: 'center', justifyContent: 'center' },
  ringText: { color: colors.accentLight, fontSize: 15, fontWeight: '800' },
  progressTrack: { height: 6, borderRadius: 3, backgroundColor: 'rgba(255,255,255,0.17)', margin: 22, marginTop: 14, overflow: 'hidden' },
  progressFill: { height: 6, borderRadius: 3, backgroundColor: '#8aa0ff' },
  breakdownCard: { padding: 0, overflow: 'hidden', marginBottom: 22, borderWidth: 0, borderRadius: 30, backgroundColor: '#242426' },
  segmented: { flexDirection: 'row', borderBottomWidth: StyleSheet.hairlineWidth, borderBottomColor: 'rgba(255,255,255,0.10)' },
  segmentText: { flex: 1, textAlign: 'center', color: colors.muted, fontSize: 15, fontWeight: '700', paddingVertical: 15 },
  segmentOn: { color: colors.text },
  categoryRow: { minHeight: 70, flexDirection: 'row', alignItems: 'center', gap: 13, paddingHorizontal: 18, borderBottomWidth: StyleSheet.hairlineWidth, borderBottomColor: 'rgba(255,255,255,0.10)' },
  rowMid: { flex: 1, minWidth: 0 },
  rowTitle: { color: colors.text, fontSize: 16, fontWeight: '600' },
  rowSub: { color: colors.text, opacity: 0.56, fontSize: 14, marginTop: 4 },
  rowValue: { color: colors.text, fontSize: 16, fontWeight: '700' },
  categoryColor: { width: 4, height: 36, borderRadius: 2 },
  groupCard: { padding: 0, overflow: 'hidden', marginBottom: 22, borderWidth: 0, borderRadius: 30, backgroundColor: '#242426' },
  listRow: { minHeight: 72, flexDirection: 'row', alignItems: 'center', gap: 13, paddingHorizontal: 18, borderBottomWidth: StyleSheet.hairlineWidth, borderBottomColor: 'rgba(255,255,255,0.10)' },
  plainRow: { minHeight: 52, flexDirection: 'row', alignItems: 'center', gap: 10, paddingHorizontal: 18, borderBottomWidth: StyleSheet.hairlineWidth, borderBottomColor: 'rgba(255,255,255,0.10)' },
  lastRow: { borderBottomWidth: 0 },
  countBubble: { width: 38, height: 38, borderRadius: 19, backgroundColor: 'rgba(255,255,255,0.08)', alignItems: 'center', justifyContent: 'center' },
  countText: { color: colors.text, fontSize: 15, fontWeight: '700', opacity: 0.72 },
  nameLine: { flexDirection: 'row', alignItems: 'center', gap: 6 },
  cardCopy: { color: colors.text, opacity: 0.68, fontSize: 14, lineHeight: 20, padding: 20, borderBottomWidth: StyleSheet.hairlineWidth, borderBottomColor: 'rgba(255,255,255,0.12)' },
  plainIcon: { width: 30 },
  plainTitle: { color: colors.text, fontSize: 15, fontWeight: '600', flex: 1 },
  plainValue: { color: colors.text, fontSize: 15, fontWeight: '700' },
  outlineBtn: { borderWidth: 1.2, borderColor: colors.text, borderRadius: 999, alignItems: 'center', paddingVertical: 12, marginHorizontal: 22, marginVertical: 16 },
  outlineText: { color: colors.text, fontSize: 16, fontWeight: '700' },
  chevron: { color: colors.text, opacity: 0.82, fontSize: 18, fontWeight: '700' },
});
