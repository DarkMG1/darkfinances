import React, { useMemo, useState } from 'react';
import { Pressable, StyleSheet, Text, View } from 'react-native';
import Animated, { FadeInDown } from 'react-native-reanimated';
import { Stack, useLocalSearchParams, useRouter } from 'expo-router';
import { useTransactions } from '@/api/hooks/finance.hooks';
import { PushScreen } from '@/components/screen';
import { Avatar, Card, EmptyState, ErrorState, PendingPill } from '@/components/ui';
import { SkeletonList } from '@/components/skeleton';
import { haptics } from '@/lib/haptics';
import { colors, fmtDate, fmtPos, monthLabel } from '@/theme/colors';

const pad = (n: number) => String(n).padStart(2, '0');
const ymd = (d: Date) => `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}`;

type CatRange = 'month' | '3m' | 'year' | 'all';
const RANGES: { key: CatRange; label: string }[] = [
  { key: 'month', label: 'Month' },
  { key: '3m', label: '3M' },
  { key: 'year', label: 'Year' },
  { key: 'all', label: 'All' },
];

function rangeWindow(key: CatRange, month?: string): { start: string; end: string; label: string } {
  const now = new Date();
  const end = ymd(now);
  if (key === 'month') {
    if (month) {
      const [y, m] = month.split('-').map(Number);
      const last = new Date(y, m, 0).getDate();
      return { start: `${month}-01`, end: `${month}-${pad(last)}`, label: monthLabel(month) };
    }
    return { start: `${now.getFullYear()}-${pad(now.getMonth() + 1)}-01`, end, label: 'This month' };
  }
  if (key === '3m') { const d = new Date(now); d.setMonth(d.getMonth() - 2); return { start: `${d.getFullYear()}-${pad(d.getMonth() + 1)}-01`, end, label: 'Last 3 months' }; }
  if (key === 'year') return { start: `${now.getFullYear()}-01-01`, end, label: 'This year' };
  return { start: '2000-01-01', end, label: 'All time' };
}

export default function CategoryDetail() {
  const router = useRouter();
  const params = useLocalSearchParams<{ name: string; month?: string; range?: string }>();
  // expo-router already decodes route params; use as-is.
  const name = params.name ?? '';
  const [range, setRange] = useState<CatRange>(
    (RANGES.some((r) => r.key === params.range) ? (params.range as CatRange) : 'month')
  );
  const { start, end, label } = rangeWindow(range, params.month);

  const txns = useTransactions({ start, end, category: name });

  const isUncat = name.toLowerCase() === 'uncategorized';
  const rows = useMemo(() => {
    const list = (txns.data ?? []).filter((t) =>
      isUncat ? !t.category : (t.category || '').toLowerCase() === name.toLowerCase()
    );
    return list.sort((a, b) => b.date.localeCompare(a.date));
  }, [txns.data, name, isUncat]);

  const total = useMemo(() => rows.reduce((s, t) => s + Math.abs(t.amount), 0), [rows]);

  return (
    <PushScreen refreshing={txns.isFetching} onRefresh={txns.refetch}>
      <Stack.Screen options={{ title: name || 'Category' }} />
      {txns.isLoading && !txns.data ? (
        <SkeletonList hero rows={7} />
      ) : txns.isError && !txns.data ? (
        <ErrorState error={txns.error?.error} onRetry={txns.refetch} />
      ) : (
        <>
          <View style={styles.hero}>
            <Text style={styles.heroLabel}>{label.toUpperCase()}</Text>
            <Text style={styles.heroValue}>{fmtPos(total)}</Text>
            <Text style={styles.heroSub}>{rows.length} transaction{rows.length === 1 ? '' : 's'}</Text>
          </View>

          <View style={styles.rangeRow}>
            {RANGES.map((r) => {
              const on = r.key === range;
              return (
                <Pressable
                  key={r.key}
                  onPress={() => { haptics.tap(); setRange(r.key); }}
                  style={({ pressed }) => [styles.rangeChip, on && styles.rangeChipOn, pressed && { opacity: 0.7 }]}
                >
                  <Text style={[styles.rangeText, on && styles.rangeTextOn]}>{r.label}</Text>
                </Pressable>
              );
            })}
          </View>

          {rows.length === 0 ? (
            <EmptyState icon="tray">No transactions in {name} for {label.toLowerCase()}</EmptyState>
          ) : (
            <Card style={styles.list}>
              {rows.map((t, i) => (
                <Animated.View key={t.id} entering={FadeInDown.duration(180).delay(Math.min(i * 18, 180))}>
                <Pressable
                  style={({ pressed }) => [styles.row, pressed && { opacity: 0.6 }]}
                  onPress={() =>
                    router.push({
                      pathname: '/transaction/[id]',
                      params: {
                        id: t.id,
                        payee: t.payee || '',
                        amount: String(t.amount),
                        date: t.date,
                        account: t.account,
                        accountId: t.accountId,
                        category: t.category || '',
                        categoryId: t.categoryId || '',
                        notes: t.notes || '',
                        isLeg: t.isLeg ? '1' : '',
                        parentId: t.parentId || '',
                        cleared: t.cleared === false ? '0' : '1',
                      },
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
        </>
      )}
    </PushScreen>
  );
}

const styles = StyleSheet.create({
  hero: { marginBottom: 12, marginTop: 4 },
  heroLabel: { color: colors.muted, fontSize: 11, fontWeight: '700', letterSpacing: 1 },
  heroValue: { color: colors.text, fontSize: 38, fontWeight: '800', letterSpacing: -1.5, marginTop: 4 },
  heroSub: { color: colors.muted, fontSize: 13, marginTop: 4 },
  rangeRow: { flexDirection: 'row', gap: 6, marginBottom: 14, backgroundColor: colors.surface2, borderRadius: 10, padding: 3 },
  rangeChip: { flex: 1, paddingVertical: 7, borderRadius: 8, alignItems: 'center' },
  rangeChipOn: { backgroundColor: colors.accent },
  rangeText: { color: colors.muted, fontSize: 12, fontWeight: '700' },
  rangeTextOn: { color: '#fff' },
  list: { paddingVertical: 4 },
  row: { flexDirection: 'row', alignItems: 'center', gap: 12, paddingVertical: 10 },
  mid: { flex: 1, minWidth: 0 },
  payeeLine: { flexDirection: 'row', alignItems: 'center', gap: 6 },
  payee: { color: colors.text, fontSize: 15, fontWeight: '600' },
  sub: { color: colors.muted, fontSize: 12, marginTop: 2 },
  amt: { fontSize: 15, fontWeight: '700' },
});
