import React, { useMemo } from 'react';
import { Pressable, StyleSheet, Text, View } from 'react-native';
import Animated, { FadeInDown } from 'react-native-reanimated';
import { Stack, useLocalSearchParams, useRouter } from 'expo-router';
import { useSearch } from '@/api/hooks/finance.hooks';
import { PushScreen } from '@/components/screen';
import { QueryScreenBody } from '@/components/query-display';
import { Avatar, Card, EmptyState, PendingPill } from '@/components/ui';
import { heroMetricAccessibilityLabel } from '@/lib/metric-a11y.js';
import { SkeletonList } from '@/components/skeleton';
import { colors, fmtDate, fmtMoney, fmtPos } from '@/theme/colors';

const escapeRe = (s: string) => s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');

export default function TagDetail() {
  const router = useRouter();
  const params = useLocalSearchParams<{ tag: string }>();
  const raw = params.tag ?? ''; // includes the leading '#'
  const display = raw.replace(/^#/, '');

  // The search endpoint substring-matches notes; refine to a whole-token match so
  // "#alex" doesn't also pull "#alex2" / "#ev-tr" doesn't pull "#ev-trip".
  const search = useSearch(raw);
  const rows = useMemo(() => {
    const re = new RegExp(`${escapeRe(raw)}(?![\\w-])`, 'i');
    return (search.data?.transactions ?? [])
      .filter((t) => re.test(t.notes || ''))
      .sort((a, b) => b.date.localeCompare(a.date));
  }, [search.data, raw]);

  const totals = useMemo(() => {
    const charges = rows.filter((transaction) => transaction.amount < 0).reduce((sum, transaction) => sum + Math.abs(transaction.amount), 0);
    const refunds = rows.filter((transaction) => transaction.amount > 0).reduce((sum, transaction) => sum + transaction.amount, 0);
    return { charges, refunds, netSpend: charges - refunds };
  }, [rows]);

  return (
    <PushScreen testID="tag-detail-screen" onRefresh={search.refetch}>
      <Stack.Screen options={{ title: `#${display}` }} />
      <QueryScreenBody
        query={search}
        loading={<SkeletonList hero rows={7} />}
        empty={null}
        hasContent={search.data != null}
        refetchBannerTestID="tag-refetch-banner"
      >
          <View
            style={styles.hero}
            accessible
            accessibilityLabel={heroMetricAccessibilityLabel(
              `Net spend for tag ${display}`,
              fmtMoney(totals.netSpend),
              `${fmtPos(totals.charges)} charges minus ${fmtPos(totals.refunds)} refunds · ${rows.length} transaction${rows.length === 1 ? '' : 's'}`,
            )}
          >
            <Text style={styles.heroLabel} accessibilityElementsHidden importantForAccessibility="no">NET SPEND · #{display.toUpperCase()}</Text>
            <Text style={styles.heroValue} accessibilityElementsHidden importantForAccessibility="no">{fmtMoney(totals.netSpend)}</Text>
            <Text style={styles.heroSub} accessibilityElementsHidden importantForAccessibility="no">
              {fmtPos(totals.charges)} charges − {fmtPos(totals.refunds)} refunds · {rows.length} transaction{rows.length === 1 ? '' : 's'}
              {search.data?.truncated ? ' · first 200 shown' : ''}
            </Text>
          </View>

          {rows.length === 0 ? (
            <EmptyState icon="number">Nothing tagged #{display} yet</EmptyState>
          ) : (
            <Card style={styles.list}>
              {rows.map((t, i) => (
                <Animated.View key={t.id} entering={FadeInDown.duration(180).delay(Math.min(i * 18, 180))}>
                  <Pressable
                    testID={`tag-transaction-${t.id}`}
                    style={({ pressed }) => [styles.row, pressed && { opacity: 0.6 }]}
                    onPress={() =>
                      router.push({
                        pathname: '/transaction/[id]',
                        params: { id: t.id, date: t.date, accountId: t.accountId },
                      })
                    }
                  >
                    <Avatar label={t.payee} category={t.category ?? undefined} size={36} />
                    <View style={styles.mid}>
                      <View style={styles.payeeLine}>
                        <Text style={[styles.payee, { flexShrink: 1 }]} numberOfLines={1}>{t.payee || '(no payee)'}</Text>
                        {t.cleared === false ? <PendingPill /> : null}
                      </View>
                      <Text style={styles.sub} numberOfLines={1}>{fmtDate(t.date)} · {t.account}</Text>
                    </View>
                    <Text style={[styles.amt, { color: t.amount < 0 ? colors.text : colors.green }]}>
                      {t.amount < 0 ? fmtPos(Math.abs(t.amount)) : `+${fmtPos(t.amount)}`}
                    </Text>
                  </Pressable>
                </Animated.View>
              ))}
            </Card>
          )}
      </QueryScreenBody>
    </PushScreen>
  );
}

const styles = StyleSheet.create({
  hero: { marginBottom: 12, marginTop: 4 },
  heroLabel: { color: colors.muted, fontSize: 11, fontWeight: '700', letterSpacing: 1 },
  heroValue: { color: colors.text, fontSize: 38, fontWeight: '800', letterSpacing: -1.5, marginTop: 4 },
  heroSub: { color: colors.muted, fontSize: 13, marginTop: 4 },
  list: { paddingVertical: 4 },
  row: { flexDirection: 'row', alignItems: 'center', gap: 12, paddingVertical: 10 },
  mid: { flex: 1, minWidth: 0 },
  payeeLine: { flexDirection: 'row', alignItems: 'center', gap: 6 },
  payee: { color: colors.text, fontSize: 15, fontWeight: '600' },
  sub: { color: colors.muted, fontSize: 12, marginTop: 2 },
  amt: { fontSize: 15, fontWeight: '700' },
});
