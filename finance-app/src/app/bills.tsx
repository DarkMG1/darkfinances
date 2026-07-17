import React, { useMemo, useState } from 'react';
import { Pressable, StyleSheet, Text, View } from 'react-native';
import { useRouter } from 'expo-router';
import { useBills } from '@/api/hooks/finance.hooks';
import { PushScreen } from '@/components/screen';
import { Avatar, Card, EmptyState, ErrorState, SectionLabel } from '@/components/ui';
import { SkeletonList } from '@/components/skeleton';
import { Bill } from '@/api/generated/types';
import { useFinanceToday } from '@/lib/date-only';
import { haptics } from '@/lib/haptics';
import { cadenceLabel, colors, daysUntil, dueLabel, fmtDay, fmtMoney, fmtPos } from '@/theme/colors';

const cap = (s: string) => s.charAt(0).toUpperCase() + s.slice(1);
const WEEKDAYS = ['S', 'M', 'T', 'W', 'T', 'F', 'S'];
const sid = (s: string) => s.replace(/[^a-z0-9]+/gi, '-').replace(/^-|-$/g, '').toLowerCase();

function CalendarMonth({ year, month, dueByDay, selected, onSelect }: {
  year: number;
  month: number; // 0-indexed
  dueByDay: Record<string, number>;
  selected: string | null;
  onSelect: (day: string | null) => void;
}) {
  const today = useFinanceToday();
  const monthName = new Date(year, month, 1).toLocaleDateString('en-US', { month: 'long', year: 'numeric' });
  const startWeekday = new Date(year, month, 1).getDay();
  const daysInMonth = new Date(year, month + 1, 0).getDate();
  const cells: (number | null)[] = [];
  for (let i = 0; i < startWeekday; i++) cells.push(null);
  for (let d = 1; d <= daysInMonth; d++) cells.push(d);
  while (cells.length % 7 !== 0) cells.push(null);
  const weeks: (number | null)[][] = [];
  for (let i = 0; i < cells.length; i += 7) weeks.push(cells.slice(i, i + 7));
  const dayKey = (d: number) => `${year}-${String(month + 1).padStart(2, '0')}-${String(d).padStart(2, '0')}`;

  return (
    <Card style={styles.calCard}>
      <Text style={styles.calTitle}>{monthName}</Text>
      <View style={styles.calRow}>
        {WEEKDAYS.map((w, i) => <Text key={i} style={styles.calWeekday}>{w}</Text>)}
      </View>
      {weeks.map((week, wi) => (
        <View key={wi} style={styles.calRow}>
          {week.map((d, di) => {
            if (d == null) return <View key={di} style={styles.calCell} />;
            const key = dayKey(d);
            const has = !!dueByDay[key];
            const isToday = key === today;
            const isSel = key === selected;
            return (
              <Pressable key={di} style={styles.calCell} disabled={!has} onPress={() => { haptics.tap(); onSelect(isSel ? null : key); }}>
                <View style={[styles.calDay, isToday && styles.calToday, isSel && styles.calSelected]}>
                  <Text style={[styles.calDayText, isToday && { color: colors.accentLight }, isSel && { color: '#fff' }]}>{d}</Text>
                </View>
                {has ? <View style={[styles.calDot, isSel && { backgroundColor: '#fff' }]} /> : <View style={styles.calDotSpacer} />}
              </Pressable>
            );
          })}
        </View>
      ))}
    </Card>
  );
}

