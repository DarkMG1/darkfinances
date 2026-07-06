import React, { useMemo } from 'react';
import { Pressable, StyleSheet, Text, View } from 'react-native';
import { useRouter } from 'expo-router';
import { useInsights, useSpending, useTrends } from '@/api/hooks/finance.hooks';
import { Screen } from '@/components/screen';
import { Avatar, Card, CardTitle, EmptyState, ErrorState, PendingPill } from '@/components/ui';
import { SkeletonList } from '@/components/skeleton';
import { Donut, MonthNavigator } from '@/components/charts';
import { haptics } from '@/lib/haptics';
import { currentMonthKey, useSelectedMonth } from '@/lib/selectedMonth';
import { categoryColors, colors, fmtDate, fmtPos, monthLabel } from '@/theme/colors';

export default function Spending() {
  const router = useRouter();
  const curKey = useMemo(() => currentMonthKey(), []);
  const [month, setMonth] = useSelectedMonth();
  // Current month keeps hitting the warmed `spending-current` cache (month=undefined).
  const apiMonth = month === curKey ? undefined : month;
  const trends = useTrends(60);
  const spending = useSpending(apiMonth);
  const insights = useInsights(apiMonth);
  const cur = spending.data?.current;
  const prev = spending.data?.prev;
  const spendDelta = cur && prev && prev.totalSpend > 0 ? ((cur.totalSpend - prev.totalSpend) / prev.totalSpend) * 100 : null;

  // Bars/navigation span exactly as far back as there's data: trim leading
  // buckets with no spend and no income from the (ascending) trends series.
  const availMonths = useMemo(() => {
    const ms = trends.data?.months ?? [];
    let i = 0;
    while (i < ms.length && ms[i].spend === 0 && ms[i].income === 0) i++;
    const trimmed = ms.slice(i).map((m) => ({ month: m.month, spend: m.spend }));
    return trimmed.length ? trimmed : [{ month: curKey, spend: cur?.totalSpend ?? 0 }];
  }, [trends.data, curKey, cur]);

  const entries = useMemo(
    () => (cur ? Object.entries(cur.spending).sort((a, b) => b[1] - a[1]) : []),
    [cur]
  );
  // A category that nets negative is a pure credit/refund (e.g. Amazon returns
  // with no offsetting purchases that month) — surface it separately instead of
  // rendering it as if it were positive spend.
  const spendEntries = useMemo(() => entries.filter(([, v]) => v > 0.005), [entries]);
  const refundEntries = useMemo(() => entries.filter(([, v]) => v < -0.005).sort((a, b) => a[1] - b[1]), [entries]);
  const donutData = spendEntries.slice(0, 10).map(([label, value], i) => ({ label, value, color: categoryColors[i % categoryColors.length] }));
  const max = spendEntries[0]?.[1] || 1;

  // Real-spend merchants come from the backend (excludes transfers/investments/
  // CC payments/reimbursement), so savings moves and brokerage buys never show up.
  const topMerchants = insights.data?.topMerchants ?? [];

  return (
    <Screen title="Spending" refreshing={spending.isFetching || insights.isFetching} onRefresh={() => { spending.refetch(); insights.refetch(); trends.refetch(); }}>
      <MonthNavigator months={availMonths} selected={month} onSelect={setMonth} currentKey={curKey} />

      {spending.isLoading ? (
        <SkeletonList rows={8} />
      ) : spending.isError ? (
        <ErrorState error={spending.error?.error} onRetry={() => { spending.refetch(); insights.refetch(); }} />
      ) : !spendEntries.length && !refundEntries.length ? (
        <EmptyState icon="creditcard">{month === curKey ? 'No spending this month' : `No spending in ${monthLabel(month)}`}</EmptyState>
      ) : (
        <>
          <Card style={{ alignItems: 'center', marginBottom: 16 }}>
            <View style={styles.donutWrap}>
              <Donut size={200} thickness={26} data={donutData} />
              <View style={styles.donutCenter}>
                <Text style={styles.donutAmt}>{fmtPos(cur!.totalSpend)}</Text>
                <Text style={styles.donutLabel}>total spent</Text>
                {spendDelta != null ? (
                  <Text style={[styles.donutDelta, { color: spendDelta > 0 ? colors.red : colors.green }]}>
                    {spendDelta > 0 ? '▲' : '▼'} {Math.abs(spendDelta).toFixed(0)}% vs last
                  </Text>
                ) : null}
              </View>
            </View>
          </Card>

          <Card>
            {spendEntries.map(([cat, amt], i) => (
              <Pressable
                key={cat}
                style={({ pressed }) => [styles.row, pressed && { opacity: 0.6 }]}
                onPress={() => router.push({ pathname: '/category/[name]', params: { name: cat, ...(apiMonth ? { month: apiMonth } : {}) } })}
              >
                <Avatar category={cat} size={30} />
                <Text style={styles.catName} numberOfLines={1}>{cat}</Text>
                <View style={styles.barWrap}>
                  <View style={[styles.bar, { width: `${(amt / max) * 100}%`, backgroundColor: categoryColors[i % categoryColors.length] }]} />
                </View>
                <Text style={styles.amt}>{fmtPos(amt)}</Text>
                <Text style={styles.chevron}>›</Text>
              </Pressable>
            ))}
          </Card>

          <View style={{ marginTop: 12 }}>
            <CardTitle>Reimbursements</CardTitle>
            <Card>
              <Pressable
                style={({ pressed }) => [styles.iRow, { borderBottomWidth: 0 }, pressed && { opacity: 0.6 }]}
                onPress={() => { haptics.tap(); router.push({ pathname: '/category/[name]', params: { name: 'Reimbursement' } }); }}
              >
                <Avatar category="Reimbursement" size={34} />
                <View style={{ flex: 1 }}>
                  <Text style={styles.iName}>View all reimbursements</Text>
                  <Text style={styles.iSub}>Fronts you paid + paybacks received</Text>
                </View>
                <Text style={[styles.chevron, { marginLeft: 6 }]}>›</Text>
              </Pressable>
            </Card>
          </View>

          {refundEntries.length ? (
            <View style={{ marginTop: 12 }}>
              <CardTitle>Refunds & credits</CardTitle>
              <Card>
                {refundEntries.map(([cat, amt]) => (
                  <Pressable
                    key={cat}
                    style={({ pressed }) => [styles.row, pressed && { opacity: 0.6 }]}
                    onPress={() => router.push({ pathname: '/category/[name]', params: { name: cat, ...(apiMonth ? { month: apiMonth } : {}) } })}
                  >
                    <Avatar category={cat} size={30} />
                    <Text style={styles.catName} numberOfLines={1}>{cat}</Text>
                    <Text style={[styles.amt, { color: colors.green }]}>+{fmtPos(Math.abs(amt))}</Text>
                    <Text style={styles.chevron}>›</Text>
                  </Pressable>
                ))}
              </Card>
              <Text style={styles.refundHint}>Net credits this month — these reduce your total spend.</Text>
            </View>
          ) : null}

          {topMerchants.length ? (
            <View style={{ marginTop: 12 }}>
              <CardTitle>Top Merchants</CardTitle>
              <Card>
                {topMerchants.map((m) => (
                  <Pressable
                    key={m.payee}
                    style={({ pressed }) => [styles.iRow, pressed && { opacity: 0.6 }]}
                    onPress={() => { haptics.tap(); router.push({ pathname: '/merchant/[name]', params: { name: m.payee } }); }}
                  >
                    <Avatar label={m.payee} category={m.category ?? undefined} size={34} />
                    <View style={{ flex: 1 }}>
                      <Text style={styles.iName} numberOfLines={1}>{m.payee}</Text>
                      <Text style={styles.iSub}>{m.count} transaction{m.count === 1 ? '' : 's'}</Text>
                    </View>
                    <Text style={styles.iAmt}>{fmtPos(m.total)}</Text>
                    <Text style={[styles.chevron, { marginLeft: 6 }]}>›</Text>
                  </Pressable>
                ))}
              </Card>
            </View>
          ) : null}

          {insights.data?.largestCharges.length ? (
            <View style={{ marginTop: 12 }}>
              <CardTitle>Largest Charges</CardTitle>
              <Card>
                {insights.data.largestCharges.slice(0, 6).map((c, i) => (
                  <Pressable
                    key={c.id ?? i}
                    style={({ pressed }) => [styles.iRow, pressed && { opacity: 0.6 }]}
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
                          },
                        });
                      } else {
                        // older backend / stale cache without a txn id — drill into the category
                        router.push({ pathname: '/category/[name]', params: { name: c.category, ...(apiMonth ? { month: apiMonth } : {}) } });
                      }
                    }}
                  >
                    <Avatar label={c.payee} category={c.category} size={34} />
                    <View style={{ flex: 1 }}>
                      <View style={styles.nameLine}>
                        <Text style={[styles.iName, { flexShrink: 1 }]} numberOfLines={1}>{c.payee}</Text>
                        {c.cleared === false ? <PendingPill /> : null}
                      </View>
                      <Text style={styles.iSub}>{fmtDate(c.date)} · {c.category}</Text>
                    </View>
                    <Text style={styles.iAmt}>{fmtPos(Math.abs(c.amount))}</Text>
                    <Text style={[styles.chevron, { marginLeft: 6 }]}>›</Text>
                  </Pressable>
                ))}
              </Card>
            </View>
          ) : null}

          {insights.data?.anomalies.length ? (
            <View style={{ marginTop: 12 }}>
              <CardTitle>Spending Spikes</CardTitle>
              <Card>
                {insights.data.anomalies.map((a, i) => (
                  <View key={i} style={styles.iRow}>
                    <Avatar category={a.category} size={34} />
                    <View style={{ flex: 1 }}>
                      <Text style={styles.iName}>{a.category}</Text>
                      <Text style={styles.iSub}>avg {fmtPos(a.avg)}/mo</Text>
                    </View>
                    <Text style={[styles.iAmt, { color: colors.red }]}>
                      {fmtPos(a.current)}{a.deltaPct != null ? `  +${a.deltaPct}%` : ''}
                    </Text>
                  </View>
                ))}
              </Card>
            </View>
          ) : null}
        </>
      )}
    </Screen>
  );
}

