import React from 'react';
import { StyleSheet, Text, View } from 'react-native';
import { useInvestments } from '@/api/hooks/finance.hooks';
import { PushScreen } from '@/components/screen';
import { QueryScreenBody } from '@/components/query-display';
import { Avatar, Card, CardTitle, EmptyState, Loading } from '@/components/ui';
import { heroMetricAccessibilityLabel } from '@/lib/metric-a11y.js';
import { colors, fmtDate, fmtMoney, fmtPos } from '@/theme/colors';

export default function DebtScreen() {
  const investments = useInvestments();
  const data = investments.data;

  const hasDebts = !!data && data.debts.length > 0;

  return (
    <PushScreen testID="debt-screen" onRefresh={investments.refetch}>
      <QueryScreenBody
        query={investments}
        loading={<Loading />}
        empty={<EmptyState icon="creditcard">No debt plan configured</EmptyState>}
        hasContent={hasDebts}
        refetchBannerTestID="debt-refetch-banner"
      >
          <View
            style={styles.hero}
            accessible
            accessibilityLabel={heroMetricAccessibilityLabel(
              'Debt payoff',
              fmtMoney(-data!.debtTotals.balance),
              `${fmtPos(data!.debtTotals.minPayment)} per month minimum · ${data!.debtTotals.weightedApr}% weighted APR`,
            )}
          >
            <Text style={styles.heroLabel} accessibilityElementsHidden importantForAccessibility="no">DEBT PAYOFF</Text>
            <Text style={styles.heroValue} accessibilityElementsHidden importantForAccessibility="no">{fmtMoney(-data!.debtTotals.balance)}</Text>
            <Text style={styles.heroSub} accessibilityElementsHidden importantForAccessibility="no">{fmtPos(data!.debtTotals.minPayment)}/mo minimum · {data!.debtTotals.weightedApr}% weighted APR</Text>
          </View>

          <Card style={{ marginBottom: 16 }}>
            <CardTitle>Recommended Order</CardTitle>
            <Text style={styles.note}>Avalanche order prioritizes the highest APR first; snowball debts still show their configured strategy.</Text>
          </Card>

          <Card>
            {data!.debts.map((d) => (
              <View key={d.id} testID={`debt-row-${d.id}`} style={styles.row}>
                <Avatar label={d.name} size={36} />
                <View style={{ flex: 1, minWidth: 0 }}>
                  <Text style={styles.name}>{d.name}</Text>
                  <Text style={styles.sub}>{d.apr}% APR · {fmtPos(d.minPayment)}/mo · {d.strategy}</Text>
                  <Text style={styles.sub}>{d.payoffDate ? `Payoff ${fmtDate(d.payoffDate)} · ${d.months} months · ${fmtPos(d.totalInterest ?? 0)} interest` : 'Payment too low to project payoff'}</Text>
                </View>
                <Text style={styles.amt}>{fmtPos(d.balance)}</Text>
              </View>
            ))}
          </Card>
      </QueryScreenBody>
    </PushScreen>
  );
}

const styles = StyleSheet.create({
  hero: { marginBottom: 16, marginTop: 4 },
  heroLabel: { color: colors.muted, fontSize: 11, fontWeight: '800', letterSpacing: 1 },
  heroValue: { color: colors.red, fontSize: 40, fontWeight: '800', letterSpacing: -1.5, marginTop: 4 },
  heroSub: { color: colors.muted, fontSize: 13, marginTop: 4 },
  note: { color: colors.muted, fontSize: 12, lineHeight: 17 },
  row: { flexDirection: 'row', alignItems: 'center', gap: 12, paddingVertical: 10, borderBottomWidth: StyleSheet.hairlineWidth, borderBottomColor: colors.border },
  name: { color: colors.text, fontSize: 15, fontWeight: '700' },
  sub: { color: colors.muted, fontSize: 12, marginTop: 2 },
  amt: { color: colors.red, fontSize: 15, fontWeight: '800' },
});
