import React, { useMemo, useState } from 'react';
import { Pressable, StyleSheet, Text, View } from 'react-native';
import { SymbolView, SymbolViewProps } from 'expo-symbols';
import { useRouter } from 'expo-router';
import Svg, { Circle } from 'react-native-svg';
import { useBudgets, useInsights, useSpending, useTags, useToday, useTrends } from '@/api/hooks/finance.hooks';
import { Screen } from '@/components/screen';
import { Avatar, Card, CardTitle, EmptyState, ErrorState, PendingPill } from '@/components/ui';
import { SkeletonList } from '@/components/skeleton';
import { haptics } from '@/lib/haptics';
import { addDateOnlyDays, financeToday, monthEnd } from '@/lib/date-only';
import { currentMonthKey, useSelectedMonth } from '@/lib/selectedMonth';
import { categoryColors, colors, fmtDate, fmtPos, monthLabel } from '@/theme/colors';

type Period = 'week' | 'month' | 'quarter' | 'year';
type BreakdownMode = 'categories' | 'tags';
const PERIODS: { key: Period; label: string }[] = [
  { key: 'week', label: 'Week' },
  { key: 'month', label: 'Month' },
  { key: 'quarter', label: 'Quarter' },
  { key: 'year', label: 'Year' },
];

function periodWindow(period: Period, month: string, currentMonth: string) {
  const selectedIsCurrent = month === currentMonth;
  const anchorYmd = selectedIsCurrent ? financeToday() : monthEnd(month);
  const [anchorYear, anchorMonth, anchorDay] = anchorYmd.split('-').map(Number);

  if (period === 'week') {
    return {
      start: addDateOnlyDays(anchorYmd, -6),
      end: anchorYmd,
      label: selectedIsCurrent ? 'This Week' : `Week ending ${monthLabel(anchorYmd.slice(0, 7)).split(' ')[0]} ${anchorDay}`,
    };
  }
  if (period === 'quarter') {
    const quarter = Math.floor((anchorMonth - 1) / 3) + 1;
    const startMonth = (quarter - 1) * 3 + 1;
    const endMonth = startMonth + 2;
    const quarterStart = `${anchorYear}-${String(startMonth).padStart(2, '0')}-01`;
    const quarterEnd = selectedIsCurrent ? anchorYmd : monthEnd(`${anchorYear}-${String(endMonth).padStart(2, '0')}`);
    return { start: quarterStart, end: quarterEnd, label: `Q${quarter} ${anchorYear}` };
  }
  if (period === 'year') {
    return {
      start: `${anchorYear}-01-01`,
      end: selectedIsCurrent ? anchorYmd : `${anchorYear}-12-31`,
      label: `${anchorYear}`,
    };
  }

  return { start: `${month}-01`, end: selectedIsCurrent ? anchorYmd : monthEnd(month), label: monthLabel(month) };
}

function totalSpendBucket(category: string, group?: string) {
  const key = `${category} ${group || ''}`.toLowerCase();
  if (/rent|housing|electric|internet|phone|utilities?|water|sewer|trash|insurance|loan|mortgage/.test(key)) return 'bills';
  if (/subscription|streaming|software|cloud/.test(key)) return 'subscriptions';
  return 'spending';
}

