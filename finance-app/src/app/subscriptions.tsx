import React, { useMemo } from 'react';
import { Pressable, StyleSheet, Text, View } from 'react-native';
import { useRouter } from 'expo-router';
import { useRecurring } from '@/api/hooks/finance.hooks';
import { RecurringItem } from '@/api/generated/types';
import { PushScreen } from '@/components/screen';
import { Avatar, Card, EmptyState, ErrorState, SectionLabel } from '@/components/ui';
import { SkeletonList } from '@/components/skeleton';
import { cadenceLabel, colors, dueLabel, fmtMoney, fmtPos } from '@/theme/colors';

// Subscriptions = discretionary recurring charges (streaming, software, gym,
// cloud). True must-pay bills (rent/utilities/phone/loan) live in the Bills
// calendar instead, so the two views don't overlap.
export default function Subscriptions() {
  const router = useRouter();
  const recurring = useRecurring();
  const data = recurring.data;

  const { active, inactive, monthly, annual } = useMemo(() => {
    const subs = (data?.items ?? []).filter((i) => !i.isBill);
    const act = subs.filter((i) => i.status === 'active');
    const monthlyTotal = data?.subMonthlyTotal ?? act.reduce((s, i) => s + i.monthlyEquivalent, 0);
    return {
      active: act,
      inactive: subs.filter((i) => i.status !== 'active'),
      monthly: monthlyTotal,
      annual: monthlyTotal * 12,
    };
  }, [data]);

  const Row = ({ item }: { item: RecurringItem }) => {
    const dim = item.status !== 'active';
    return (
      <Pressable style={({ pressed }) => [styles.row, pressed && { opacity: 0.6 }]} onPress={() => router.push(`/recurring/${encodeURIComponent(item.key)}`)}>
        <Avatar label={item.payee} category={item.category ?? undefined} size={38} />
        <View style={styles.mid}>
          <Text style={[styles.payee, dim && styles.dim]} numberOfLines={1}>{item.payee}</Text>
          <Text style={styles.sub} numberOfLines={1}>
            {cadenceLabel(item.cadence)}
            {item.status === 'active' ? ` · ${dueLabel(item.nextRenewal)}` : item.status === 'cancelled' ? ' · cancelled' : ' · inactive'}
            {item.confidence ? ` · ${item.confidence}% confidence` : ''}
            {item.cancellation?.watchNextRenewal ? ' · watching renewal' : ''}
          </Text>
        </View>
        <View style={styles.rightCol}>
          <Text style={[styles.amt, dim && styles.dim]}>{fmtPos(item.amount)}</Text>
          {item.priceChange ? (
            <Text style={[styles.hike, { color: item.priceChange.pct > 0 ? colors.red : colors.green }]}>
              {item.priceChange.pct > 0 ? '▲' : '▼'} {Math.abs(item.priceChange.pct)}%
            </Text>
          ) : null}
        </View>
      </Pressable>
    );
  };

  return (
    <PushScreen refreshing={recurring.isFetching} onRefresh={recurring.refetch}>
      {recurring.isLoading && !data ? (
        <SkeletonList hero rows={6} />
      ) : recurring.isError && !data ? (
        <ErrorState error={recurring.error?.error} onRetry={recurring.refetch} />
      ) : !active.length && !inactive.length ? (
        <EmptyState icon="repeat">No subscriptions detected yet</EmptyState>
      ) : (
        <>
          <View style={styles.hero}>
            <Text style={styles.heroLabel}>MONTHLY SUBSCRIPTIONS</Text>
            <Text style={styles.heroValue}>{fmtMoney(monthly)}</Text>
            <Text style={styles.heroSub}>
              {active.length} active · {fmtPos(annual)}/yr
            </Text>
          </View>

          {active.length ? (
            <>
              <SectionLabel>Active</SectionLabel>
              <Card style={styles.list}>
                {active.map((item) => (
                  <Row key={item.key} item={item} />
                ))}
              </Card>
            </>
          ) : null}

          {inactive.length ? (
            <View style={{ marginTop: 16 }}>
              <SectionLabel>Inactive & Cancelled</SectionLabel>
              <Card style={styles.list}>
                {inactive.map((item) => (
                  <Row key={item.key} item={item} />
                ))}
              </Card>
            </View>
          ) : null}

          <Pressable style={({ pressed }) => [styles.note, pressed && { opacity: 0.6 }]} onPress={() => router.push('/bills' as never)}>
            <Text style={styles.noteText}>
              Recurring memberships & apps only. Utilities, rent & internet are tracked as Bills ›
            </Text>
          </Pressable>
        </>
      )}
    </PushScreen>
  );
}

const styles = StyleSheet.create({
  hero: { marginBottom: 16, marginTop: 4 },
  heroLabel: { color: colors.muted, fontSize: 11, fontWeight: '700', letterSpacing: 1 },
  heroValue: { color: colors.text, fontSize: 40, fontWeight: '800', letterSpacing: -1.5, marginTop: 4 },
  heroSub: { color: colors.muted, fontSize: 13, marginTop: 4 },
  list: { paddingVertical: 4 },
  row: { flexDirection: 'row', alignItems: 'center', gap: 12, paddingVertical: 10 },
  iconCircle: { width: 38, height: 38, borderRadius: 19, backgroundColor: colors.surface2, alignItems: 'center', justifyContent: 'center' },
  iconText: { color: colors.accentLight, fontSize: 16, fontWeight: '700' },
  mid: { flex: 1, minWidth: 0 },
  payee: { color: colors.text, fontSize: 15, fontWeight: '600' },
  sub: { color: colors.muted, fontSize: 12, marginTop: 2 },
  dim: { color: colors.muted },
  rightCol: { alignItems: 'flex-end' },
  amt: { color: colors.text, fontSize: 15, fontWeight: '700' },
  hike: { fontSize: 11, fontWeight: '700', marginTop: 2 },
  note: { marginTop: 18, paddingHorizontal: 4 },
  noteText: { color: colors.muted, fontSize: 12, lineHeight: 17 },
});
