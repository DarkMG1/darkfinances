import React from 'react';
import { StyleSheet, Text, View } from 'react-native';
import { useIncome } from '@/api/hooks/finance.hooks';
import { IncomeStream } from '@/api/generated/types';
import { PushScreen } from '@/components/screen';
import { QueryScreenBody } from '@/components/query-display';
import { Avatar, Card, EmptyState, SectionLabel } from '@/components/ui';
import { SkeletonList } from '@/components/skeleton';
import { useFinanceToday } from '@/lib/date-only';
import { heroMetricAccessibilityLabel } from '@/lib/metric-a11y.js';
import { cadenceLabel, colors, dueLabel, fmtDay, fmtMoney, fmtPos } from '@/theme/colors';

const cap = (s: string) => (s ? s.charAt(0).toUpperCase() + s.slice(1) : s);
const sid = (s: string) => s.replace(/[^a-z0-9]+/gi, '-').replace(/^-|-$/g, '').toLowerCase();

function Row({ s, muted }: { s: IncomeStream; muted?: boolean }) {
  return (
    <View testID={`income-stream-${sid(s.key)}`} style={[styles.row, muted ? { opacity: 0.5 } : null]}>
      <Avatar label={s.payee} category="income" size={38} />
      <View style={styles.mid}>
        <Text style={styles.payee} numberOfLines={1}>{cap(s.payee)}</Text>
        <Text style={styles.sub} numberOfLines={1}>
          {cadenceLabel(s.cadence)} · last {fmtDay(s.lastPaid)}{s.active ? ` · next ${fmtDay(s.nextPay)}` : ''}
        </Text>
      </View>
      <View style={{ alignItems: 'flex-end' }}>
        <Text style={styles.amt}>+{fmtPos(s.amount)}</Text>
        <Text style={styles.sub}>{fmtPos(s.monthlyEquivalent)}/mo</Text>
      </View>
    </View>
  );
}

export default function Income() {
  const financeToday = useFinanceToday();
  const income = useIncome();
  const data = income.data;
  const active = (data?.streams ?? []).filter((s) => s.active);
  const inactive = (data?.streams ?? []).filter((s) => !s.active);

  return (
    <PushScreen testID="income-screen" onRefresh={income.refetch}>
      <QueryScreenBody
        query={income}
        loading={<SkeletonList hero rows={4} />}
        empty={<EmptyState icon="dollarsign.circle">No recurring income detected yet</EmptyState>}
        hasContent={!!data && data.count > 0}
        refetchBannerTestID="income-refetch-banner"
      >
          <View
            style={styles.hero}
            accessible
            accessibilityLabel={heroMetricAccessibilityLabel(
              'Monthly income',
              fmtMoney(data!.monthlyTotal),
              data!.nextPayday
                ? `Next: ${cap(data!.nextPaydayPayee ?? 'paycheck')}, ${dueLabel(data!.nextPayday, financeToday)}, ${fmtPos(data!.nextPaydayAmount ?? 0)}`
                : `${data!.activeCount} active stream${data!.activeCount === 1 ? '' : 's'}`,
            )}
          >
            <Text style={styles.heroLabel} accessibilityElementsHidden importantForAccessibility="no">MONTHLY INCOME</Text>
            <Text style={styles.heroValue} accessibilityElementsHidden importantForAccessibility="no">{fmtMoney(data!.monthlyTotal)}</Text>
            <Text style={styles.heroSub} accessibilityElementsHidden importantForAccessibility="no">
              {data!.nextPayday
                ? `Next: ${cap(data!.nextPaydayPayee ?? 'paycheck')} · ${dueLabel(data!.nextPayday, financeToday)} · ${fmtPos(data!.nextPaydayAmount ?? 0)}`
                : `${data!.activeCount} active stream${data!.activeCount === 1 ? '' : 's'}`}
            </Text>
          </View>

          {active.length ? (
            <View style={{ marginTop: 8 }}>
              <SectionLabel>Active</SectionLabel>
              <Card style={styles.list}>{active.map((s) => <Row key={s.key} s={s} />)}</Card>
            </View>
          ) : null}

          {inactive.length ? (
            <View style={{ marginTop: 8 }}>
              <SectionLabel>Paused</SectionLabel>
              <Card style={styles.list}>{inactive.map((s) => <Row key={s.key} s={s} muted />)}</Card>
            </View>
          ) : null}
      </QueryScreenBody>
    </PushScreen>
  );
}

const styles = StyleSheet.create({
  hero: { marginBottom: 4, marginTop: 4 },
  heroLabel: { color: colors.muted, fontSize: 11, fontWeight: '700', letterSpacing: 1 },
  heroValue: { color: colors.green, fontSize: 38, fontWeight: '800', letterSpacing: -1.5, marginTop: 4 },
  heroSub: { color: colors.muted, fontSize: 13, marginTop: 4 },
  list: { paddingVertical: 4 },
  row: { flexDirection: 'row', alignItems: 'center', gap: 12, paddingVertical: 10 },
  mid: { flex: 1, minWidth: 0 },
  payee: { color: colors.text, fontSize: 15, fontWeight: '600' },
  sub: { color: colors.muted, fontSize: 12, marginTop: 2 },
  amt: { color: colors.green, fontSize: 15, fontWeight: '700' },
});