export default function Bills() {
  const router = useRouter();
  const financeToday = useFinanceToday();
  const bills = useBills();
  const data = bills.data;
  const [selected, setSelected] = useState<string | null>(null);

  const all = useMemo(() => data?.bills ?? [], [data?.bills]);

  const dueByDay = useMemo(() => {
    const m: Record<string, number> = {};
    for (const b of all) if (!b.paid) m[b.dueDate] = (m[b.dueDate] || 0) + 1;
    return m;
  }, [all]);

  const months = useMemo(() => {
    const set = new Set<string>();
    for (const b of all) set.add(b.dueDate.slice(0, 7));
    set.add(financeToday.slice(0, 7));
    return Array.from(set).sort().map((k) => {
      const [y, mo] = k.split('-').map(Number);
      return { year: y, month: mo - 1 };
    });
  }, [all, financeToday]);

  // Buckets shown when no specific day is selected. A selected day renders its
  // items inline beneath the calendar month instead (see below).
  const groups = useMemo(() => {
    const buckets: { title: string; items: Bill[] }[] = [
      { title: 'This week', items: [] },
      { title: 'Next week', items: [] },
      { title: 'Later', items: [] },
    ];
    for (const b of all) {
      const d = daysUntil(b.dueDate, financeToday);
      if (d <= 7) buckets[0].items.push(b);
      else if (d <= 14) buckets[1].items.push(b);
      else buckets[2].items.push(b);
    }
    return buckets.filter((g) => g.items.length);
  }, [all, financeToday]);

  // Read-only: paid is auto-derived on the server from a matched real charge —
  // there's no manual "mark paid" (you can't fake a payment that didn't happen).
  const renderRow = (b: Bill) => {
    const paidLabel = b.paid ? (b.matched ? `paid ${fmtDay(b.matched.date)}` : 'paid') : `estimated ${dueLabel(b.dueDate, financeToday)}`;
    const variance = b.variance ?? null;
    const varianceText = variance != null && Math.abs(variance) >= 0.01 ? ` · ${variance > 0 ? '+' : ''}${fmtMoney(variance)} vs expected` : '';
    return (
      <Pressable testID={`bills-row-${sid(b.key)}`} key={b.id} style={({ pressed }) => [styles.row, pressed && { opacity: 0.65 }]} onPress={() => { haptics.tap(); router.push(`/recurring/${encodeURIComponent(b.key)}`); }}>
        <Avatar label={cap(b.payee)} category={b.category} size={36} />
        <View style={styles.mid}>
          <Text style={[styles.payee, b.paid && styles.paidText]} numberOfLines={1}>{cap(b.payee)}</Text>
          <Text style={styles.sub} numberOfLines={1}>
            {paidLabel} · {b.category} · {cadenceLabel(b.cadence)}{varianceText}
          </Text>
        </View>
        <Text style={[styles.amt, b.paid && styles.paidText]}>{fmtPos(b.amount)}</Text>
      </Pressable>
    );
  };

  return (
    <PushScreen testID="bills-screen" onRefresh={bills.refetch}>
      {bills.isLoading ? (
        <SkeletonList hero rows={5} />
      ) : bills.isError && !data ? (
        <ErrorState error={bills.error?.error} onRetry={bills.refetch} />
      ) : !data || data.count === 0 ? (
        <EmptyState icon="calendar">No upcoming bills detected</EmptyState>
      ) : (
        <>
          <View style={styles.hero}>
            <Text style={styles.heroLabel}>UNPAID · NEXT {data.horizonDays} DAYS</Text>
            <Text style={styles.heroValue}>{fmtMoney(data.total)}</Text>
            <Text style={styles.heroSub}>{data.unpaidCount} of {data.count} bills unpaid</Text>
          </View>

          {months.map((m) => {
            const mKey = `${m.year}-${String(m.month + 1).padStart(2, '0')}`;
            const dayItems = selected && selected.slice(0, 7) === mKey ? all.filter((b) => b.dueDate === selected) : null;
            return (
              <View key={`${m.year}-${m.month}`}>
                <CalendarMonth
                  year={m.year}
                  month={m.month}
                  dueByDay={dueByDay}
                  selected={selected}
                  onSelect={setSelected}
                />
                {dayItems ? (
                  <View style={{ marginTop: 6 }}>
                    <View style={styles.selHead}>
                      <SectionLabel>{dueLabel(selected!, financeToday)}</SectionLabel>
                      <Text style={styles.clearSelText} onPress={() => setSelected(null)}>Show all</Text>
                    </View>
                    {dayItems.length ? (
                      <Card style={styles.list}>{dayItems.map(renderRow)}</Card>
                    ) : (
                      <EmptyState>Nothing due this day</EmptyState>
                    )}
                  </View>
                ) : null}
              </View>
            );
          })}

          {!selected
            ? groups.map((g) => (
                <View key={g.title} style={{ marginTop: 8 }}>
                  <SectionLabel>{g.title}</SectionLabel>
                  <Card style={styles.list}>{g.items.map(renderRow)}</Card>
                </View>
              ))
            : null}
        </>
      )}
    </PushScreen>
  );
}

const styles = StyleSheet.create({
  hero: { marginBottom: 4, marginTop: 4 },
  heroLabel: { color: colors.muted, fontSize: 11, fontWeight: '700', letterSpacing: 1 },
  heroValue: { color: colors.text, fontSize: 38, fontWeight: '800', letterSpacing: -1.5, marginTop: 4 },
  heroSub: { color: colors.muted, fontSize: 13, marginTop: 4 },
  calCard: { marginTop: 12, paddingVertical: 12 },
  calTitle: { color: colors.text, fontSize: 14, fontWeight: '700', marginBottom: 10, textAlign: 'center' },
  calRow: { flexDirection: 'row' },
  calWeekday: { flex: 1, textAlign: 'center', color: colors.muted, fontSize: 11, fontWeight: '600', marginBottom: 4 },
  calCell: { flex: 1, alignItems: 'center', paddingVertical: 3 },
  calDay: { width: 30, height: 30, borderRadius: 15, alignItems: 'center', justifyContent: 'center' },
  calToday: { borderWidth: 1, borderColor: colors.accentLight },
  calSelected: { backgroundColor: colors.accent },
  calDayText: { color: colors.text, fontSize: 13 },
  calDot: { width: 5, height: 5, borderRadius: 3, backgroundColor: colors.accentLight, marginTop: 2 },
  calDotSpacer: { width: 5, height: 5, marginTop: 2 },
  selHead: { flexDirection: 'row', alignItems: 'center', justifyContent: 'space-between' },
  clearSelText: { color: colors.accentLight, fontSize: 12, fontWeight: '600' },
  list: { paddingVertical: 4 },
  row: { flexDirection: 'row', alignItems: 'center', gap: 12, paddingVertical: 10 },
  mid: { flex: 1, minWidth: 0 },
  payee: { color: colors.text, fontSize: 15, fontWeight: '600' },
  sub: { color: colors.muted, fontSize: 12, marginTop: 2 },
  amt: { color: colors.text, fontSize: 15, fontWeight: '700' },
  paidText: { color: colors.muted, textDecorationLine: 'line-through' },
});
