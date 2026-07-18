import React, { useCallback, useMemo, useState } from 'react';
import { Alert, Pressable, StyleSheet, Text, TextInput, useWindowDimensions, View } from 'react-native';
import { Stack, useRouter } from 'expo-router';
import { useAccounts, useDeleteManualAsset, useManualAssets, useSaveManualAsset, useToday, useTrends } from '@/api/hooks/finance.hooks';
import { Account, ManualAsset } from '@/api/generated/types';
import { PushScreen } from '@/components/screen';
import { Avatar, Card, ErrorState, SectionLabel } from '@/components/ui';
import { SkeletonList } from '@/components/skeleton';
import {
  MutationFieldError,
  MutationFormBanner,
  MutationLiveRegion,
  MutationSheet,
  MutationSubmitButton,
} from '@/components/mutation-form';
import { useMutationAction } from '@/hooks/useMutationAction';
import { useMutationBannerCoordinator } from '@/hooks/useMutationBannerCoordinator';
import { useMutationForm } from '@/hooks/useMutationForm';
import { useMutationScreenAdmission } from '@/hooks/useMutationScreenAdmission';
import { AreaChart } from '@/components/charts';
import { haptics } from '@/lib/haptics';
import { accountsHaveInclusion, resolveMoneyMetric, resolveNetWorthAggregateDisplay } from '@/lib/account-metrics';
import {
  collectFieldErrors,
  parseStrictMoneyDollars,
  validateMoneyField,
  validateRequiredText,
} from '@/lib/mutation-form-validation';
import { colors, fmtMoney, fmtPos } from '@/theme/colors';

const RANGES: { label: string; v: number }[] = [
  { label: '3M', v: 3 },
  { label: '6M', v: 6 },
  { label: '1Y', v: 12 },
  { label: '2Y', v: 24 },
  { label: 'ALL', v: 36 },
];

type EditKind = 'asset' | 'liability';
type EditState = { id?: string; name: string; value: string; kind: EditKind } | null;

