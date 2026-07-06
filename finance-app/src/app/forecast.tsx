import React, { useState } from 'react';
import { Pressable, StyleSheet, Text, useWindowDimensions, View } from 'react-native';
import { SymbolView } from 'expo-symbols';
import { useForecast } from '@/api/hooks/finance.hooks';
import { ForecastEvent } from '@/api/generated/types';
import { PushScreen } from '@/components/screen';
import { Card, CardTitle, EmptyState, ErrorState, Loading, StatCard } from '@/components/ui';
import { LineChart } from '@/components/charts';
import { haptics } from '@/lib/haptics';
import { colors, fmtDate, fmtMoney, fmtPos, fmtSignedMoney } from '@/theme/colors';

const WINDOWS = [30, 60, 90] as const;
const kindColor = (k: ForecastEvent['kind']) => k === 'income' || k === 'reimbursement' ? colors.green : k === 'bill' ? colors.red : colors.yellow;

export default function ForecastScreen() {
  const { width } = useWindowDimensions();
  const [days, setDays] = useState<(typeof WINDOWS)[number]>(90);
  const forecast = useForecast(days);
  const data = forecast.data;
  const values = data?.points.map((p) => p.balance) ?? [];
  const events = data?.events.slice(0, 20) ?? [];

  return (
    <PushScreen refreshing={forecast.isFetching} onRefresh={forecast.refetch}>
      {forecast.isLoading && !data ? (
        <Loading />
      ) : forecast.isError && !data ? (
        <ErrorState error={forecast.error?.error} onRetry={forecast.refetch} />
      ) : !data ? (
        <EmptyState icon="chart.line.uptrend.xyaxis">No forecast available</EmptyState>
      ) : (
        <>
          <View style={styles.rangeRow}>
            {WINDOWS.map((w) => (
              <Pressable key={w} onPress={() => { haptics.tap(); setDays(w); }} style={[styles.range, days === w && styles.rangeActive]}>
                <Text style={[styles.rangeText, days === w && styles.rangeTextActive]}>{w}D</Text>
              </Pressable>
            ))}
          </View>

          <View style={styles.statsRow}>
            <StatCard label="Ending" value={fmtMoney(data.endingBalance)} valueColor={data.endingBalance >= 0 ? colors.green : colors.red} />
            <StatCard label="Lowest" value={fmtMoney(data.lowest.balance)} valueColor={data.lowest.balance >= 0 ? colors.text : colors.red} sub={fmtDate(data.lowest.date)} />
            <StatCard label="Net" value={fmtSignedMoney(data.totals.inflow - data.totals.outflow)} valueColor={data.totals.inflow >= data.totals.outflow ? colors.green : colors.red} />
          </View>

          {data.warnings.length ? (
            <Card style={styles.warning}>
              <SymbolView name="exclamationmark.triangle.fill" tintColor={colors.red} size={20} resizeMode="scaleAspectFit" />
              <Text style={styles.warningText}>{data.warnings[0]}</Text>
            </Card>
          ) : null}

          <Card style={{ marginTop: 12 }}>
            <CardTitle>Projected Cash Balance</CardTitle>
            <LineChart width={width - 64} values={values} color={data.lowest.balance < 0 ? colors.red : colors.accentLight} />
            <Text style={styles.hint}>Starts at {fmtPos(data.startBalance)} cash and includes known income, bills, budgets, and expected reimbursements.</Text>
          </Card>

          <Card style={{ marginTop: 12 }}>
            <CardTitle>Upcoming Forecast Events</CardTitle>
            {events.length ? events.map((e, i) => (
              <View key={`${e.date}-${e.label}-${i}`} style={styles.row}>
                <View style={[styles.dot, { backgroundColor: kindColor(e.kind) }]} />
                <View style={{ flex: 1, minWidth: 0 }}>
                  <Text style={styles.eventName} numberOfLines={1}>{e.label}</Text>
                  <Text style={styles.eventMeta}>{fmtDate(e.date)} · {e.kind}</Text>
                </View>
                <Text style={[styles.eventAmt, { color: e.amount >= 0 ? colors.green : colors.red }]}>{fmtSignedMoney(e.amount)}</Text>
              </View>
            )) : <EmptyState icon="calendar">No upcoming events</EmptyState>}
          </Card>
        </>
      )}
    </PushScreen>
  );
}

const styles = StyleSheet.create({
  rangeRow: { flexDirection: 'row', gap: 8, marginBottom: 14 },
  range: { flex: 1, paddingVertical: 9, borderRadius: 10, alignItems: 'center', backgroundColor: colors.surface2 },
  rangeActive: { backgroundColor: colors.accent },
  rangeText: { color: colors.muted, fontSize: 12, fontWeight: '800' },
  rangeTextActive: { color: '#fff' },
  statsRow: { flexDirection: 'row', gap: 10 },
  warning: { marginTop: 12, flexDirection: 'row', alignItems: 'center', gap: 10, borderColor: colors.red + '55', borderWidth: 1 },
  warningText: { color: colors.red, fontSize: 13, fontWeight: '700', flex: 1 },
  hint: { color: colors.muted, fontSize: 12, lineHeight: 17, marginTop: 4 },
  row: { flexDirection: 'row', alignItems: 'center', gap: 10, paddingVertical: 9, borderBottomWidth: StyleSheet.hairlineWidth, borderBottomColor: colors.border },
  dot: { width: 9, height: 9, borderRadius: 5 },
  eventName: { color: colors.text, fontSize: 13, fontWeight: '700' },
  eventMeta: { color: colors.muted, fontSize: 11, marginTop: 2 },
  eventAmt: { fontSize: 13, fontWeight: '800' },
});
