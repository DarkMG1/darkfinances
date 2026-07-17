import React, { useMemo, useState } from 'react';
import { ActivityIndicator, Pressable, StyleSheet, Text, View } from 'react-native';
import { useRouter } from 'expo-router';
import { useConfirmRepayment, useDismissRepayment, useReimbursement, useRepaymentSuggestions } from '@/api/hooks/finance.hooks';
import { PushScreen } from '@/components/screen';
import { Avatar, Card, CardTitle, EmptyState, ErrorState, Pill } from '@/components/ui';
import { MutationFormBanner, MutationLiveRegion } from '@/components/mutation-form';
import { SkeletonList } from '@/components/skeleton';
import { useMutationAction } from '@/hooks/useMutationAction';
import { OwesPerson, ReimbLeg, RepaymentSuggestion } from '@/api/generated/types';
import { haptics } from '@/lib/haptics';
import { colors, fmtDate, fmtPos, fmtSignedMoney } from '@/theme/colors';
import { reimbursementWindow, type ReimbursementRangeKey, useFinanceToday } from '@/lib/date-only';

const cap = (s: string) => s.charAt(0).toUpperCase() + s.slice(1);
type Status = 'outstanding' | 'partial' | 'settled';
const pillKind = (s: Status): 'open' | 'paid' | 'partial' => (s === 'settled' ? 'paid' : s === 'partial' ? 'partial' : 'open');
const pillText = (s: Status) => (s === 'settled' ? 'settled' : s === 'partial' ? 'partial' : 'owed');
const sourceLabel = (source?: string | null) => {
  if (!source) return 'Debt source unknown';
  if (/pairwise/i.test(source)) return 'Splitwise pairwise snapshot';
  if (/legacy/i.test(source)) return 'Legacy reimbursement baseline';
  return source;
};
const snapshotLabel = (source?: string | null, generatedAt?: string | null, warning?: string | null) => {
  const parts = [sourceLabel(source)];
  if (generatedAt) parts.push(`updated ${fmtDate(generatedAt.slice(0, 10))}`);
  if (warning) parts.push(`warning: ${warning.replace(/-/g, ' ')}`);
  return parts.join(' · ');
};
const cutoffLabel = (cutoff?: string | null) => cutoff ? `direct ledger since ${fmtDate(cutoff)}` : 'current balance';
const bucketTitle = (name: string) => {
  if (name === '(group/unsplit)') return 'Fronted for groups & trips';
  if (name === '(unattributed)') return 'Unattributed reimbursements';
  if (name === '(settled-prepaid)') return 'Settled / prepaid fronts';
  return cap(name.replace(/[()]/g, ''));
};

// Summary window presets. Debts (People) are always lifetime; this only scopes
// the fronted / paid-back / net headline so you can review, e.g., just June.
type RangeKey = ReimbursementRangeKey;
const RANGES: { key: RangeKey; label: string }[] = [
  { key: 'mtd', label: 'MTD' },
  { key: '7d', label: '7D' },
  { key: '30d', label: '30D' },
  { key: 'life', label: 'All' },
];
function windowFor(r: RangeKey, anchor: string) {
  return reimbursementWindow(r, anchor);
}

