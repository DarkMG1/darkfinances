import React, { useMemo } from 'react';
import { Pressable, StyleSheet, Text, View } from 'react-native';
import { useRouter } from 'expo-router';
import { useRecurring, useSetRecurringOverride } from '@/api/hooks/finance.hooks';
import { RecurringItem } from '@/api/generated/types';
import { PushScreen } from '@/components/screen';
import { QueryScreenBody } from '@/components/query-display';
import { MutationFormBanner, MutationLiveRegion } from '@/components/mutation-form';
import { Avatar, Card, EmptyState, SectionLabel } from '@/components/ui';
import { heroMetricAccessibilityLabel } from '@/lib/metric-a11y.js';
import { useMutationAction } from '@/hooks/useMutationAction';
import { SkeletonList } from '@/components/skeleton';
import { useFinanceToday } from '@/lib/date-only';
import { cadenceLabel, colors, dueLabel, fmtMoney, fmtPos } from '@/theme/colors';

const sid = (s: string) => s.replace(/[^a-z0-9]+/gi, '-').replace(/^-|-$/g, '').toLowerCase();

// Subscriptions = discretionary recurring charges (streaming, software, gym,
// cloud). True must-pay bills (rent/utilities/phone/loan) live in the Bills
// calendar instead, so the two views don't overlap.
export default function Subscriptions() {
  const financeToday = useFinanceToday();
  const router = useRouter();
  const recurring = useRecurring();
  const override = useSetRecurringOverride();
  const restoreAction = useMutationAction({
    mutation: override,
    mutationLabel: 'Restore subscription',
    onRefetch: () => recurring.refetch(),
  });
  const data = recurring.data;

  const { active, inactive, hidden, monthly, annual } = useMemo(() => {
    const subs = (data?.items ?? []).filter((i) => !i.isBill);
    const act = subs.filter((i) => i.status === 'active');
    const monthlyTotal = data?.subMonthlyTotal ?? act.reduce((s, i) => s + i.monthlyEquivalent, 0);
    return {
      active: act,
      inactive: subs.filter((i) => i.status !== 'active'),
      hidden: data?.hiddenItems ?? [],
      monthly: monthlyTotal,
      annual: monthlyTotal * 12,
    };
  }, [data]);

  const Row = ({ item }: { item: RecurringItem }) => {
    const dim = item.status !== 'active';
    return (
      <Pressable testID={`subscriptions-row-${sid(item.key)}`} style={({ pressed }) => [styles.row, pressed && { opacity: 0.6 }]} onPress={() => router.push(`/recurring/${encodeURIComponent(item.key)}`)}>
        <Avatar label={item.payee} category={item.category ?? undefined} size={38} />
        <View style={styles.mid}>
          <Text style={[styles.payee, dim && styles.dim]} numberOfLines={1}>{item.payee}</Text>
          <Text style={styles.sub} numberOfLines={1}>
            {cadenceLabel(item.cadence)}
            {item.status === 'active' ? ` · ${dueLabel(item.nextRenewal, financeToday)}` : item.status === 'cancelled' ? ' · cancelled' : ' · inactive'}
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
    <PushScreen testID="subscriptions-screen" onRefresh={recurring.refetch}>
      <MutationLiveRegion message={restoreAction.announce} />
      <MutationFormBanner outcome={restoreAction.outcome} onRetry={restoreAction.retry} onRefetch={() => recurring.refetch()} />
      <QueryScreenBody
        query={recurring}
        loading={<SkeletonList hero rows={6} />}
        empty={<EmptyState icon="repeat">No subscriptions detected yet</EmptyState>}
        hasContent={!!(active.length || inactive.length || hidden.length)}
        refetchBannerTestID="subscriptions-refetch-banner"
        renderContent={() => (
          <>
          <View
            style={styles.hero}
            accessible
            accessibilityLabel={heroMetricAccessibilityLabel(
              'Monthly subscriptions',
              fmtMoney(monthly),
              `${active.length} active · ${fmtPos(annual)} per year`,
            )}
          >
            <Text style={styles.heroLabel} accessibilityElementsHidden importantForAccessibility="no">MONTHLY SUBSCRIPTIONS</Text>
            <Text style={styles.heroValue} accessibilityElementsHidden importantForAccessibility="no">{fmtMoney(monthly)}</Text>
            <Text style={styles.heroSub} accessibilityElementsHidden importantForAccessibility="no">
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

          {hidden.length ? (
            <View style={{ marginTop: 16 }}>
              <SectionLabel>Hidden</SectionLabel>
              <Card style={styles.list}>
                {hidden.map((item) => (
                  <View key={item.key} style={styles.row}>
                    <View style={styles.mid}>
                      <Text style={styles.payee} numberOfLines={1}>{item.payee}</Text>
                      <Text style={styles.sub}>{cadenceLabel(item.cadence)} · hidden {item.isBill ? 'bill' : 'subscription'}</Text>
                    </View>
                    <Pressable
                      accessibilityRole="button"
                      disabled={restoreAction.isLocked}
                      onPress={() => restoreAction.run({ key: item.key, hidden: false })}
                      style={({ pressed }) => [styles.restoreButton, pressed && { opacity: 0.7 }]}
                    >
                      <Text style={styles.restoreText}>Restore</Text>
                    </Pressable>
                  </View>
                ))}
              </Card>
            </View>
          ) : null}

          <Pressable testID="subscriptions-bills-link" style={({ pressed }) => [styles.note, pressed && { opacity: 0.6 }]} onPress={() => router.push('/bills' as never)}>
            <Text style={styles.noteText}>
              Recurring memberships & apps only. Utilities, rent & internet are tracked as Bills ›
            </Text>
          </Pressable>
          </>
        )}
      />
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
  restoreButton: { borderRadius: 8, backgroundColor: colors.surface2, paddingHorizontal: 12, paddingVertical: 8 },
  restoreText: { color: colors.accentLight, fontSize: 12, fontWeight: '700' },
});
