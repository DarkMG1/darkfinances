import React, { useState } from 'react';
import { Pressable, StyleSheet, Text, useWindowDimensions, View } from 'react-native';
import { SymbolView } from 'expo-symbols';
import { useForecast } from '@/api/hooks/finance.hooks';
import { ForecastEvent } from '@/api/generated/types';
import { PushScreen } from '@/components/screen';
import { QueryScreenBody } from '@/components/query-display';
import { Card, CardTitle, EmptyState, Loading, StatCard } from '@/components/ui';
import { LineChart } from '@/components/charts';
import { haptics } from '@/lib/haptics';
import { colors, fmtDate, fmtMoney, fmtPos, fmtSignedMoney } from '@/theme/colors';

const WINDOWS = [30, 60, 90] as const;
const kindColor = (k: ForecastEvent['kind']) => k === 'income' || k === 'reimbursement' ? colors.green : k === 'bill' ? colors.red : colors.yellow;

function projectionIncomplete(data: NonNullable<ReturnType<typeof useForecast>['data']>) {
  return data.assumptions?.projectionContainment?.complete === false;
}

function endingBalanceDisplay(data: NonNullable<ReturnType<typeof useForecast>['data']>) {
  if (data.endingBalance == null || !Number.isFinite(data.endingBalance)) {
    return { label: 'Ending', value: 'Unavailable', valueColor: colors.muted, sub: undefined as string | undefined };
  }
  if (projectionIncomplete(data)) {
    return {
      label: 'Ending',
      value: fmtMoney(data.endingBalance),
      valueColor: data.endingBalance >= 0 ? colors.green : colors.red,
      sub: 'Partial projection',
    };
  }
  return {
    label: 'Ending',
    value: fmtMoney(data.endingBalance),
    valueColor: data.endingBalance >= 0 ? colors.green : colors.red,
    sub: undefined as string | undefined,
  };
}

export default function ForecastScreen() {
  const { width } = useWindowDimensions();
  const [days, setDays] = useState<(typeof WINDOWS)[number]>(90);
  const forecast = useForecast(days);
  const data = forecast.data;
  const values = data?.points.map((p) => p.balance) ?? [];
  const events = data?.events.slice(0, 20) ?? [];
  const ending = data ? endingBalanceDisplay(data) : null;

  return (
    <PushScreen testID="forecast-screen" onRefresh={forecast.refetch}>
      <QueryScreenBody
        query={forecast}
        loading={<Loading />}
        empty={<EmptyState icon="chart.line.uptrend.xyaxis">No forecast available</EmptyState>}
        hasContent={!!data}
        refetchBannerTestID="forecast-refetch-banner"
      >
        {data ? (() => {
          const forecastData = data;
          return (
          <>
          <View style={styles.rangeRow}>
            {WINDOWS.map((w) => (
              <Pressable testID={`forecast-range-${w}${days === w ? '-selected' : ''}`} key={w} onPress={() => { haptics.tap(); setDays(w); }} style={[styles.range, days === w && styles.rangeActive]}>
                <Text style={[styles.rangeText, days === w && styles.rangeTextActive]}>{w}D</Text>
              </Pressable>
            ))}
          </View>

          <View style={styles.statsRow}>
            <StatCard
              testID="forecast-ending"
              label={ending?.label ?? 'Ending'}
              value={ending?.value ?? 'Unavailable'}
              valueColor={ending?.valueColor ?? colors.muted}
              sub={ending?.sub}
              subColor={colors.yellow}
            />
            <StatCard testID="forecast-lowest" label="Lowest" value={fmtMoney(forecastData.lowest.balance)} valueColor={forecastData.lowest.balance >= 0 ? colors.text : colors.red} sub={fmtDate(forecastData.lowest.date)} />
            <StatCard testID="forecast-net" label="Net" value={fmtSignedMoney(forecastData.totals.inflow - forecastData.totals.outflow)} valueColor={forecastData.totals.inflow >= forecastData.totals.outflow ? colors.green : colors.red} />
          </View>

          {forecastData.warnings.length ? (
            <Card testID="forecast-warnings" style={styles.warning}>
              <SymbolView name="exclamationmark.triangle.fill" tintColor={colors.red} size={20} resizeMode="scaleAspectFit" />
              <View style={styles.warningList}>
                {forecastData.warnings.map((warning, index) => (
                  <Text key={`${index}-${warning}`} style={styles.warningText}>{warning}</Text>
                ))}
              </View>
            </Card>
          ) : null}

          <Card style={{ marginTop: 12 }}>
            <CardTitle>Illustrative Cash Plan</CardTitle>
            <LineChart width={width - 64} values={values} color={forecastData.lowest.balance < 0 ? colors.red : colors.accentLight} />
            <Text style={styles.hint}>Starts at {fmtPos(forecastData.startBalance)} estimated cash and models inferred income, inferred bills, and planned budget spending. It is not a prediction.</Text>
            {projectionIncomplete(forecastData) ? (
              <Text style={styles.hint}>Projection containment is incomplete; balances may omit budget, goal, or scheduled cash commitments.</Text>
            ) : null}
            {forecastData.possibleReimbursement ? (
              <Text style={styles.hint}>A possible {fmtPos(forecastData.possibleReimbursement.amount)} reimbursement is excluded from every balance shown.</Text>
            ) : null}
          </Card>

          <Card style={{ marginTop: 12 }}>
            <CardTitle>Illustrative Plan Inputs</CardTitle>
            {events.length ? events.map((e, i) => (
              <View key={`${e.date}-${e.label}-${i}`} testID={`forecast-event-${i}`} style={styles.row}>
                <View style={[styles.dot, { backgroundColor: kindColor(e.kind) }]} />
                <View style={{ flex: 1, minWidth: 0 }}>
                  <Text style={styles.eventName} numberOfLines={1}>{e.label}</Text>
                  <Text style={styles.eventMeta}>{fmtDate(e.date)} · {e.provenance} {e.kind}</Text>
                </View>
                <Text style={[styles.eventAmt, { color: e.amount >= 0 ? colors.green : colors.red }]}>{fmtSignedMoney(e.amount)}</Text>
              </View>
            )) : <EmptyState icon="calendar">No upcoming events</EmptyState>}
          </Card>
          </>
          );
        })() : null}
      </QueryScreenBody>
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
  warning: { marginTop: 12, flexDirection: 'row', alignItems: 'flex-start', gap: 10, borderColor: colors.red + '55', borderWidth: 1 },
  warningList: { flex: 1, gap: 6 },
  warningText: { color: colors.red, fontSize: 13, fontWeight: '700' },
  hint: { color: colors.muted, fontSize: 12, lineHeight: 17, marginTop: 4 },
  row: { flexDirection: 'row', alignItems: 'center', gap: 10, paddingVertical: 9, borderBottomWidth: StyleSheet.hairlineWidth, borderBottomColor: colors.border },
  dot: { width: 9, height: 9, borderRadius: 5 },
  eventName: { color: colors.text, fontSize: 13, fontWeight: '700' },
  eventMeta: { color: colors.muted, fontSize: 11, marginTop: 2 },
  eventAmt: { fontSize: 13, fontWeight: '800' },
});