// A person's debt is either tracked in a Splitwise trip/group, a set of direct
// fronts you put on your card, or both. This is lifetime — no month scoping —
// so who owes you is stable regardless of which month you're browsing elsewhere.
export default function Reimbursement() {
  const router = useRouter();
  const financeToday = useFinanceToday();
  const [range, setRange] = useState<RangeKey>('mtd');
  const win = useMemo(() => windowFor(range, financeToday), [range, financeToday]);
  const reimb = useReimbursement({ from: win.from, to: win.to });
  const suggestions = useRepaymentSuggestions();
  const confirm = useConfirmRepayment();
  const dismiss = useDismissRepayment();
  const confirmAction = useMutationAction({
    mutation: confirm,
    mutationLabel: 'Confirm repayment',
    onRefetch: () => { suggestions.refetch(); reimb.refetch(); },
  });
  const dismissAction = useMutationAction({
    mutation: dismiss,
    mutationLabel: 'Dismiss suggestion',
    onRefetch: () => suggestions.refetch(),
  });
  const [acting, setActing] = useState<string | null>(null);
  const [open, setOpen] = useState<Record<string, boolean>>({});

  const owes = reimb.data?.owes ?? [];
  const summary = reimb.data?.summary;
  const totalOwedMetric = reimb.data?.totalOwed;
  const grandTotal = totalOwedMetric?.complete ? (totalOwedMetric.value ?? 0) : null;
  const grandLowerBound = !totalOwedMetric?.complete ? totalOwedMetric?.lowerBound : null;
  const debtorCount = reimb.data?.debtorCount ?? owes.length;
  const sugg = suggestions.data?.complete === false ? [] : (suggestions.data?.suggestions ?? []);
  const snapshot = snapshotLabel(reimb.data?.owesSource, reimb.data?.owesGeneratedAt, reimb.data?.owesWarning);
  const windowNet = (summary?.paidBack ?? 0) - (summary?.fronted ?? 0);
  const netValue = range === 'life'
    ? (summary?.outstanding ?? (totalOwedMetric?.complete ? totalOwedMetric.value : null))
    : windowNet;
  const netGood = range === 'life'
    ? (netValue != null && netValue <= 0.5)
    : netValue != null && netValue >= -0.005;

  // Group/trip fronts not attributed to a specific person (net < 0 = owed to you).
  const bucketList = useMemo(() => {
    const b = reimb.data?.buckets ?? {};
    return Object.entries(b)
      .map(([name, v]) => ({ name, owed: -(v?.net ?? 0), count: v?.count ?? 0, legs: v?.legs ?? [] }))
      .filter((x) => x.owed > 0.5)
      .sort((a, b2) => b2.owed - a.owed);
  }, [reimb.data]);

  const onConfirm = (s: RepaymentSuggestion) => {
    if (confirmAction.isLocked) return;
    setActing(s.id);
    haptics.tap();
    confirmAction.run({ id: s.id }, {
      onSettled: () => setActing(null),
    });
  };
  const onDismiss = (s: RepaymentSuggestion) => {
    if (dismissAction.isLocked) return;
    setActing(s.id);
    haptics.tap();
    dismissAction.run({ id: s.id, inflowId: s.inflow.id }, { onSettled: () => setActing(null) });
  };

  const toggle = (key: string) => { haptics.tap(); setOpen((o) => ({ ...o, [key]: !o[key] })); };
  const openLeg = (l: ReimbLeg) => {
    if (!l.id || !l.accountId || !l.date) return;
    haptics.tap();
    router.push({
      pathname: '/transaction/[id]',
      params: {
        id: l.id,
        payee: l.payee || l.label || '',
        amount: String(l.amount),
        date: l.date,
        account: l.account || '',
        accountId: l.accountId,
        category: 'Reimbursement',
        categoryId: l.categoryId || '',
        notes: l.notes || '',
        isLeg: l.isLeg ? '1' : '',
        parentId: l.parentId || '',
        cleared: l.cleared === false ? '0' : '1',
        imported: l.imported ? '1' : '',
      },
    });
  };
  const loading = reimb.isLoading && !reimb.data;

  const personStatus = (p: OwesPerson): Status => (p.owed <= 0.5 ? 'settled' : 'outstanding');
  const subLabel = (p: OwesPerson): string => {
    const parts: string[] = [];
    if (p.trips.length > 0) parts.push(p.trips.map((t) => cap(t.event)).join(', '));
    if (p.legs.length > 0) parts.push(`${p.legs.length} charge${p.legs.length === 1 ? '' : 's'}`);
    return parts.join(' \u00b7 ') || 'settled up';
  };

  return (
    <PushScreen testID="reimbursement-screen" onRefresh={() => Promise.all([reimb.refetch(), suggestions.refetch()])}>
      <MutationLiveRegion message={confirmAction.announce || dismissAction.announce} />
      <MutationFormBanner
        outcome={confirmAction.outcome ?? dismissAction.outcome}
        onRetry={() => { confirmAction.retry(); dismissAction.retry(); }}
        onRefetch={() => { suggestions.refetch(); reimb.refetch(); }}
      />
      {loading ? (
        <SkeletonList rows={5} />
      ) : reimb.isError && !reimb.data ? (
        <ErrorState error={reimb.error?.error} onRetry={reimb.refetch} />
      ) : (
        <>
          <Card style={{ marginBottom: 16 }}>
            <Text style={styles.total}>
              {grandTotal != null ? fmtPos(grandTotal) : grandLowerBound != null ? `${totalOwedMetric?.lowerBoundLabel || 'at least'} ${fmtPos(grandLowerBound)}` : '—'}
            </Text>
            <Text style={styles.totalLabel}>
              owed to you · {debtorCount ?? '—'} {debtorCount === 1 ? 'person' : 'people'} · {cutoffLabel(reimb.data?.ledgerCutoff)}
              {totalOwedMetric?.complete === false ? ' · partial ledger scan' : ''}
            </Text>
            <Text style={[styles.sourceLabel, reimb.data?.owesWarning && { color: colors.yellow }]}>{snapshot}</Text>
            {reimb.data?.lastKnownSplitwise ? (
              <View style={styles.staleNotice}>
                <Text style={styles.staleTitle}>Splitwise is not included in the current total</Text>
                <Text style={styles.staleText}>
                  Last known: {fmtPos(reimb.data.lastKnownSplitwise.total)}
                  {reimb.data.lastKnownSplitwise.generatedAt
                    ? ` · updated ${fmtDate(reimb.data.lastKnownSplitwise.generatedAt.slice(0, 10))}`
                    : ''}
                </Text>
              </View>
            ) : null}

            <View style={styles.rangeRow}>
              {RANGES.map((r) => {
                const on = r.key === range;
                return (
                  <Pressable
                    testID={`reimbursement-range-${r.key}${on ? '-selected' : ''}`}
                    key={r.key}
                    onPress={() => { haptics.tap(); setRange(r.key); }}
                    style={({ pressed }) => [styles.rangeChip, on && styles.rangeChipOn, pressed && { opacity: 0.7 }]}
                  >
                    <Text style={[styles.rangeText, on && styles.rangeTextOn]}>{r.label}</Text>
                  </Pressable>
                );
              })}
            </View>
            <Text style={styles.winLabel}>{win.label.toUpperCase()}</Text>

            <View style={styles.sumRow}>
              <View style={styles.sumChip}>
                <Text style={styles.sumVal}>{fmtPos(summary?.fronted ?? 0)}</Text>
                <Text style={styles.sumLabel}>fronted</Text>
              </View>
              <View style={styles.sumChip}>
                <Text style={[styles.sumVal, { color: colors.green }]}>{fmtPos(summary?.paidBack ?? 0)}</Text>
                <Text style={styles.sumLabel}>paid back</Text>
              </View>
              <View style={styles.sumChip}>
                <Text style={[styles.sumVal, { color: netGood ? colors.green : colors.red }]}>
                  {range === 'life'
                    ? (netValue != null ? fmtPos(netValue) : '—')
                    : (netValue != null ? fmtSignedMoney(netValue) : '—')}
                </Text>
                <Text style={styles.sumLabel}>{range === 'life' ? 'still owed' : 'net cash flow'}</Text>
              </View>
            </View>
          </Card>

          {sugg.length > 0 ? (
            <>
              <CardTitle>Suggested repayments</CardTitle>
              <Card style={{ marginBottom: 16 }}>
                {sugg.map((s, i) => {
                  const busy = acting === s.id;
                  return (
                    <View key={s.id} testID={`reimbursement-suggestion-${i}`} style={[styles.suggest, i > 0 && styles.suggestDivider]}>
                      <View style={styles.suggestHead}>
                        <Avatar label={cap(s.person)} size={34} />
                        <View style={{ flex: 1, minWidth: 0 }}>
                          <Text style={styles.name}>{cap(s.person)} · {fmtPos(s.inflow.amount)}</Text>
                          <Text style={styles.sub} numberOfLines={1}>{s.inflow.payee}{s.inflow.date ? ` \u00b7 ${fmtDate(s.inflow.date)}` : ''}</Text>
                        </View>
                        <Pill text={`owes ${fmtPos(s.owed)}`} kind="open" />
                      </View>
                      <Text style={styles.reason}>{s.reason}</Text>
                      {s.allocations.length > 0 ? (
                        <View style={styles.allocWrap}>
                          {s.allocations.slice(0, 4).map((a, j) => (
                            <Text key={j} style={styles.alloc} numberOfLines={1}>• {a.expense.payee || 'charge'} — {fmtPos(a.amount)}</Text>
                          ))}
                          {s.allocations.length > 4 ? <Text style={styles.alloc}>+{s.allocations.length - 4} more</Text> : null}
                          {s.remainder > 0.005 ? <Text style={[styles.alloc, { color: colors.yellow }]}>• {fmtPos(s.remainder)} extra (over what is tracked)</Text> : null}
                        </View>
                      ) : null}
                      <View style={styles.suggestActions}>
                        <Pressable testID={`reimbursement-suggestion-confirm-${i}`} onPress={() => onConfirm(s)} disabled={busy} style={({ pressed }) => [styles.confirmBtn, pressed && { opacity: 0.7 }, busy && { opacity: 0.5 }]}>
                          {busy && confirm.isPending ? <ActivityIndicator size="small" color="#fff" /> : <Text style={styles.confirmText}>Confirm</Text>}
                        </Pressable>
                        <Pressable testID={`reimbursement-suggestion-dismiss-${i}`} onPress={() => onDismiss(s)} disabled={busy} style={({ pressed }) => [styles.dismissBtn, pressed && { opacity: 0.7 }, busy && { opacity: 0.5 }]}>
                          <Text style={styles.dismissText}>Dismiss</Text>
                        </Pressable>
                      </View>
                    </View>
                  );
                })}
                <Text style={styles.suggestHint}>Confirm files the payment under Reimbursement so it cancels out what they owe.</Text>
              </Card>
            </>
          ) : null}

          <CardTitle>People</CardTitle>
          <Card>
            {owes.length === 0 ? (
              <EmptyState icon="checkmark.circle">All settled up</EmptyState>
            ) : (
              owes.map((p, idx) => {
                const expanded = !!open[p.slug];
                const status = personStatus(p);
                return (
                  <View key={p.slug} style={idx > 0 ? styles.personDivider : undefined}>
                    <Pressable testID={`reimbursement-person-${p.slug}`} style={styles.personRow} onPress={() => toggle(p.slug)}>
                      <Avatar label={cap(p.slug)} size={38} />
                      <View style={{ flex: 1, minWidth: 0 }}>
                        <Text style={styles.name}>{cap(p.slug)}</Text>
                        <Text style={styles.sub} numberOfLines={1}>{subLabel(p)}</Text>
                      </View>
                      <View style={{ alignItems: 'flex-end', gap: 4 }}>
                        <Text style={[styles.amt, { color: status === 'settled' ? colors.muted : colors.green }]}>{fmtPos(p.owed)}</Text>
                        <Pill text={pillText(status)} kind={pillKind(status)} />
                      </View>
                      <Text style={styles.chev}>{expanded ? '\u25be' : '\u203a'}</Text>
                    </Pressable>

                    {expanded ? (
                      <View style={styles.charges}>
                        {p.trips.length > 0 ? (
                          <>
                            <Text style={styles.chargesLabel}>Tracked in Splitwise</Text>
                            {p.trips.map((t) => (
                              <View key={t.event} style={styles.tripRow}>
                                <Text style={styles.tripName}>{cap(t.event)}</Text>
                                <Text style={styles.tripAmt}>{fmtPos(t.remaining)}</Text>
                              </View>
                            ))}
                          </>
                        ) : null}
                        {p.legs.length > 0 ? (
                          <>
                            <Text style={styles.chargesLabel}>Fronts</Text>
                            {p.legs.map((l, j) => (
                              <Pressable
                                testID={`reimbursement-person-${p.slug}-leg-${j}`}
                                key={`${l.id || l.date}-${j}`}
                                disabled={!l.id || !l.accountId}
                                onPress={() => openLeg(l)}
                                style={({ pressed }) => [styles.legRow, pressed && { opacity: 0.65 }]}
                              >
                                <View style={{ flex: 1, minWidth: 0 }}>
                                  <Text style={styles.legLabel} numberOfLines={1}>{l.label || 'Charge'}</Text>
                                  <Text style={styles.legDate}>{fmtDate(l.date)}</Text>
                                </View>
                                <Text style={styles.legAmt}>{fmtPos(Math.abs(l.amount))}</Text>
                              </Pressable>
                            ))}
                          </>
                        ) : null}
                        {p.trips.length === 0 && p.legs.length === 0 ? (
                          <Text style={styles.noCharges}>Settled up</Text>
                        ) : null}
                      </View>
                    ) : null}
                  </View>
                );
              })
            )}
          </Card>

          {bucketList.length > 0 ? (
            <>
              <CardTitle style={{ marginTop: 16 }}>Group / trip fronts</CardTitle>
              <Card>
                {bucketList.map((bk, i) => (
                  <View key={bk.name} style={i > 0 ? styles.personDivider : undefined}>
                    <Pressable testID={`reimbursement-bucket-${i}`} style={styles.personRow} onPress={() => toggle(`__b_${bk.name}`)}>
                      <View style={{ flex: 1, minWidth: 0 }}>
                        <Text style={styles.name}>{bucketTitle(bk.name)}</Text>
                        <Text style={styles.sub}>{bk.count} charge{bk.count === 1 ? '' : 's'} · not yet split per person</Text>
                      </View>
                      <Text style={[styles.amt, { color: colors.green }]}>{fmtPos(bk.owed)}</Text>
                      <Text style={styles.chev}>{open[`__b_${bk.name}`] ? '\u25be' : '\u203a'}</Text>
                    </Pressable>
                    {open[`__b_${bk.name}`] ? (
                      <View style={styles.charges}>
                        {bk.legs.map((l, j) => (
                          <Pressable
                            testID={`reimbursement-bucket-${i}-leg-${j}`}
                            key={`${l.id || l.date}-${j}`}
                            disabled={!l.id || !l.accountId}
                            onPress={() => openLeg(l)}
                            style={({ pressed }) => [styles.legRow, pressed && { opacity: 0.65 }]}
                          >
                            <View style={{ flex: 1, minWidth: 0 }}>
                              <Text style={styles.legLabel} numberOfLines={1}>{l.label || 'Charge'}</Text>
                              <Text style={styles.legDate}>{fmtDate(l.date)}</Text>
                            </View>
                            <Text style={styles.legAmt}>{fmtPos(Math.abs(l.amount))}</Text>
                          </Pressable>
                        ))}
                      </View>
                    ) : null}
                  </View>
                ))}
              </Card>
              <Text style={styles.footHint}>Raw fronts not tied to one person yet — tag them with a name or #event to split.</Text>
            </>
          ) : null}
        </>
      )}
    </PushScreen>
  );
}