export default function Spending() {
  const router = useRouter();
  const curKey = currentMonthKey();
  const [month, setMonth] = useSelectedMonth();
  const [period, setPeriod] = useState<Period>('month');
  const [totalExpanded, setTotalExpanded] = useState(false);
  const [showAllCategories, setShowAllCategories] = useState(false);
  const [breakdownMode, setBreakdownMode] = useState<BreakdownMode>('categories');
  // Current month keeps hitting the warmed `spending-current` cache (month=undefined).
  const apiMonth = month === curKey ? undefined : month;
  const selectedWindow = useMemo(() => periodWindow(period, month, curKey), [period, month, curKey]);
  const spendingParams = period === 'month' ? apiMonth : { start: selectedWindow.start, end: selectedWindow.end };
  const useCurrentToday = period === 'month' && apiMonth === undefined;
  const today = useToday();
  const trends = useTrends(60);
  const spending = useSpending(spendingParams, { enabled: !useCurrentToday });
  const budgets = useBudgets(apiMonth);
  const insights = useInsights(apiMonth);
  const tags = useTags();
  const cur = useCurrentToday ? today.data?.spending.current : spending.data?.current;
  const spendingLoading = useCurrentToday ? today.isLoading : spending.isLoading;
  const spendingError = useCurrentToday ? today.error : spending.error;
  const spendingIsError = useCurrentToday ? today.isError : spending.isError;

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
      { key: 'bills', label: 'Bills & Utilities', amount: bills, target: 'Bills & Utilities' },
      { key: 'spending', label: 'Spending', amount: everyday, target: 'Spending' },
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
  const refresh = () => Promise.all([
    useCurrentToday ? today.refetch() : spending.refetch(),
    insights.refetch(),
    trends.refetch(),
    budgets.refetch(),
  ]);
  const categoryParams = (name: string, bucket?: string) => ({
    name,
    start: selectedWindow.start,
    end: selectedWindow.end,
    label: selectedWindow.label,
    bucket,
  });

  const headerRight = (
    <Pressable hitSlop={10} onPress={() => { haptics.tap(); router.push('/(tabs)/settings' as never); }}>
      <View style={styles.headerIcon}>
        <SymbolView name="gearshape" tintColor={colors.muted} size={18} resizeMode="scaleAspectFit" />
      </View>
    </Pressable>
  );

  return (
    <Screen title="Spending" right={headerRight} onRefresh={refresh} testID="spending-screen">
      <View style={styles.controlsCard}>
        <PeriodChips value={period} onChange={setPeriod} />
        <DualMonthBars months={chartMonths} selected={month} onSelect={setMonth} />
      </View>

      {spendingLoading ? (
        <SkeletonList rows={8} />
      ) : spendingIsError ? (
        <ErrorState error={spendingError?.error} onRetry={refresh} />
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
                onPress={() => router.push({ pathname: '/category/[name]', params: categoryParams(row.target, row.key) })}
              />
            )) : null}
            <SummaryRow icon="minus.circle" label="Net Income" value={`${netIncome < 0 ? '-' : ''}${fmtPos(Math.abs(netIncome))}`} muted last />
          </SummaryCard>

          <SectionTitle>Your Budget</SectionTitle>
          <Card style={styles.budgetCard}>
            <Pressable style={({ pressed }) => [styles.budgetHead, pressed && { opacity: 0.65 }]} onPress={() => router.push('/budgets')}>
              <View style={styles.inlineIcon}>
                <SymbolView name="rectangle.grid.2x2" tintColor={colors.accentLight} size={18} resizeMode="scaleAspectFit" />
              </View>
              <Text style={styles.budgetTitle}>{monthLabel(month)} Budget</Text>
              <Text style={styles.chevron}>›</Text>
            </Pressable>
            <View style={styles.budgetBody}>
              <View style={styles.budgetMain}>
                <Text style={styles.mutedLabel}>Left for spending</Text>
                <Text style={styles.budgetValue}>{budgetLeft < 0 ? '-' : ''}{fmtPos(Math.abs(budgetLeft))}</Text>
              </View>
              <View style={styles.budgetFacts}>
                <Text style={styles.budgetFact}>{budgetPct.toFixed(0)}% of target used</Text>
                {refundTotal > 0.005 ? <Text style={styles.budgetFact}>{fmtPos(refundTotal)} refunds shown separately</Text> : null}
              </View>
            </View>
            <View style={styles.progressTrack}>
              <View style={[styles.progressFill, { width: `${budgetPct}%` }]} />
            </View>
          </Card>

          <SectionTitle>Breakdown</SectionTitle>
          <Card style={styles.breakdownCard}>
            <View style={styles.segmented}>
              <Pressable
                testID={breakdownMode === 'categories' ? 'spending-breakdown-segment-categories-selected' : 'spending-breakdown-segment-categories'}
                onPress={() => { haptics.tap(); setBreakdownMode('categories'); }}
                style={[styles.segmentButton, breakdownMode === 'categories' && styles.segmentOn]}
              >
                <Text style={[styles.segmentText, breakdownMode === 'categories' && styles.segmentTextOn]}>Categories</Text>
              </Pressable>
              <Pressable
                testID={breakdownMode === 'tags' ? 'spending-breakdown-segment-tags-selected' : 'spending-breakdown-segment-tags'}
                onPress={() => { haptics.tap(); setBreakdownMode('tags'); }}
                style={[styles.segmentButton, breakdownMode === 'tags' && styles.segmentOn]}
              >
                <Text style={[styles.segmentText, breakdownMode === 'tags' && styles.segmentTextOn]}>Tags</Text>
              </Pressable>
            </View>
            {breakdownMode === 'categories' ? (
              <>
                <BreakdownCircle entries={breakdownCategories.slice(0, 5)} total={totalSpend} />
                {(showAllCategories ? breakdownCategories : breakdownCategories.slice(0, 5)).map(([cat, amt], i) => (
                  <CategoryRow
                    key={cat}
                    category={cat}
                    amount={amt}
                    pct={totalSpend > 0 ? amt / totalSpend : 0}
                    color={categoryColors[i % categoryColors.length]}
                    onPress={() => router.push({ pathname: '/category/[name]', params: categoryParams(cat) })}
                  />
                ))}
                {hiddenCategories ? (
                  <OutlineButton
                    label={showAllCategories ? 'Show Less' : `See ${hiddenCategories} More`}
                    onPress={() => { haptics.tap(); setShowAllCategories((value) => !value); }}
                  />
                ) : null}
              </>
            ) : (
              <View testID="spending-breakdown-tags-list">
                {(tags.data?.tags ?? []).slice(0, 6).map((tag, i) => (
                  <TagBreakdownRow
                    key={tag.raw}
                    testID={`spending-breakdown-tag-row-${i}`}
                    label={tag.label}
                    count={tag.count}
                    kind={tag.kind}
                    onPress={() => router.push({ pathname: '/tag/[tag]', params: { tag: tag.raw } })}
                  />
                ))}
                {tags.data && !tags.data.tags.length ? <Text style={styles.emptyCopy}>No tagged transactions yet.</Text> : null}
                {tags.isLoading ? <Text style={styles.emptyCopy}>Loading tags...</Text> : null}
              </View>
            )}
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
                <Text style={styles.cardCopy}>Tap a transaction to edit its details.</Text>
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
                          params: { id: c.id, date: c.date, accountId: c.accountId || '' },
                        });
                      } else {
                        router.push({ pathname: '/category/[name]', params: categoryParams(c.category) });
                      }
                    }}
                  />
                ))}
                <OutlineButton label="See all activity" onPress={() => { haptics.tap(); router.push('/(tabs)/transactions' as never); }} />
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
    </Screen>
  );
}

