import React from 'react';
import { StyleSheet, Text, View } from 'react-native';
import { useInvestments } from '@/api/hooks/finance.hooks';
import { PushScreen } from '@/components/screen';
import { QueryScreenBody } from '@/components/query-display';
import { Avatar, Card, CardTitle, EmptyState, Loading } from '@/components/ui';
import { heroMetricAccessibilityLabel } from '@/lib/metric-a11y.js';
import { formatOptionalPos, isKnownMoney } from '@/lib/money-display.js';
import { colors, fmtDate, fmtMoney, fmtPos } from '@/theme/colors';

export default function DebtScreen() {
  const investments = useInvestments();

  return (
    <PushScreen testID="debt-screen" onRefresh={investments.refetch}>
      <QueryScreenBody
        query={investments}
        loading={<Loading />}
        empty={<EmptyState icon="creditcard">No debt plan configured</EmptyState>}
        hasContent={Boolean(investments.data?.debts?.length)}
        refetchBannerTestID="debt-refetch-banner"
        renderContent={(data) => {
          const balance = data.debtTotals?.balance;
          const minPayment = data.debtTotals?.minPayment;
          const weightedApr = data.debtTotals?.weightedApr;
          const heroBalance = isKnownMoney(balance) ? fmtMoney(-balance) : 'Unavailable';
          const heroMin = formatOptionalPos(minPayment, fmtPos);
          const heroApr = isKnownMoney(weightedApr) ? `${weightedApr}%` : 'Unavailable';
          return (
          <>
          <View
            style={styles.hero}
            accessible
            accessibilityLabel={heroMetricAccessibilityLabel(
              'Debt payoff',
              heroBalance,
              `${heroMin} per month minimum · ${heroApr} weighted APR`,
            )}
          >
            <Text style={styles.heroLabel} accessibilityElementsHidden importantForAccessibility="no">DEBT PAYOFF</Text>
            <Text style={styles.heroValue} accessibilityElementsHidden importantForAccessibility="no">{heroBalance}</Text>
            <Text style={styles.heroSub} accessibilityElementsHidden importantForAccessibility="no">{heroMin}/mo minimum · {heroApr} weighted APR</Text>
          </View>

          <Card style={{ marginBottom: 16 }}>
            <CardTitle>Recommended Order</CardTitle>
            <Text style={styles.note}>Avalanche order prioritizes the highest APR first; snowball debts still show their configured strategy.</Text>
          </Card>

          <Card>
            {(data.debts ?? []).map((d) => (
              <View key={d.id} testID={`debt-row-${d.id}`} style={styles.row}>
                <Avatar label={d.name} size={36} />
                <View style={{ flex: 1, minWidth: 0 }}>
                  <Text style={styles.name}>{d.name}</Text>
                  <Text style={styles.sub}>{isKnownMoney(d.apr) ? `${d.apr}% APR` : 'APR unavailable'} · {formatOptionalPos(d.minPayment, fmtPos)}/mo · {d.strategy}</Text>
                  <Text style={styles.sub}>{d.payoffDate ? `Payoff ${fmtDate(d.payoffDate)} · ${d.months} months · ${formatOptionalPos(d.totalInterest, fmtPos)} interest` : 'Payment too low to project payoff'}</Text>
                </View>
                <Text style={styles.amt}>{formatOptionalPos(d.balance, fmtPos)}</Text>
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
  heroValue: { color: colors.red, fontSize: 40, fontWeight: '800', letterSpacing: -1.5, marginTop: 4 },
  heroSub: { color: colors.muted, fontSize: 13, marginTop: 4 },
  note: { color: colors.muted, fontSize: 12, lineHeight: 17 },
  row: { flexDirection: 'row', alignItems: 'center', gap: 12, paddingVertical: 10, borderBottomWidth: StyleSheet.hairlineWidth, borderBottomColor: colors.border },
  name: { color: colors.text, fontSize: 15, fontWeight: '700' },
  sub: { color: colors.muted, fontSize: 12, marginTop: 2 },
  amt: { color: colors.red, fontSize: 15, fontWeight: '800' },
});
