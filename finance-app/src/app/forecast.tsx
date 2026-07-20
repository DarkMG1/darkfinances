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
import { completeMoneySeries, formatOptionalMoney, formatOptionalPos, formatOptionalSignedMoney, isKnownMoney } from '@/lib/money-display.js';
import { colors, fmtDate, fmtMoney, fmtPos, fmtSignedMoney } from '@/theme/colors';

const WINDOWS = [30, 60, 90] as const;
const kindColor = (k: ForecastEvent['kind']) => k === 'income' || k === 'reimbursement' ? colors.green : k === 'bill' ? colors.red : colors.yellow;

function projectionIncomplete(data: NonNullable<ReturnType<typeof useForecast>['data']>) {
  return data.assumptions?.projectionContainment?.complete === false;
}

function endingBalanceDisplay(data: NonNullable<ReturnType<typeof useForecast>['data']>) {
  if (!isKnownMoney(data.endingBalance)) {
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

  return (
    <PushScreen testID="forecast-screen" onRefresh={forecast.refetch}>
      <QueryScreenBody
        query={forecast}
        loading={<Loading />}
        empty={<EmptyState icon="chart.line.uptrend.xyaxis">No forecast available</EmptyState>}
        hasContent={Boolean(forecast.data)}
        refetchBannerTestID="forecast-refetch-banner"
        renderContent={(data) => {
          const pointBalances = data.points?.map((p) => p.balance) ?? [];
          const values = completeMoneySeries(pointBalances);
          const chartUnavailable = pointBalances.length > 0 && values.length === 0;
          const events = data.events?.slice(0, 20) ?? [];
          const warnings = data.warnings ?? [];
          const ending = endingBalanceDisplay(data);
          const lowestBalance = data.lowest?.balance;
          const lowestDate = data.lowest?.date;
          const inflow = data.totals?.inflow;
          const outflow = data.totals?.outflow;
          const netKnown = isKnownMoney(inflow) && isKnownMoney(outflow);
          const lineColor = isKnownMoney(lowestBalance) && lowestBalance < 0 ? colors.red : colors.accentLight;
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
              label={ending.label}
              value={ending.value}
              valueColor={ending.valueColor}
              sub={ending.sub}
              subColor={colors.yellow}
            />
            <StatCard
              testID="forecast-lowest"
              label="Lowest"
              value={formatOptionalMoney(lowestBalance, fmtMoney)}
              valueColor={isKnownMoney(lowestBalance) ? (lowestBalance >= 0 ? colors.text : colors.red) : colors.muted}
              sub={lowestDate ? fmtDate(lowestDate) : undefined}
            />
            <StatCard
              testID="forecast-net"
              label="Net"
              value={netKnown ? fmtSignedMoney(inflow - outflow) : 'Unavailable'}
              valueColor={netKnown ? (inflow - outflow >= 0 ? colors.green : colors.red) : colors.muted}
            />
          </View>

          {warnings.length ? (
            <Card testID="forecast-warnings" style={styles.warning}>
              <SymbolView name="exclamationmark.triangle.fill" tintColor={colors.red} size={20} resizeMode="scaleAspectFit" />
              <View style={styles.warningList}>
                {warnings.map((warning, index) => (
                  <Text key={`${index}-${warning}`} style={styles.warningText}>{warning}</Text>
                ))}
              </View>
            </Card>
          ) : null}

          <Card style={{ marginTop: 12 }}>
            <CardTitle>Illustrative Cash Plan</CardTitle>
            <LineChart width={width - 64} values={values} color={lineColor} />
            {chartUnavailable ? <Text style={styles.hint}>Forecast trend unavailable because one or more projected balances are missing.</Text> : null}
            <Text style={styles.hint}>Starts at {formatOptionalPos(data.startBalance, fmtPos)} estimated cash and models inferred income, inferred bills, and planned budget spending. It is not a prediction.</Text>
            {projectionIncomplete(data) ? (
              <Text style={styles.hint}>Projection containment is incomplete; balances may omit budget, goal, or scheduled cash commitments.</Text>
            ) : null}
            {data.possibleReimbursement && isKnownMoney(data.possibleReimbursement.amount) ? (
              <Text style={styles.hint}>A possible {fmtPos(data.possibleReimbursement.amount)} reimbursement is excluded from every balance shown.</Text>
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
                <Text style={[styles.eventAmt, { color: isKnownMoney(e.amount) ? (e.amount >= 0 ? colors.green : colors.red) : colors.muted }]}>{formatOptionalSignedMoney(e.amount, fmtSignedMoney)}</Text>
              </View>
            )) : <EmptyState icon="calendar">No upcoming events</EmptyState>}
          </Card>
          </>
          );
        }}
      />
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
