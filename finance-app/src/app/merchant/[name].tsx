import React, { useMemo, useState } from 'react';
import { Pressable, StyleSheet, Text, View } from 'react-native';
import Animated, { FadeInDown } from 'react-native-reanimated';
import { Stack, useLocalSearchParams, useRouter } from 'expo-router';
import { useMerchantHistory } from '@/api/hooks/finance.hooks';
import { PushScreen } from '@/components/screen';
import { QueryScreenBody } from '@/components/query-display';
import { Avatar, Card, EmptyState, PendingPill, SplitPill } from '@/components/ui';
import { MonthNavigator } from '@/components/charts';
import { SkeletonList } from '@/components/skeleton';
import { useFinanceToday } from '@/lib/date-only';
import { heroMetricAccessibilityLabel } from '@/lib/metric-a11y.js';
import { formatOptionalMoney, isKnownMoney } from '@/lib/money-display.js';
import { colors, fmtDate, fmtMoney, fmtPos } from '@/theme/colors';

const RANGES: { label: string; v: number }[] = [
  { label: '6M', v: 6 },
  { label: '1Y', v: 12 },
  { label: '2Y', v: 24 },
];

export default function MerchantDetail() {
  const router = useRouter();
  const params = useLocalSearchParams<{ name: string }>();
  const name = params.name ?? '';

  const [months, setMonths] = useState(12);
  const [selected, setSelected] = useState('');
  const hist = useMerchantHistory(name, months);

  const currentKey = useFinanceToday().slice(0, 7);

  const series = useMemo(
    () => (hist.data?.months ?? []).map((m) => ({ month: m.month, spend: isKnownMoney(m.total) ? m.total : null })),
    [hist.data]
  );

  const selectedMonth = selected || [...(hist.data?.months ?? [])].reverse().find((m) => m.count > 0)?.month || currentKey;
  const selMonth = (hist.data?.months ?? []).find((m) => m.month === selectedMonth);
  const rows = selMonth?.items ?? [];

  return (
    <PushScreen testID="merchant-detail-screen" onRefresh={hist.refetch}>
      <Stack.Screen options={{ title: name || 'Merchant' }} />
      <QueryScreenBody
        query={hist}
        loading={<SkeletonList hero rows={7} />}
        empty={null}
        hasContent={hist.data != null}
        refetchBannerTestID="merchant-refetch-banner"
        renderContent={(merchantData) => {
          const totalLabel = formatOptionalMoney(merchantData.total, fmtMoney);
          const avgLabel = isKnownMoney(merchantData.avg) ? fmtMoney(merchantData.avg) : null;
          return (
          <>
          <View
            style={styles.hero}
            accessible
            accessibilityLabel={heroMetricAccessibilityLabel(
              name || 'Merchant',
              totalLabel,
              `${merchantData.count ?? 0} transactions${avgLabel ? `, ${avgLabel} net average` : ''}, last ${months} months`,
            )}
          >
            <Avatar label={name} size={52} style={{ marginBottom: 10 }} />
            <Text style={styles.heroValue} accessibilityElementsHidden importantForAccessibility="no">{totalLabel}</Text>
            <Text style={styles.heroSub} accessibilityElementsHidden importantForAccessibility="no">
              {merchantData.count ?? 0} transaction{(merchantData.count ?? 0) === 1 ? '' : 's'}
              {avgLabel ? ` · ${avgLabel} net avg` : ''}
              {` · last ${months}mo`}
            </Text>
          </View>

          <Card style={{ marginBottom: 14 }}>
            <MonthNavigator months={series} selected={selectedMonth} onSelect={setSelected} currentKey={currentKey} />
            <View style={styles.rangeRow}>
              {RANGES.map((r) => (
                <Pressable
                  testID={`merchant-range-${r.label.toLowerCase()}${months === r.v ? '-selected' : ''}`}
                  key={r.label}
                  onPress={() => setMonths(r.v)}
                  style={({ pressed }) => [styles.range, months === r.v && styles.rangeActive, pressed && { opacity: 0.7 }]}
                >
                  <Text style={[styles.rangeText, months === r.v && styles.rangeTextActive]}>{r.label}</Text>
                </Pressable>
              ))}
            </View>
          </Card>

          <View style={styles.monthHead}>
            <Text style={styles.monthTitle}>{selMonth ? monthTitle(selMonth.month) : ''}</Text>
            {selMonth ? <Text style={styles.monthTotal}>{formatOptionalMoney(selMonth.total, fmtMoney)}</Text> : null}
          </View>

          {rows.length === 0 ? (
            <EmptyState icon="tray">No charges this month</EmptyState>
          ) : (
            <Card style={styles.list}>
              {rows.map((t, i) => (
                <Animated.View key={t.id} entering={FadeInDown.duration(180).delay(Math.min(i * 18, 180))}>
                  <Pressable
                    testID={`merchant-transaction-${t.id}`}
                    style={({ pressed }) => [styles.row, pressed && { opacity: 0.6 }]}
                    onPress={() =>
                      router.push({
                        pathname: '/transaction/[id]',
                        params: { id: t.id, date: t.date, accountId: t.accountId },
                      })
                    }
                  >
                    <View style={styles.mid}>
                      <View style={styles.rowTop}>
                        <Text style={styles.sub} numberOfLines={1}>{fmtDate(t.date)} · {t.category || 'uncategorized'}</Text>
                        {t.isLeg ? <SplitPill /> : null}
                      </View>
                      <Text style={styles.acct} numberOfLines={1}>{t.account}</Text>
                    </View>
                    {t.cleared === false ? <PendingPill /> : null}
                    <Text style={[styles.amt, { color: t.amount < 0 ? colors.text : colors.green }]}>
                      {t.amount < 0 ? fmtPos(Math.abs(t.amount)) : `+${fmtMoney(t.amount)}`}
                    </Text>
                  </Pressable>
                </Animated.View>
              ))}
            </Card>
          )}
          </>
          );
        }}
      />
    </PushScreen>
  );
}