export default function NetWorthScreen() {
  const { width } = useWindowDimensions();
  const router = useRouter();
  const [months, setMonths] = useState(12);
  const [showHidden, setShowHidden] = useState(false);
  const [edit, setEdit] = useState<EditState>(null);
  const [manualSessionId, setManualSessionId] = useState(0);

  const accounts = useAccounts();
  const today = useToday();
  const trends = useTrends(months);
  const manual = useManualAssets();
  const saveManual = useSaveManualAsset();
  const delManual = useDeleteManualAsset();
  const admissionRef = useMutationScreenAdmission();

  const fields = useMemo(() => ({
    id: edit?.id,
    name: edit?.name ?? '',
    value: edit?.value ?? '',
    kind: edit?.kind ?? 'asset' as EditKind,
  }), [edit]);

  const applyFields = useCallback((updater: React.SetStateAction<typeof fields>) => {
    setEdit((prev) => {
      if (!prev) return prev;
      const prevFields = { id: prev.id, name: prev.name, value: prev.value, kind: prev.kind };
      const next = typeof updater === 'function' ? updater(prevFields) : updater;
      return {
        ...prev,
        name: next.name !== undefined ? String(next.name) : prev.name,
        value: next.value !== undefined ? String(next.value) : prev.value,
        kind: (next.kind ?? prev.kind) as EditKind,
      };
    });
  }, []);

  const form = useMutationForm({
    formId: edit ? (edit.id ? `manual-${edit.id}` : `manual-new-${manualSessionId}`) : 'manual-none',
    fields,
    setFields: applyFields,
    persistDraft: false,
    mutation: saveManual,
    mutationLabel: 'Save asset',
    fieldOrder: ['name', 'value', 'kind'],
    onSuccessClose: () => setEdit(null),
    onRefetch: () => manual.refetch(),
    validate: (f) => collectFieldErrors({
      name: validateRequiredText(f.name, 'Name'),
      value: validateMoneyField(f.value, { label: 'Value' }),
    }),
    buildVariables: (f) => ({
      id: f.id as string | undefined,
      name: String(f.name).trim(),
      value: parseStrictMoneyDollars(String(f.value))!,
      kind: f.kind as EditKind,
    }),
    admissionRef,
  });

  const deleteAction = useMutationAction({
    mutation: delManual,
    mutationLabel: 'Delete asset',
    admissionRef,
    onActivate: () => form.clearErrors(),
    onSuccess: () => {
      form.clearErrors();
      setEdit(null);
    },
    onRefetch: () => manual.refetch(),
  });

  const banner = useMutationBannerCoordinator(useMemo(() => [
    { key: 'form', outcome: form.outcome, retry: form.retry, announce: form.announce, isLocked: form.isLocked, activitySeq: form.activitySeq },
    { key: 'delete', outcome: deleteAction.outcome, retry: deleteAction.retry, announce: deleteAction.announce, isLocked: deleteAction.isLocked, activitySeq: deleteAction.activitySeq },
  ], [
    deleteAction.activitySeq, deleteAction.announce, deleteAction.isLocked, deleteAction.outcome, deleteAction.retry,
    form.activitySeq, form.announce, form.isLocked, form.outcome, form.retry,
  ]));

  const accts = accounts.data ?? [];
  const visible = accts.filter((a) => !a.hidden);
  const hiddenAccts = accts.filter((a) => a.hidden);
  const hasInclusion = accountsHaveInclusion(accts);
  const nwIncluded = (a: Account) => (hasInclusion ? !!a.inclusion?.netWorth : true);
  const assetsList = visible.filter((a) => nwIncluded(a) && a.balance >= 0).sort((a, b) => b.balance - a.balance);
  const liabList = visible.filter((a) => nwIncluded(a) && a.balance < 0).sort((a, b) => a.balance - b.balance);

  const manualItems = manual.data?.items ?? [];
  const manualComplete = manual.data?.complete !== false;
  const manualAssetTotal = manualComplete ? (manual.data?.assets ?? 0) : 0;
  const manualLiabTotal = manualComplete ? (manual.data?.liabilities ?? 0) : 0;

  const acctAssets = assetsList.reduce((s, a) => s + a.balance, 0);
  const acctLiab = liabList.reduce((s, a) => s + a.balance, 0);
  const fallbackNetWorth = acctAssets + manualAssetTotal + acctLiab - manualLiabTotal;
  const resolvedNetWorth = resolveMoneyMetric(today.data?.metrics?.netWorth, fallbackNetWorth);
  const netWorthAuthoritative = resolvedNetWorth.authoritative;
  const netWorthIncompleteReasons = resolvedNetWorth.reasons;
  const netWorth = netWorthAuthoritative && resolvedNetWorth.value != null
    ? resolvedNetWorth.value
    : (resolvedNetWorth.unavailable ? 0 : (resolvedNetWorth.value ?? fallbackNetWorth));
  const assets = acctAssets + manualAssetTotal;
  const liabilities = acctLiab - manualLiabTotal;
  const aggregateDisplay = resolveNetWorthAggregateDisplay({
    resolved: resolvedNetWorth,
    assets,
    liabilities,
  });
  const breakdownUnavailable = !aggregateDisplay.showAggregates;

  const nwHist = (trends.data?.months ?? []).filter((m) => m.netWorth != null);
  const prevNW = nwHist.length >= 2 ? nwHist[nwHist.length - 2].netWorth : null;
  const acctNetWorth = acctAssets + acctLiab;
  const nwDelta = breakdownUnavailable || prevNW == null ? null : acctNetWorth - prevNW;
  const nwPoints = nwHist.map((m) => ({ value: m.netWorth as number, label: m.month }));
  const totalAbs = breakdownUnavailable ? 0 : assets + Math.abs(liabilities);
  const assetPct = totalAbs > 0 ? (assets / totalAbs) * 100 : 100;

  const onRefresh = () => Promise.all([accounts.refetch(), today.refetch(), trends.refetch(), manual.refetch()]);

  const openNew = (kind: EditKind) => {
    haptics.tap();
    form.clearErrors();
    setManualSessionId((n) => n + 1);
    setEdit({ name: '', value: '', kind });
  };

  const openEdit = (m: ManualAsset) => {
    haptics.tap();
    form.clearErrors();
    setEdit({ id: m.id, name: m.name, value: String(m.value), kind: m.kind });
  };

  const closeSheet = () => {
    form.requestDismiss(() => setEdit(null));
  };

  const remove = () => {
    if (!edit?.id || banner.isLocked) return;
    Alert.alert('Delete?', `Remove "${edit.name}" from net worth?`, [
      { text: 'Cancel', style: 'cancel' },
      {
        text: 'Delete',
        style: 'destructive',
        onPress: () => deleteAction.run({ id: edit.id! }),
      },
    ]);
  };

  const acctRow = (a: Account) => (
    <Pressable
      testID={`networth-account-${a.id}`}
      key={a.id}
      style={({ pressed }) => [styles.row, pressed && { opacity: 0.6 }]}
      onPress={() => router.push({ pathname: '/account/[id]', params: { id: a.id, name: a.name, balance: String(a.balance), hidden: a.hidden ? '1' : '0', role: a.role } })}
    >
      <Avatar label={a.name} size={36} />
      <View style={{ flex: 1, minWidth: 0 }}>
        <Text style={styles.name} numberOfLines={1}>{a.name}</Text>
        {netWorthAuthoritative && !breakdownUnavailable && netWorth !== 0 ? <Text style={styles.sub}>{Math.round((Math.abs(a.balance) / Math.abs(netWorth)) * 100)}% of net worth</Text> : null}
      </View>
      <Text style={[styles.amt, { color: a.balance < 0 ? colors.red : colors.text }]}>{fmtMoney(a.balance)}</Text>
      <Text style={styles.chev}>›</Text>
    </Pressable>
  );

  const manualRow = (m: ManualAsset) => (
    <Pressable testID={`networth-manual-${m.id}`} key={m.id} style={({ pressed }) => [styles.row, pressed && { opacity: 0.6 }]} onPress={() => openEdit(m)}>
      <Avatar label={m.name} size={36} />
      <View style={{ flex: 1, minWidth: 0 }}>
        <Text style={styles.name} numberOfLines={1}>{m.name}</Text>
        <Text style={styles.sub}>Manual {m.kind} · tap to edit</Text>
      </View>
      <Text style={[styles.amt, { color: m.kind === 'liability' ? colors.red : colors.text }]}>
        {m.kind === 'liability' ? '−' : ''}{fmtPos(m.value)}
      </Text>
      <Text style={styles.chev}>›</Text>
    </Pressable>
  );

  return (
    <PushScreen testID="networth-screen" onRefresh={onRefresh}>
      <Stack.Screen options={{ title: 'Net Worth' }} />
      <MutationLiveRegion message={banner.announce} />
      <MutationFormBanner outcome={banner.outcome} onRetry={banner.retry} onRefetch={() => { void manual.refetch(); }} />
      {accounts.isLoading && !accounts.data ? (
        <SkeletonList hero rows={6} />
      ) : accounts.isError && !accounts.data ? (
        <ErrorState error={accounts.error?.error} onRetry={onRefresh} />
      ) : (
        <>
          <View style={styles.hero}>
            <Text style={styles.heroLabel}>NET WORTH</Text>
            <Text style={[styles.heroValue, { color: netWorth >= 0 ? colors.text : colors.red }]}>
              {netWorthAuthoritative ? fmtMoney(netWorth) : (netWorthIncompleteReasons.length ? 'Unavailable' : fmtMoney(netWorth))}
            </Text>
            {!netWorthAuthoritative && netWorthIncompleteReasons.length ? (
              <Text style={styles.delta}>Server projection incomplete — local sum not shown as authoritative</Text>
            ) : null}
            {nwDelta != null ? (
              <Text style={[styles.delta, { color: nwDelta >= 0 ? colors.green : colors.red }]}>
                {nwDelta >= 0 ? '▲' : '▼'} {fmtPos(Math.abs(nwDelta))} this month
              </Text>
            ) : null}
          </View>

          {nwPoints.length > 1 ? (
            <Card style={{ marginBottom: 16 }}>
              <AreaChart width={width - 64} points={nwPoints} />
              <View style={styles.rangeRow}>
                {RANGES.map((r) => (
                  <Pressable
                    testID={`networth-range-${r.label.toLowerCase()}${months === r.v ? '-selected' : ''}`}
                    key={r.label}
                    onPress={() => { haptics.tap(); setMonths(r.v); }}
                    style={({ pressed }) => [styles.range, months === r.v && styles.rangeActive, pressed && { opacity: 0.7 }]}
                  >
                    <Text style={[styles.rangeText, months === r.v && styles.rangeTextActive]}>{r.label}</Text>
                  </Pressable>
                ))}
              </View>
            </Card>
          ) : null}

          <Card style={{ marginBottom: 16 }}>
            <View style={styles.splitHead}>
              <Text style={styles.splitText}>
                Assets <Text style={{ color: colors.green }}>{breakdownUnavailable ? '—' : fmtPos(assets)}</Text>
              </Text>
              <Text style={styles.splitText}>
                <Text style={{ color: colors.red }}>{breakdownUnavailable ? '—' : fmtPos(Math.abs(liabilities))}</Text> Liabilities
              </Text>
            </View>
            {!breakdownUnavailable ? (
              <View style={styles.splitBar}>
                <View style={{ flex: Math.max(assetPct, 0.0001), backgroundColor: colors.green }} />
                <View style={{ flex: Math.max(100 - assetPct, 0.0001), backgroundColor: colors.red }} />
              </View>
            ) : (
              <Text style={styles.delta}>Asset/liability breakdown unavailable while projection is incomplete</Text>
            )}
          </Card>

          <View style={styles.deepLinks}>
            <Pressable testID="networth-investments-link" style={({ pressed }) => [styles.deepCard, pressed && { opacity: 0.65 }]} onPress={() => { haptics.tap(); router.push('/investments' as never); }}>
              <Text style={styles.deepLabel}>Investments</Text>
              <Text style={styles.deepSub}>Holdings, allocation, performance ›</Text>
            </Pressable>
            <Pressable testID="networth-debt-link" style={({ pressed }) => [styles.deepCard, pressed && { opacity: 0.65 }]} onPress={() => { haptics.tap(); router.push('/debt' as never); }}>
              <Text style={styles.deepLabel}>Debt payoff</Text>
              <Text style={styles.deepSub}>APR, payoff date, strategy ›</Text>
            </Pressable>
          </View>

          {assetsList.length ? (
            <>
              <SectionLabel>Assets</SectionLabel>
              <Card style={styles.list}>{assetsList.map(acctRow)}</Card>
            </>
          ) : null}

          {liabList.length ? (
            <View style={{ marginTop: 16 }}>
              <SectionLabel>Liabilities</SectionLabel>
              <Card style={styles.list}>{liabList.map(acctRow)}</Card>
            </View>
          ) : null}

          <View style={{ marginTop: 16 }}>
            <SectionLabel>Manual assets</SectionLabel>
            {manualItems.length ? <Card style={styles.list}>{manualItems.map(manualRow)}</Card> : null}
            <View style={styles.addRow}>
              <Pressable testID="networth-add-asset-button" style={({ pressed }) => [styles.addBtn, pressed && { opacity: 0.7 }]} onPress={() => openNew('asset')}>
                <Text style={styles.addBtnText}>+ Add asset</Text>
              </Pressable>
              <Pressable testID="networth-add-liability-button" style={({ pressed }) => [styles.addBtn, pressed && { opacity: 0.7 }]} onPress={() => openNew('liability')}>
                <Text style={styles.addBtnText}>+ Add liability</Text>
              </Pressable>
            </View>
            <Text style={styles.manualHint}>Track things outside your bank (car, home, cash, crypto). They roll into net worth but not the history chart.</Text>
          </View>

          {hiddenAccts.length ? (
            <View style={{ marginTop: 20 }}>
              <Pressable testID="networth-hidden-toggle" style={styles.hiddenToggle} onPress={() => { haptics.tap(); setShowHidden((s) => !s); }}>
                <Text style={styles.hiddenToggleText}>{showHidden ? 'Hide' : 'Show'} {hiddenAccts.length} hidden account{hiddenAccts.length === 1 ? '' : 's'}</Text>
                <Text style={styles.chev}>{showHidden ? '⌃' : '⌄'}</Text>
              </Pressable>
              {showHidden ? <Card style={styles.list}>{hiddenAccts.map(acctRow)}</Card> : null}
            </View>
          ) : null}
        </>
      )}

      <MutationSheet
        visible={edit !== null}
        title={`${edit?.id ? 'Edit' : 'Add'} ${edit?.kind === 'liability' ? 'liability' : 'asset'}`}
        testID="networth-manual-sheet"
        canDismiss={form.canDismiss && !banner.isLocked}
        onRequestClose={closeSheet}
      >
        <Text style={styles.label}>Name</Text>
        <TextInput
          testID="networth-manual-name-input"
          style={[styles.input, form.getFieldError('name') && { borderColor: '#ff6b6b' }]}
          value={edit?.name ?? ''}
          onChangeText={(v) => setEdit((e) => (e ? { ...e, name: v } : e))}
          placeholder={edit?.kind === 'liability' ? 'e.g. Car loan' : 'e.g. Tesla Model 3'}
          placeholderTextColor={colors.muted}
          autoFocus
          accessibilityLabel="Name"
        />
        <MutationFieldError error={form.getFieldError('name')} testID="networth-manual-name-error" />
        <Text style={[styles.label, { marginTop: 12 }]}>Value</Text>
        <View style={[styles.amtWrap, form.getFieldError('value') && { borderColor: '#ff6b6b' }]}>
          <Text style={styles.amtDollar}>$</Text>
          <TextInput
            testID="networth-manual-value-input"
            style={styles.amtInput}
            value={edit?.value ?? ''}
            onChangeText={(v) => setEdit((e) => (e ? { ...e, value: v.replace(/[^0-9.]/g, '') } : e))}
            keyboardType="decimal-pad"
            placeholder="0.00"
            placeholderTextColor={colors.muted}
            accessibilityLabel="Value"
          />
        </View>
        <MutationFieldError error={form.getFieldError('value')} testID="networth-manual-value-error" />
        <View style={styles.segment}>
          <Pressable testID={`networth-manual-kind-asset${edit?.kind === 'asset' ? '-selected' : ''}`} style={[styles.segBtn, edit?.kind === 'asset' && styles.segActive]} onPress={() => setEdit((e) => (e ? { ...e, kind: 'asset' } : e))}>
            <Text style={[styles.segText, edit?.kind === 'asset' && styles.segTextActive]}>Asset</Text>
          </Pressable>
          <Pressable testID={`networth-manual-kind-liability${edit?.kind === 'liability' ? '-selected' : ''}`} style={[styles.segBtn, edit?.kind === 'liability' && styles.segActive]} onPress={() => setEdit((e) => (e ? { ...e, kind: 'liability' } : e))}>
            <Text style={[styles.segText, edit?.kind === 'liability' && styles.segTextActive]}>Liability</Text>
          </Pressable>
        </View>
        <MutationFieldError error={form.getFieldError('kind')} testID="networth-manual-kind-error" />
        <MutationFormBanner outcome={banner.outcome} onRetry={banner.retry} onRefetch={() => manual.refetch()} />
        <MutationSubmitButton
          testID="networth-manual-save-button"
          label="Save"
          pendingLabel="Saving…"
          onPress={() => form.submit()}
          disabled={banner.isLocked}
        />
        {edit?.id ? (
          <Pressable testID="networth-manual-delete-button" style={({ pressed }) => [styles.deleteBtn, pressed && { opacity: 0.7 }]} onPress={remove} disabled={banner.isLocked}>
            <Text style={styles.deleteText}>Delete</Text>
          </Pressable>
        ) : null}
      </MutationSheet>
    </PushScreen>
  );
}

