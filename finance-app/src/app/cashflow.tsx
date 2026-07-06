import React from 'react';
import { Pressable, StyleSheet, Text, useWindowDimensions, View } from 'react-native';
import { useRouter } from 'expo-router';
import { SymbolView } from 'expo-symbols';
import { useTrends } from '@/api/hooks/finance.hooks';
import { PushScreen } from '@/components/screen';
import { Card, CardTitle, EmptyState, ErrorState, Loading, StatCard } from '@/components/ui';
import { GroupedBars } from '@/components/charts';
import { colors, fmtMoney, fmtPos, monthLabel } from '@/theme/colors';
import { haptics } from '@/lib/haptics';

export default function CashFlow() {
  const { width } = useWindowDimensions();
  const router = useRouter();
  const trends = useTrends(12);
  const months = trends.data?.months ?? [];
  const cur = months[months.length - 1];

  const labels = months.map((m) => m.month.slice(5));
  const income = months.map((m) => m.income);
  const spend = months.map((m) => m.spend);

  return (
    <PushScreen refreshing={trends.isFetching} onRefresh={trends.refetch}>
      {trends.isLoading ? (
        <Loading />
      ) : trends.isError && months.length === 0 ? (
        <ErrorState error={trends.error?.error} onRetry={trends.refetch} />
      ) : months.length === 0 ? (
        <EmptyState icon="chart.bar">No cash flow data</EmptyState>
      ) : (
        <>
          <View style={styles.statsRow}>
            <StatCard label="Money In" value={cur ? fmtPos(cur.income) : '—'} valueColor={colors.green} />
            <StatCard label="Money Out" value={cur ? fmtPos(cur.spend) : '—'} valueColor={colors.red} />
            <StatCard label="Net" value={cur ? fmtMoney(cur.net) : '—'} valueColor={cur && cur.net >= 0 ? colors.green : colors.red} />
          </View>

          <Pressable onPress={() => { haptics.tap(); router.push('/forecast' as never); }} style={({ pressed }) => [styles.forecastCard, pressed && { opacity: 0.65 }]}>
            <View style={[styles.forecastIcon, { backgroundColor: colors.accentLight + '22' }]}>
              <SymbolView name="chart.line.uptrend.xyaxis" tintColor={colors.accentLight} size={22} resizeMode="scaleAspectFit" />
            </View>
            <View style={{ flex: 1 }}>
              <Text style={styles.forecastTitle}>Forward forecast</Text>
              <Text style={styles.forecastSub}>Project cash for the next 30, 60, or 90 days</Text>
            </View>
            <Text style={styles.forecastValue}>Open ›</Text>
          </Pressable>

          {months.length > 1 ? (
            <Card style={{ marginTop: 12 }}>
              <CardTitle>Income vs Spending · 12 mo</CardTitle>
              <GroupedBars width={width - 64} labels={labels} seriesA={income} seriesB={spend} />
              <View style={styles.legend}>
                <View style={styles.legendItem}><View style={[styles.legendDot, { backgroundColor: colors.green }]} /><Text style={styles.legendText}>In</Text></View>
                <View style={styles.legendItem}><View style={[styles.legendDot, { backgroundColor: colors.red }]} /><Text style={styles.legendText}>Out</Text></View>
              </View>
            </Card>
          ) : null}

          <Card style={{ marginTop: 12 }}>
            <CardTitle>Monthly Net</CardTitle>
            {[...months].reverse().map((m) => (
              <View key={m.month} style={styles.row}>
                <Text style={styles.month}>{monthLabel(m.month)}</Text>
                <Text style={styles.rowIn}>+{fmtPos(m.income)}</Text>
                <Text style={styles.rowOut}>-{fmtPos(m.spend)}</Text>
                <Text style={[styles.rowNet, { color: m.net >= 0 ? colors.green : colors.red }]}>{fmtMoney(m.net)}</Text>
              </View>
            ))}
          </Card>
        </>
      )}
    </PushScreen>
  );
}

const styles = StyleSheet.create({
  statsRow: { flexDirection: 'row', gap: 10 },
  forecastCard: { marginTop: 12, flexDirection: 'row', alignItems: 'center', gap: 12, padding: 14, backgroundColor: colors.surface, borderColor: colors.border, borderWidth: 1, borderRadius: 14 },
  forecastIcon: { width: 40, height: 40, borderRadius: 20, alignItems: 'center', justifyContent: 'center' },
  forecastTitle: { color: colors.text, fontSize: 15, fontWeight: '800' },
  forecastSub: { color: colors.muted, fontSize: 12, marginTop: 2 },
  forecastValue: { color: colors.accentLight, fontSize: 13, fontWeight: '800' },
  legend: { flexDirection: 'row', gap: 16, marginTop: 8, justifyContent: 'center' },
  legendItem: { flexDirection: 'row', alignItems: 'center', gap: 6 },
  legendDot: { width: 8, height: 8, borderRadius: 4 },
  legendText: { color: colors.muted, fontSize: 11 },
  row: { flexDirection: 'row', alignItems: 'center', paddingVertical: 8, borderBottomWidth: StyleSheet.hairlineWidth, borderBottomColor: colors.border },
  month: { color: colors.text, fontSize: 13, flex: 1 },
  rowIn: { color: colors.green, fontSize: 12, width: 78, textAlign: 'right' },
  rowOut: { color: colors.red, fontSize: 12, width: 78, textAlign: 'right' },
  rowNet: { fontSize: 13, fontWeight: '700', width: 86, textAlign: 'right' },
});
