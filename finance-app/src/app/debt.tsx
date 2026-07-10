import React from 'react';
import { StyleSheet, Text, View } from 'react-native';
import { useInvestments } from '@/api/hooks/finance.hooks';
import { PushScreen } from '@/components/screen';
import { Avatar, Card, CardTitle, EmptyState, ErrorState, Loading } from '@/components/ui';
import { colors, fmtDate, fmtMoney, fmtPos } from '@/theme/colors';

export default function DebtScreen() {
  const investments = useInvestments();
  const data = investments.data;

  return (
    <PushScreen testID="debt-screen" refreshing={investments.isFetching} onRefresh={investments.refetch}>
      {investments.isLoading && !data ? (
        <Loading />
      ) : investments.isError && !data ? (
        <ErrorState error={investments.error?.error} onRetry={investments.refetch} />
      ) : !data || data.debts.length === 0 ? (
        <EmptyState icon="creditcard">No debt plan configured</EmptyState>
      ) : (
        <>
          <View style={styles.hero}>
            <Text style={styles.heroLabel}>DEBT PAYOFF</Text>
            <Text style={styles.heroValue}>{fmtMoney(-data.debtTotals.balance)}</Text>
            <Text style={styles.heroSub}>{fmtPos(data.debtTotals.minPayment)}/mo minimum · {data.debtTotals.weightedApr}% weighted APR</Text>
          </View>

          <Card style={{ marginBottom: 16 }}>
            <CardTitle>Recommended Order</CardTitle>
            <Text style={styles.note}>Avalanche order prioritizes the highest APR first; snowball debts still show their configured strategy.</Text>
          </Card>

          <Card>
            {data.debts.map((d) => (
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
        </>
      )}
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