const styles = StyleSheet.create({
  hero: { marginBottom: 12, marginTop: 4 },
  heroLabel: { color: colors.muted, fontSize: 11, fontWeight: '700', letterSpacing: 1 },
  heroValue: { fontSize: 40, fontWeight: '800', letterSpacing: -1.5, marginTop: 4 },
  delta: { fontSize: 13, fontWeight: '700', marginTop: 6 },
  rangeRow: { flexDirection: 'row', justifyContent: 'space-between', marginTop: 12, gap: 6 },
  range: { flex: 1, paddingVertical: 6, borderRadius: 8, alignItems: 'center', backgroundColor: colors.surface2 },
  rangeActive: { backgroundColor: colors.accent },
  rangeText: { color: colors.muted, fontSize: 12, fontWeight: '700' },
  rangeTextActive: { color: '#fff' },
  splitHead: { flexDirection: 'row', justifyContent: 'space-between', marginBottom: 10 },
  splitText: { color: colors.muted, fontSize: 12, fontWeight: '600' },
  splitBar: { flexDirection: 'row', height: 10, borderRadius: 5, overflow: 'hidden', gap: 2 },
  deepLinks: { flexDirection: 'row', gap: 10, marginBottom: 16 },
  deepCard: { flex: 1, backgroundColor: colors.surface, borderColor: colors.border, borderWidth: 1, borderRadius: 14, padding: 13 },
  deepLabel: { color: colors.text, fontSize: 14, fontWeight: '800' },
  deepSub: { color: colors.muted, fontSize: 11, lineHeight: 15, marginTop: 4 },
  list: { paddingVertical: 4 },
  row: { flexDirection: 'row', alignItems: 'center', gap: 12, paddingVertical: 10 },
  name: { color: colors.text, fontSize: 15, fontWeight: '600' },
  sub: { color: colors.muted, fontSize: 12, marginTop: 2 },
  amt: { fontSize: 15, fontWeight: '700' },
  chev: { color: colors.muted, fontSize: 16, fontWeight: '700', marginLeft: 2 },
  addRow: { flexDirection: 'row', gap: 10, marginTop: 8 },
  addBtn: { flex: 1, paddingVertical: 12, borderRadius: 10, alignItems: 'center', borderWidth: 1, borderColor: colors.border, backgroundColor: colors.surface },
  addBtnText: { color: colors.accentLight, fontSize: 14, fontWeight: '700' },
  manualHint: { color: colors.muted, fontSize: 11, marginTop: 10, lineHeight: 16 },
  hiddenToggle: { flexDirection: 'row', alignItems: 'center', justifyContent: 'space-between', paddingVertical: 6 },
  hiddenToggleText: { color: colors.accentLight, fontSize: 13, fontWeight: '700' },
  label: { color: colors.muted, fontSize: 12, fontWeight: '600', marginBottom: 6, textTransform: 'uppercase', letterSpacing: 0.5 },
  input: { backgroundColor: colors.surface2, borderColor: colors.border, borderWidth: 1, borderRadius: 8, color: colors.text, paddingHorizontal: 12, paddingVertical: 10, fontSize: 15 },
  amtWrap: { flexDirection: 'row', alignItems: 'center', backgroundColor: colors.surface2, borderColor: colors.border, borderWidth: 1, borderRadius: 8, paddingHorizontal: 12 },
  amtDollar: { color: colors.muted, fontSize: 16 },
  amtInput: { flex: 1, color: colors.text, fontSize: 16, paddingVertical: 10, paddingLeft: 4 },
  segment: { flexDirection: 'row', gap: 8, marginTop: 12 },
  segBtn: { flex: 1, paddingVertical: 11, borderRadius: 10, alignItems: 'center', borderWidth: 1, borderColor: colors.border, backgroundColor: colors.surface },
  segActive: { borderColor: colors.accent, backgroundColor: 'rgba(124,110,247,0.12)' },
  segText: { color: colors.muted, fontSize: 14, fontWeight: '600' },
  segTextActive: { color: colors.accentLight },
  deleteBtn: { paddingVertical: 12, alignItems: 'center', marginTop: 6 },
  deleteText: { color: colors.red, fontSize: 14, fontWeight: '600' },
});