const styles = StyleSheet.create({
  total: { color: colors.green, fontSize: 32, fontWeight: '800', letterSpacing: -1 },
  totalLabel: { color: colors.muted, fontSize: 13, marginTop: 2 },
  sourceLabel: { color: colors.muted, fontSize: 11, marginTop: 5, lineHeight: 15 },
  staleNotice: { marginTop: 10, padding: 10, borderRadius: 10, backgroundColor: colors.yellow + '18', borderWidth: 1, borderColor: colors.yellow + '55' },
  staleTitle: { color: colors.yellow, fontSize: 12, fontWeight: '800' },
  staleText: { color: colors.muted, fontSize: 11, marginTop: 3 },
  rangeRow: { flexDirection: 'row', gap: 6, marginTop: 14, backgroundColor: colors.surface2, borderRadius: 10, padding: 3 },
  rangeChip: { flex: 1, paddingVertical: 7, borderRadius: 8, alignItems: 'center' },
  rangeChipOn: { backgroundColor: colors.accent },
  rangeText: { color: colors.muted, fontSize: 12, fontWeight: '700' },
  rangeTextOn: { color: '#fff' },
  winLabel: { color: colors.muted, fontSize: 10, fontWeight: '700', letterSpacing: 1, marginTop: 12 },
  sumRow: { flexDirection: 'row', gap: 10, marginTop: 8 },
  sumChip: { flex: 1, backgroundColor: colors.surface2, borderRadius: 10, paddingVertical: 10, alignItems: 'center' },
  sumVal: { color: colors.text, fontSize: 15, fontWeight: '700' },
  sumLabel: { color: colors.muted, fontSize: 10, marginTop: 2 },

  name: { color: colors.text, fontSize: 14, fontWeight: '600' },
  sub: { color: colors.muted, fontSize: 11, marginTop: 1 },
  amt: { color: colors.green, fontSize: 15, fontWeight: '700' },

  personDivider: { borderTopWidth: StyleSheet.hairlineWidth, borderTopColor: colors.border },
  personRow: { flexDirection: 'row', alignItems: 'center', gap: 12, paddingVertical: 11 },
  chev: { color: colors.muted, fontSize: 16, fontWeight: '700', width: 14, textAlign: 'center' },
  charges: { paddingLeft: 6, paddingBottom: 8, gap: 8 },
  chargesLabel: { color: colors.muted, fontSize: 11, fontWeight: '700', textTransform: 'uppercase', letterSpacing: 0.5, marginTop: 4 },
  noCharges: { color: colors.muted, fontSize: 12, fontStyle: 'italic', paddingVertical: 2 },
  tripRow: { flexDirection: 'row', alignItems: 'center', justifyContent: 'space-between', backgroundColor: colors.surface2, borderRadius: 10, paddingVertical: 10, paddingHorizontal: 12 },
  tripName: { color: colors.text, fontSize: 13, fontWeight: '600', textTransform: 'capitalize' },
  tripAmt: { color: colors.green, fontSize: 13, fontWeight: '700' },
  legRow: { flexDirection: 'row', alignItems: 'center', justifyContent: 'space-between', gap: 10, backgroundColor: colors.surface2, borderRadius: 10, paddingVertical: 9, paddingHorizontal: 12 },
  legLabel: { color: colors.text, fontSize: 13, fontWeight: '500' },
  legDate: { color: colors.muted, fontSize: 11, marginTop: 1 },
  legAmt: { color: colors.green, fontSize: 13, fontWeight: '700' },
  footHint: { color: colors.muted, fontSize: 11, marginTop: 8, lineHeight: 15 },

  suggest: { paddingVertical: 12 },
  suggestDivider: { borderTopWidth: StyleSheet.hairlineWidth, borderTopColor: colors.border },
  suggestHead: { flexDirection: 'row', alignItems: 'center', gap: 10 },
  reason: { color: colors.text, fontSize: 13, marginTop: 8 },
  allocWrap: { marginTop: 6, gap: 2 },
  alloc: { color: colors.muted, fontSize: 12 },
  suggestActions: { flexDirection: 'row', gap: 10, marginTop: 12 },
  confirmBtn: { flex: 1, backgroundColor: colors.green, borderRadius: 10, paddingVertical: 10, alignItems: 'center' },
  confirmText: { color: '#fff', fontSize: 14, fontWeight: '700' },
  dismissBtn: { flex: 1, backgroundColor: colors.surface2, borderRadius: 10, paddingVertical: 10, alignItems: 'center' },
  dismissText: { color: colors.muted, fontSize: 14, fontWeight: '700' },
  suggestHint: { color: colors.muted, fontSize: 11, marginTop: 10, lineHeight: 15 },
});
