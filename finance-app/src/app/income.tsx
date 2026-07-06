import React from 'react';
import { StyleSheet, Text, View } from 'react-native';
import { useIncome } from '@/api/hooks/finance.hooks';
import { IncomeStream } from '@/api/generated/types';
import { PushScreen } from '@/components/screen';
import { Avatar, Card, EmptyState, ErrorState, SectionLabel } from '@/components/ui';
import { SkeletonList } from '@/components/skeleton';
import { cadenceLabel, colors, dueLabel, fmtDay, fmtMoney, fmtPos } from '@/theme/colors';

const cap = (s: string) => (s ? s.charAt(0).toUpperCase() + s.slice(1) : s);

function Row({ s, muted }: { s: IncomeStream; muted?: boolean }) {
  return (
    <View style={[styles.row, muted ? { opacity: 0.5 } : null]}>
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
  const income = useIncome();
  const data = income.data;
  const active = (data?.streams ?? []).filter((s) => s.active);
  const inactive = (data?.streams ?? []).filter((s) => !s.active);

  return (
    <PushScreen refreshing={income.isFetching} onRefresh={income.refetch}>
      {income.isLoading ? (
        <SkeletonList hero rows={4} />
      ) : income.isError && !data ? (
        <ErrorState error={income.error?.error} onRetry={income.refetch} />
      ) : !data || data.count === 0 ? (
        <EmptyState icon="dollarsign.circle">No recurring income detected yet</EmptyState>
      ) : (
        <>
          <View style={styles.hero}>
            <Text style={styles.heroLabel}>MONTHLY INCOME</Text>
            <Text style={styles.heroValue}>{fmtMoney(data.monthlyTotal)}</Text>
            <Text style={styles.heroSub}>
              {data.nextPayday
                ? `Next: ${cap(data.nextPaydayPayee ?? 'paycheck')} · ${dueLabel(data.nextPayday)} · ${fmtPos(data.nextPaydayAmount ?? 0)}`
                : `${data.activeCount} active stream${data.activeCount === 1 ? '' : 's'}`}
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
        </>
      )}
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