function PeriodChips({ value, onChange }: { value: Period; onChange: (p: Period) => void }) {
  return (
    <View style={styles.periodRow}>
      {PERIODS.map((p) => {
        const on = p.key === value;
        return (
          <Pressable testID={on ? `spending-period-${p.key}-selected` : `spending-period-${p.key}`} key={p.key} onPress={() => { haptics.tap(); onChange(p.key); }} style={({ pressed }) => [styles.periodChip, on && styles.periodChipOn, pressed && { opacity: 0.7 }]}>
            <Text style={[styles.periodText, on && styles.periodTextOn]}>{p.label}</Text>
          </Pressable>
        );
      })}
    </View>
  );
}

function DualMonthBars({ months, selected, onSelect }: { months: { month: string; spend: number; income: number }[]; selected: string; onSelect: (m: string) => void }) {
  const max = Math.max(1, ...months.map((m) => Math.max(m.spend, m.income)));
  const barMax = 48;
  return (
    <View style={styles.monthWrap}>
      <View style={styles.monthBars}>
        {months.map((m) => {
          const on = m.month === selected;
          return (
            <Pressable key={m.month} onPress={() => { haptics.tap(); onSelect(m.month); }} style={[styles.monthCell, on && styles.monthCellOn]}>
              <View style={styles.barStage}>
                <View style={[styles.incomeBar, { height: Math.max(2, (m.income / max) * barMax) }]} />
                <View style={[styles.spendBar, { height: Math.max(2, (m.spend / max) * barMax) }]} />
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
      {info ? <SymbolView name="info.circle" tintColor={colors.muted} size={16} resizeMode="scaleAspectFit" /> : onPress ? <Text style={styles.chevron}>{expanded ? '⌃' : '›'}</Text> : null}
    </>
  );
  if (onPress) {
    return <Pressable testID={accessibilityID || testID} accessibilityRole="button" accessibilityLabel={`${label}, ${value}`} accessibilityState={expanded === undefined ? undefined : { expanded }} onPress={onPress} style={({ pressed }) => [styles.summaryRow, last && styles.lastRow, pressed && { opacity: 0.65 }]}>{body}</Pressable>;
  }
  return <View testID={accessibilityID || testID} style={[styles.summaryRow, last && styles.lastRow]}>{body}</View>;
}

function SectionTitle({ children }: { children: React.ReactNode }) {
  return <CardTitle style={styles.section}>{children}</CardTitle>;
}

function BreakdownCircle({ entries, total }: { entries: [string, number][]; total: number }) {
  const size = 118;
  const stroke = 14;
  const radius = (size - stroke) / 2;
  const circumference = 2 * Math.PI * radius;
  const pcts = entries.map(([, amount]) => (total > 0 ? Math.max(0.025, amount / total) : 0));
  const segments = entries.map(([cat], i) => ({
    cat,
    pct: pcts[i],
    offset: pcts.slice(0, i).reduce((sum, pct) => sum + pct, 0),
  }));

  return (
    <View style={styles.breakdownHero}>
      <View style={styles.breakdownRingWrap} testID="spending-breakdown-circle">
        <Svg width={size} height={size} viewBox={`0 0 ${size} ${size}`}>
          <Circle cx={size / 2} cy={size / 2} r={radius} stroke="rgba(255,255,255,0.10)" strokeWidth={stroke} fill="none" />
          {segments.map(({ cat, pct, offset }, i) => {
            const dash = pct * circumference;
            const dashOffset = -offset * circumference;
            return (
              <Circle
                key={cat}
                cx={size / 2}
                cy={size / 2}
                r={radius}
                stroke={categoryColors[i % categoryColors.length]}
                strokeWidth={stroke}
                fill="none"
                strokeDasharray={`${dash} ${circumference - dash}`}
                strokeDashoffset={dashOffset}
                strokeLinecap="round"
                rotation="-90"
                origin={`${size / 2}, ${size / 2}`}
              />
            );
          })}
        </Svg>
        <View style={styles.breakdownRingCenter}>
          <Text style={styles.breakdownCenterLabel}>Spend</Text>
          <Text style={styles.breakdownCenterValue}>{fmtPos(total).replace('.00', '')}</Text>
        </View>
      </View>
      <View style={styles.breakdownLegend}>
        {entries.slice(0, 4).map(([cat], i) => (
          <View key={cat} style={styles.breakdownLegendRow}>
            <View style={[styles.breakdownLegendDot, { backgroundColor: categoryColors[i % categoryColors.length] }]} />
            <Text style={styles.breakdownLegendText} numberOfLines={1}>{cat}</Text>
          </View>
        ))}
      </View>
    </View>
  );
}

function CategoryRow({ category, amount, pct, color, onPress }: { category: string; amount: number; pct: number; color: string; onPress: () => void }) {
  return (
    <Pressable accessibilityRole="button" accessibilityLabel={`${category}, ${fmtPos(amount)}, ${Math.round(pct * 100)} percent of spend`} onPress={onPress} style={({ pressed }) => [styles.categoryRow, pressed && { opacity: 0.65 }]}>
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
    <Pressable accessibilityRole="button" accessibilityLabel={`${merchant}, ${count} transactions, ${fmtPos(total)}`} onPress={onPress} style={({ pressed }) => [styles.listRow, last && styles.lastRow, pressed && { opacity: 0.65 }]}>
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
    <Pressable accessibilityRole="button" accessibilityLabel={`${payee || 'No payee'}, ${fmtPos(amount)}, ${fmtDate(date)}${pending ? ', pending' : ''}`} onPress={onPress} style={({ pressed }) => [styles.listRow, last && styles.lastRow, pressed && { opacity: 0.65 }]}>
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

function TagBreakdownRow({ label, count, kind, onPress, testID }: { label: string; count: number; kind: 'event' | 'tag'; onPress: () => void; testID: string }) {
  const tint = kind === 'event' ? colors.accentLight : colors.green;
  return (
    <Pressable
      testID={testID}
      accessibilityRole="button"
      onPress={() => { haptics.tap(); onPress(); }}
      style={({ pressed }) => [styles.tagBreakdownRow, pressed && { opacity: 0.65 }]}
    >
      <View style={[styles.tagBreakdownIcon, { backgroundColor: tint + '22' }]}>
        <SymbolView name={kind === 'event' ? 'mappin.and.ellipse' : 'number'} tintColor={tint} size={15} resizeMode="scaleAspectFit" />
      </View>
      <View style={styles.rowMid}>
        <Text style={styles.rowTitle}>{label.charAt(0).toUpperCase() + label.slice(1)}</Text>
        <Text style={styles.rowSub}>{kind === 'event' ? 'Trip tag' : 'Tag'} · {count} transaction{count === 1 ? '' : 's'}</Text>
      </View>
      <Text style={styles.chevron}>›</Text>
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
  if (onPress) return <Pressable accessibilityRole="button" accessibilityLabel={`${label}, ${value}`} onPress={onPress} style={({ pressed }) => [styles.plainRow, last && styles.lastRow, pressed && { opacity: 0.65 }]}>{inner}</Pressable>;
  return <View style={[styles.plainRow, last && styles.lastRow]}>{inner}</View>;
}

function OutlineButton({ label, onPress }: { label: string; onPress: () => void }) {
  return (
    <Pressable accessibilityRole="button" accessibilityLabel={label} onPress={onPress} style={({ pressed }) => [styles.outlineBtn, pressed && { opacity: 0.65 }]}>
      <Text style={styles.outlineText}>{label}</Text>
    </Pressable>
  );
}

const styles = StyleSheet.create({
  headerIcon: { width: 30, height: 30, borderRadius: 15, backgroundColor: colors.surface2, borderColor: colors.border, borderWidth: 1, alignItems: 'center', justifyContent: 'center' },
  inlineIcon: { width: 32, height: 32, borderRadius: 16, backgroundColor: 'rgba(124,110,247,0.14)', alignItems: 'center', justifyContent: 'center' },
  controlsCard: { backgroundColor: colors.surface, borderColor: colors.border, borderWidth: 1, borderRadius: 14, padding: 12, marginBottom: 16 },
  periodRow: { flexDirection: 'row', gap: 8, marginBottom: 12 },
  periodChip: { flex: 1, backgroundColor: colors.surface2, borderColor: colors.border, borderWidth: 1, borderRadius: 10, paddingVertical: 8, alignItems: 'center' },
  periodChipOn: { backgroundColor: 'rgba(124,110,247,0.18)', borderColor: 'rgba(168,152,255,0.55)' },
  periodText: { color: colors.muted, fontSize: 12, fontWeight: '700' },
  periodTextOn: { color: colors.accentLight },
  monthWrap: { marginBottom: 0 },
  monthBars: { flexDirection: 'row', justifyContent: 'space-between', gap: 8 },
  monthCell: { flex: 1, minHeight: 82, borderRadius: 12, alignItems: 'center', justifyContent: 'flex-end', paddingBottom: 7, borderWidth: 1, borderColor: 'transparent' },
  monthCellOn: { backgroundColor: colors.surface2, borderColor: colors.border },
  barStage: { height: 56, flexDirection: 'row', alignItems: 'flex-end', gap: 5 },
  incomeBar: { width: 7, borderRadius: 4, backgroundColor: colors.green },
  spendBar: { width: 7, borderRadius: 4, backgroundColor: colors.accentLight },
  monthText: { color: colors.muted, fontSize: 11, marginTop: 5, fontWeight: '600' },
  monthTextOn: { color: colors.text, fontWeight: '800' },
  legendRow: { flexDirection: 'row', alignItems: 'center', justifyContent: 'center', gap: 6, marginTop: 10 },
  legendDot: { width: 7, height: 7, borderRadius: 4, backgroundColor: colors.green },
  spendDot: { backgroundColor: colors.accentLight },
  legendText: { color: colors.muted, fontSize: 11, fontWeight: '600' },
  summaryCard: { padding: 0, overflow: 'hidden', marginBottom: 16 },
  summaryRow: { minHeight: 50, flexDirection: 'row', alignItems: 'center', gap: 12, borderBottomWidth: StyleSheet.hairlineWidth, borderBottomColor: colors.border, paddingHorizontal: 16 },
  summaryLabel: { color: colors.text, fontSize: 15, fontWeight: '600', flex: 1 },
  summaryInset: { fontSize: 14, color: colors.muted },
  summaryValue: { color: colors.text, fontSize: 15, fontWeight: '700' },
  section: { marginBottom: 12, marginTop: 2 },
  budgetCard: { padding: 0, overflow: 'hidden', marginBottom: 16 },
  budgetHead: { flexDirection: 'row', alignItems: 'center', gap: 12, minHeight: 54, paddingHorizontal: 16, borderBottomWidth: StyleSheet.hairlineWidth, borderBottomColor: colors.border },
  budgetTitle: { color: colors.text, fontSize: 15, fontWeight: '700', flex: 1 },
  budgetBody: { flexDirection: 'row', alignItems: 'center', justifyContent: 'space-between', paddingHorizontal: 16, paddingTop: 14, gap: 12 },
  budgetMain: { flex: 1, minWidth: 0 },
  mutedLabel: { color: colors.muted, fontSize: 12, fontWeight: '600' },
  budgetValue: { color: colors.text, fontSize: 24, fontWeight: '800', marginTop: 4, letterSpacing: -0.5 },
  budgetFacts: { alignItems: 'flex-end', gap: 3, maxWidth: '48%' },
  budgetFact: { color: colors.muted, fontSize: 11, textAlign: 'right' },
  progressTrack: { height: 5, borderRadius: 3, backgroundColor: colors.surface2, margin: 16, marginTop: 14, overflow: 'hidden' },
  progressFill: { height: 5, borderRadius: 3, backgroundColor: colors.accent },
  breakdownCard: { padding: 0, overflow: 'hidden', marginBottom: 16 },
  segmented: { flexDirection: 'row', margin: 12, padding: 3, borderRadius: 10, backgroundColor: colors.surface2, borderColor: colors.border, borderWidth: 1 },
  segmentButton: { flex: 1, borderRadius: 8 },
  segmentText: { textAlign: 'center', color: colors.muted, fontSize: 12, fontWeight: '700', paddingVertical: 7 },
  segmentTextOn: { color: colors.text },
  segmentOn: { backgroundColor: colors.surface },
  breakdownHero: { flexDirection: 'row', alignItems: 'center', gap: 16, paddingHorizontal: 16, paddingBottom: 16, borderBottomWidth: StyleSheet.hairlineWidth, borderBottomColor: colors.border },
  breakdownRingWrap: { width: 118, height: 118, alignItems: 'center', justifyContent: 'center' },
  breakdownRingCenter: { position: 'absolute', alignItems: 'center', justifyContent: 'center' },
  breakdownCenterLabel: { color: colors.muted, fontSize: 11, fontWeight: '700', textTransform: 'uppercase', letterSpacing: 0.7 },
  breakdownCenterValue: { color: colors.text, fontSize: 16, fontWeight: '800', marginTop: 3, letterSpacing: -0.4 },
  breakdownLegend: { flex: 1, gap: 8 },
  breakdownLegendRow: { flexDirection: 'row', alignItems: 'center', gap: 8 },
  breakdownLegendDot: { width: 8, height: 8, borderRadius: 4 },
  breakdownLegendText: { color: colors.muted, fontSize: 12, fontWeight: '600', flex: 1 },
  categoryRow: { minHeight: 58, flexDirection: 'row', alignItems: 'center', gap: 12, paddingHorizontal: 16, paddingVertical: 10, borderBottomWidth: StyleSheet.hairlineWidth, borderBottomColor: colors.border },
  rowMid: { flex: 1, minWidth: 0 },
  rowTitle: { color: colors.text, fontSize: 15, fontWeight: '600' },
  rowSub: { color: colors.muted, fontSize: 12, marginTop: 2 },
  rowValue: { color: colors.text, fontSize: 15, fontWeight: '700' },
  categoryColor: { width: 3, height: 30, borderRadius: 2 },
  groupCard: { padding: 0, overflow: 'hidden', marginBottom: 16 },
  listRow: { minHeight: 58, flexDirection: 'row', alignItems: 'center', gap: 12, paddingHorizontal: 16, paddingVertical: 10, borderBottomWidth: StyleSheet.hairlineWidth, borderBottomColor: colors.border },
  tagBreakdownRow: { minHeight: 58, flexDirection: 'row', alignItems: 'center', gap: 12, paddingHorizontal: 16, paddingVertical: 10, borderTopWidth: StyleSheet.hairlineWidth, borderTopColor: colors.border },
  tagBreakdownIcon: { width: 38, height: 38, borderRadius: 19, alignItems: 'center', justifyContent: 'center' },
  plainRow: { minHeight: 50, flexDirection: 'row', alignItems: 'center', gap: 10, paddingHorizontal: 16, borderBottomWidth: StyleSheet.hairlineWidth, borderBottomColor: colors.border },
  lastRow: { borderBottomWidth: 0 },
  countBubble: { width: 38, height: 38, borderRadius: 19, backgroundColor: 'rgba(124,110,247,0.14)', alignItems: 'center', justifyContent: 'center' },
  countText: { color: colors.accentLight, fontSize: 13, fontWeight: '800' },
  nameLine: { flexDirection: 'row', alignItems: 'center', gap: 6 },
  cardCopy: { color: colors.muted, fontSize: 12, lineHeight: 17, paddingHorizontal: 16, paddingVertical: 12, borderBottomWidth: StyleSheet.hairlineWidth, borderBottomColor: colors.border },
  plainIcon: { width: 30 },
  plainTitle: { color: colors.text, fontSize: 14, fontWeight: '600', flex: 1 },
  plainValue: { color: colors.text, fontSize: 15, fontWeight: '700' },
  outlineBtn: { borderWidth: 1, borderColor: colors.border, backgroundColor: colors.surface2, borderRadius: 10, alignItems: 'center', paddingVertical: 10, marginHorizontal: 16, marginVertical: 14 },
  outlineText: { color: colors.accentLight, fontSize: 13, fontWeight: '700' },
  emptyCopy: { color: colors.muted, fontSize: 13, padding: 16 },
  chevron: { color: colors.muted, fontSize: 18, fontWeight: '700' },
});