const styles = StyleSheet.create({
  donutWrap: { width: 200, height: 200, alignItems: 'center', justifyContent: 'center', position: 'relative' },
  donutCenter: { position: 'absolute', alignItems: 'center' },
  donutAmt: { color: colors.text, fontSize: 22, fontWeight: '800', letterSpacing: -0.5 },
  donutLabel: { color: colors.muted, fontSize: 11 },
  donutDelta: { fontSize: 11, fontWeight: '700', marginTop: 3 },
  row: { flexDirection: 'row', alignItems: 'center', gap: 8, paddingVertical: 7 },
  dot: { width: 8, height: 8, borderRadius: 4 },
  catName: { color: colors.text, fontSize: 13, flex: 1 },
  barWrap: { width: 64, height: 4, backgroundColor: colors.surface2, borderRadius: 2, overflow: 'hidden' },
  bar: { height: 4, borderRadius: 2 },
  amt: { color: colors.text, fontSize: 13, fontWeight: '600', width: 68, textAlign: 'right' },
  chevron: { color: colors.muted, fontSize: 16, fontWeight: '700', width: 12, textAlign: 'right' },
  iRow: { flexDirection: 'row', alignItems: 'center', gap: 12, paddingVertical: 8, borderBottomWidth: StyleSheet.hairlineWidth, borderBottomColor: colors.border },
  nameLine: { flexDirection: 'row', alignItems: 'center', gap: 6 },
  iName: { color: colors.text, fontSize: 13 },
  iSub: { color: colors.muted, fontSize: 11, marginTop: 1 },
  iAmt: { color: colors.text, fontSize: 13, fontWeight: '600' },
  refundHint: { color: colors.muted, fontSize: 11, marginTop: 8, lineHeight: 15 },
});
