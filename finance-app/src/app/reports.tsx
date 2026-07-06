import React from 'react';
import { StyleSheet, Text, View } from 'react-native';
import { useReports } from '@/api/hooks/finance.hooks';
import { PushScreen } from '@/components/screen';
import { Card, CardTitle, EmptyState, ErrorState, Loading } from '@/components/ui';
import { colors, fmtMoney, fmtPos, fmtSignedMoney } from '@/theme/colors';

export default function ReportsScreen() {
  const reports = useReports();
  const data = reports.data;

  return (
    <PushScreen refreshing={reports.isFetching} onRefresh={reports.refetch}>
      {reports.isLoading && !data ? (
        <Loading />
      ) : reports.isError && !data ? (
        <ErrorState error={reports.error?.error} onRetry={reports.refetch} />
      ) : !data ? (
        <EmptyState icon="doc.text.magnifyingglass">No reports available</EmptyState>
      ) : (
        <>
          <View style={styles.hero}>
            <Text style={styles.heroLabel}>MONTHLY REVIEW · {data.month}</Text>
            <Text style={[styles.heroValue, { color: data.monthlyReview.net >= 0 ? colors.green : colors.red }]}>{fmtSignedMoney(data.monthlyReview.net)}</Text>
            <Text style={styles.heroSub}>{fmtPos(data.monthlyReview.income)} in · {fmtPos(data.monthlyReview.spend)} out · {data.monthlyReview.transactionCount} transactions</Text>
          </View>

          <Card style={{ marginBottom: 16 }}>
            <CardTitle>Saved Reports</CardTitle>
            {data.saved.map((r) => (
              <View key={r.id} style={styles.savedRow}>
                <Text style={styles.savedTitle}>{r.title}</Text>
                <Text style={styles.savedSub}>{r.subtitle}</Text>
              </View>
            ))}
          </Card>

          <Card style={{ marginBottom: 16 }}>
            <CardTitle>Category Breakdown</CardTitle>
            {data.categoryTrends.slice(0, 8).map((c) => (
              <View key={c.name} style={styles.row}>
                <Text style={styles.name}>{c.name}</Text>
                <Text style={styles.meta}>{c.pct.toFixed(0)}%</Text>
                <Text style={styles.amt}>{fmtMoney(c.spend)}</Text>
              </View>
            ))}
          </Card>

          <Card style={{ marginBottom: 16 }}>
            <CardTitle>Top Merchants</CardTitle>
            {data.merchantTrends.slice(0, 10).map((m) => (
              <View key={m.payee} style={styles.row}>
                <Text style={styles.name} numberOfLines={1}>{m.payee}</Text>
                <Text style={styles.meta}>{m.count}x</Text>
                <Text style={styles.amt}>{fmtMoney(m.spend)}</Text>
              </View>
            ))}
          </Card>

          <Card>
            <CardTitle>Needs Cleanup</CardTitle>
            <Text style={styles.cleanup}>{data.monthlyReview.uncategorized.length} uncategorized · {data.monthlyReview.largest.length} large charges reviewed in this report</Text>
          </Card>
        </>
      )}
    </PushScreen>
  );
}

const styles = StyleSheet.create({
  hero: { marginBottom: 16, marginTop: 4 },
  heroLabel: { color: colors.muted, fontSize: 11, fontWeight: '800', letterSpacing: 1 },
  heroValue: { fontSize: 40, fontWeight: '800', letterSpacing: -1.5, marginTop: 4 },
  heroSub: { color: colors.muted, fontSize: 13, marginTop: 4 },
  savedRow: { paddingVertical: 9, borderBottomWidth: StyleSheet.hairlineWidth, borderBottomColor: colors.border },
  savedTitle: { color: colors.text, fontSize: 14, fontWeight: '800' },
  savedSub: { color: colors.muted, fontSize: 12, marginTop: 2 },
  row: { flexDirection: 'row', alignItems: 'center', gap: 10, paddingVertical: 8, borderBottomWidth: StyleSheet.hairlineWidth, borderBottomColor: colors.border },
  name: { color: colors.text, fontSize: 13, flex: 1 },
  meta: { color: colors.muted, fontSize: 12, width: 42, textAlign: 'right' },
  amt: { color: colors.text, fontSize: 13, fontWeight: '800', width: 86, textAlign: 'right' },
  cleanup: { color: colors.muted, fontSize: 13, lineHeight: 18 },
});