function monthTitle(key: string) {
  const [y, m] = key.split('-').map(Number);
  return new Date(y, m - 1, 1).toLocaleDateString(undefined, { month: 'long', year: 'numeric' });
}

const styles = StyleSheet.create({
  hero: { alignItems: 'center', marginBottom: 12, marginTop: 4 },
  heroValue: { color: colors.text, fontSize: 38, fontWeight: '800', letterSpacing: -1.5 },
  heroSub: { color: colors.muted, fontSize: 13, marginTop: 4, textAlign: 'center' },
  rangeRow: { flexDirection: 'row', justifyContent: 'center', gap: 6, marginTop: 12 },
  range: { paddingVertical: 6, paddingHorizontal: 18, borderRadius: 8, backgroundColor: colors.surface2 },
  rangeActive: { backgroundColor: colors.accent },
  rangeText: { color: colors.muted, fontSize: 12, fontWeight: '700' },
  rangeTextActive: { color: '#fff' },
  monthHead: { flexDirection: 'row', alignItems: 'center', justifyContent: 'space-between', marginBottom: 8, paddingHorizontal: 2 },
  monthTitle: { color: colors.text, fontSize: 15, fontWeight: '700' },
  monthTotal: { color: colors.muted, fontSize: 14, fontWeight: '600' },
  list: { paddingVertical: 4 },
  row: { flexDirection: 'row', alignItems: 'center', gap: 12, paddingVertical: 11 },
  mid: { flex: 1, minWidth: 0 },
  rowTop: { flexDirection: 'row', alignItems: 'center', gap: 8 },
  sub: { color: colors.text, fontSize: 14, flexShrink: 1 },
  acct: { color: colors.muted, fontSize: 12, marginTop: 2 },
  amt: { fontSize: 15, fontWeight: '700' },
});
