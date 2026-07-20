import React from 'react';
import { StyleSheet, Text, View } from 'react-native';
import { useInvestments } from '@/api/hooks/finance.hooks';
import { PushScreen } from '@/components/screen';
import { QueryScreenBody } from '@/components/query-display';
import { Avatar, Card, CardTitle, EmptyState, Loading } from '@/components/ui';
import { heroMetricAccessibilityLabel } from '@/lib/metric-a11y.js';
import { formatOptionalMoney, formatOptionalSignedMoney, isKnownMoney } from '@/lib/money-display.js';
import { colors, fmtMoney, fmtPos, fmtSignedMoney } from '@/theme/colors';

export default function InvestmentsScreen() {
  const investments = useInvestments();

  return (
    <PushScreen testID="investments-screen" onRefresh={investments.refetch}>
      <QueryScreenBody
        query={investments}
        loading={<Loading />}
        empty={<EmptyState icon="chart.pie">No investment holdings configured</EmptyState>}
        hasContent={Boolean(investments.data?.holdings?.length)}
        refetchBannerTestID="investments-refetch-banner"
        renderContent={(data) => {
          const allocation = Object.entries(data.allocation?.byAssetClass ?? {}).sort((a, b) => b[1] - a[1]);
          const totalValue = data.totals?.value;
          const gainLoss = data.totals?.gainLoss;
          const heroValue = formatOptionalMoney(totalValue, fmtMoney);
          const heroGain = formatOptionalSignedMoney(gainLoss, fmtSignedMoney);
          const gainColor = isKnownMoney(gainLoss) && gainLoss >= 0 ? colors.green : colors.red;
          return (
          <>
          <View
            style={styles.hero}
            accessible
            accessibilityLabel={heroMetricAccessibilityLabel(
              'Investments',
              heroValue,
              isKnownMoney(gainLoss) ? `${heroGain} tracked gain or loss` : 'Tracked gain or loss unavailable',
            )}
          >
            <Text style={styles.heroLabel} accessibilityElementsHidden importantForAccessibility="no">INVESTMENTS</Text>
            <Text style={styles.heroValue} accessibilityElementsHidden importantForAccessibility="no">{heroValue}</Text>
            <Text style={[styles.heroSub, { color: isKnownMoney(gainLoss) ? gainColor : colors.muted }]} accessibilityElementsHidden importantForAccessibility="no">{isKnownMoney(gainLoss) ? `${heroGain} tracked gain/loss` : 'Tracked gain/loss unavailable'}</Text>
          </View>

          <Card style={{ marginBottom: 16 }}>
            <CardTitle>Allocation</CardTitle>
            {allocation.map(([name, value]) => {
              const pct = isKnownMoney(totalValue) && totalValue > 0 ? (value / totalValue) * 100 : 0;
              return (
                <View key={name} testID={`investments-allocation-${name.toLowerCase().replace(/[^a-z0-9]+/g, '-')}`} style={styles.allocRow}>
                  <Text style={styles.allocName}>{name}</Text>
                  <View style={styles.allocTrack}><View style={[styles.allocFill, { width: `${Math.min(100, pct)}%` }]} /></View>
                  <Text style={styles.allocValue}>{pct.toFixed(0)}%</Text>
                </View>
              );
            })}
          </Card>

          <Card>
            <CardTitle>Holdings</CardTitle>
            {(data.holdings ?? []).map((h) => (
              <View key={`${h.account}-${h.symbol}-${h.name}`} testID={`investments-holding-${h.symbol || h.name}`} style={styles.row}>
                <Avatar label={h.symbol || h.name} size={36} />
                <View style={{ flex: 1, minWidth: 0 }}>
                  <Text style={styles.name} numberOfLines={1}>{h.symbol || h.name}</Text>
                  <Text style={styles.sub} numberOfLines={1}>{h.account} · {h.assetClass} · {h.quantity.toLocaleString()} shares</Text>
                </View>
                <View style={{ alignItems: 'flex-end' }}>
                  <Text style={styles.amt}>{fmtPos(h.value)}</Text>
                  {h.gainLoss != null ? <Text style={[styles.gain, { color: h.gainLoss >= 0 ? colors.green : colors.red }]}>{fmtSignedMoney(h.gainLoss)}</Text> : null}
                </View>
              </View>
            ))}
          </Card>
          </>
          );
        }}
      />
    </PushScreen>
  );
}

const styles = StyleSheet.create({
  hero: { marginBottom: 16, marginTop: 4 },
  heroLabel: { color: colors.muted, fontSize: 11, fontWeight: '800', letterSpacing: 1 },
  heroValue: { color: colors.text, fontSize: 40, fontWeight: '800', letterSpacing: -1.5, marginTop: 4 },
  heroSub: { fontSize: 13, fontWeight: '700', marginTop: 4 },
  allocRow: { flexDirection: 'row', alignItems: 'center', gap: 10, paddingVertical: 8 },
  allocName: { color: colors.text, fontSize: 13, width: 120 },
  allocTrack: { flex: 1, height: 8, backgroundColor: colors.surface2, borderRadius: 4, overflow: 'hidden' },
  allocFill: { height: 8, backgroundColor: colors.accentLight },
  allocValue: { color: colors.muted, fontSize: 12, width: 40, textAlign: 'right' },
  row: { flexDirection: 'row', alignItems: 'center', gap: 12, paddingVertical: 10 },
  name: { color: colors.text, fontSize: 15, fontWeight: '700' },
  sub: { color: colors.muted, fontSize: 12, marginTop: 2 },
  amt: { color: colors.text, fontSize: 15, fontWeight: '800' },
  gain: { fontSize: 11, fontWeight: '700', marginTop: 2 },
});
