import React, { useState } from 'react';
import { Alert, KeyboardAvoidingView, Modal, Platform, Pressable, StyleSheet, Text, TextInput, useWindowDimensions, View } from 'react-native';
import { Stack, useRouter } from 'expo-router';
import { useAccounts, useDeleteManualAsset, useManualAssets, useSaveManualAsset, useTrends } from '@/api/hooks/finance.hooks';
import { Account, ManualAsset } from '@/api/generated/types';
import { PushScreen } from '@/components/screen';
import { Avatar, Card, ErrorState, SectionLabel } from '@/components/ui';
import { SkeletonList } from '@/components/skeleton';
import { AreaChart } from '@/components/charts';
import { haptics } from '@/lib/haptics';
import { colors, fmtMoney, fmtPos } from '@/theme/colors';

const RANGES: { label: string; v: number }[] = [
  { label: '3M', v: 3 },
  { label: '6M', v: 6 },
  { label: '1Y', v: 12 },
  { label: '2Y', v: 24 },
  { label: 'ALL', v: 36 },
];

type EditState = { id?: string; name: string; value: string; kind: 'asset' | 'liability' } | null;

export default function NetWorthScreen() {
  const { width } = useWindowDimensions();
  const router = useRouter();
  const [months, setMonths] = useState(12);
  const [showHidden, setShowHidden] = useState(false);
  const [edit, setEdit] = useState<EditState>(null);

  const accounts = useAccounts();
  const trends = useTrends(months);
  const manual = useManualAssets();
  const saveManual = useSaveManualAsset();
  const delManual = useDeleteManualAsset();

  const accts = accounts.data ?? [];
  const visible = accts.filter((a) => !a.hidden);
  const hiddenAccts = accts.filter((a) => a.hidden);
  const assetsList = visible.filter((a) => a.balance >= 0).sort((a, b) => b.balance - a.balance);
  const liabList = visible.filter((a) => a.balance < 0).sort((a, b) => a.balance - b.balance);

  const manualItems = manual.data?.items ?? [];
  const manualAssetTotal = manual.data?.assets ?? 0;
  const manualLiabTotal = manual.data?.liabilities ?? 0;

  const acctAssets = assetsList.reduce((s, a) => s + a.balance, 0);
  const acctLiab = liabList.reduce((s, a) => s + a.balance, 0); // negative
  const assets = acctAssets + manualAssetTotal;
  const liabilities = acctLiab - manualLiabTotal; // negative
  const netWorth = assets + liabilities;

  const nwHist = trends.data?.months ?? [];
  const prevNW = nwHist.length >= 2 ? nwHist[nwHist.length - 2].netWorth : null;
  // Manual assets have no history, so base "this month" on synced accounts only.
  const acctNetWorth = acctAssets + acctLiab;
  const nwDelta = prevNW != null ? acctNetWorth - prevNW : null;
  const nwPoints = nwHist.map((m) => ({ value: m.netWorth, label: m.month }));
  const totalAbs = assets + Math.abs(liabilities);
  const assetPct = totalAbs > 0 ? (assets / totalAbs) * 100 : 100;

  const onRefresh = () => { accounts.refetch(); trends.refetch(); manual.refetch(); };

  const openNew = (kind: 'asset' | 'liability') => { haptics.tap(); setEdit({ name: '', value: '', kind }); };
  const openEdit = (m: ManualAsset) => { haptics.tap(); setEdit({ id: m.id, name: m.name, value: String(m.value), kind: m.kind }); };
  const canSave = !!edit && edit.name.trim().length > 0 && (parseFloat(edit.value) || 0) > 0 && !saveManual.isPending;
  const doSave = () => {
    if (!edit || !canSave) return;
    saveManual.mutate(
      { id: edit.id, name: edit.name.trim(), value: parseFloat(edit.value) || 0, kind: edit.kind },
      { onSuccess: () => setEdit(null), onError: (e) => Alert.alert('Could not save', e.error || 'Please try again.') }
    );
  };
  const doDelete = () => {
    if (!edit?.id) return;
    Alert.alert('Delete?', `Remove “${edit.name}” from net worth?`, [
      { text: 'Cancel', style: 'cancel' },
      { text: 'Delete', style: 'destructive', onPress: () => delManual.mutate({ id: edit.id! }, { onSuccess: () => setEdit(null) }) },
    ]);
  };

  const acctRow = (a: Account) => (
    <Pressable
      testID={`networth-account-${a.id}`}
      key={a.id}
      style={({ pressed }) => [styles.row, pressed && { opacity: 0.6 }]}
      onPress={() => router.push({ pathname: '/account/[id]', params: { id: a.id, name: a.name, balance: String(a.balance), hidden: a.hidden ? '1' : '0' } })}
    >
      <Avatar label={a.name} size={36} />
      <View style={{ flex: 1, minWidth: 0 }}>
        <Text style={styles.name} numberOfLines={1}>{a.name}</Text>
        {netWorth !== 0 ? <Text style={styles.sub}>{Math.round((Math.abs(a.balance) / Math.abs(netWorth)) * 100)}% of net worth</Text> : null}
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
    <PushScreen testID="networth-screen" refreshing={accounts.isFetching || trends.isFetching || manual.isFetching} onRefresh={onRefresh}>
      <Stack.Screen options={{ title: 'Net Worth' }} />
      {accounts.isLoading && !accounts.data ? (
        <SkeletonList hero rows={6} />
      ) : accounts.isError && !accounts.data ? (
        <ErrorState error={accounts.error?.error} onRetry={onRefresh} />
      ) : (
        <>
          <View style={styles.hero}>
            <Text style={styles.heroLabel}>NET WORTH</Text>
            <Text style={[styles.heroValue, { color: netWorth >= 0 ? colors.text : colors.red }]}>{fmtMoney(netWorth)}</Text>
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
              <Text style={styles.splitText}>Assets <Text style={{ color: colors.green }}>{fmtPos(assets)}</Text></Text>
              <Text style={styles.splitText}><Text style={{ color: colors.red }}>{fmtPos(Math.abs(liabilities))}</Text> Liabilities</Text>
            </View>
            <View style={styles.splitBar}>
              <View style={{ flex: Math.max(assetPct, 0.0001), backgroundColor: colors.green }} />
              <View style={{ flex: Math.max(100 - assetPct, 0.0001), backgroundColor: colors.red }} />
            </View>
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

      <Modal visible={edit !== null} animationType="slide" transparent onRequestClose={() => setEdit(null)}>
        <KeyboardAvoidingView behavior={Platform.OS === 'ios' ? 'padding' : 'height'} style={{ flex: 1 }}>
          <Pressable style={styles.modalBg} onPress={() => setEdit(null)}>
            <Pressable testID="networth-manual-sheet" style={styles.sheet} onPress={() => {}}>
              <Text style={styles.sheetTitle}>{edit?.id ? 'Edit' : 'Add'} {edit?.kind === 'liability' ? 'liability' : 'asset'}</Text>
              <Text style={styles.label}>Name</Text>
              <TextInput
                testID="networth-manual-name-input"
                style={styles.input}
                value={edit?.name ?? ''}
                onChangeText={(v) => setEdit((e) => (e ? { ...e, name: v } : e))}
                placeholder={edit?.kind === 'liability' ? 'e.g. Car loan' : 'e.g. Tesla Model 3'}
                placeholderTextColor={colors.muted}
                autoFocus
              />
              <Text style={[styles.label, { marginTop: 12 }]}>Value</Text>
              <View style={styles.amtWrap}>
                <Text style={styles.amtDollar}>$</Text>
                <TextInput
                  testID="networth-manual-value-input"
                  style={styles.amtInput}
                  value={edit?.value ?? ''}
                  onChangeText={(v) => setEdit((e) => (e ? { ...e, value: v.replace(/[^0-9.]/g, '') } : e))}
                  keyboardType="decimal-pad"
                  placeholder="0.00"
                  placeholderTextColor={colors.muted}
                />
              </View>
              <View style={styles.segment}>
                <Pressable testID={`networth-manual-kind-asset${edit?.kind === 'asset' ? '-selected' : ''}`} style={[styles.segBtn, edit?.kind === 'asset' && styles.segActive]} onPress={() => setEdit((e) => (e ? { ...e, kind: 'asset' } : e))}>
                  <Text style={[styles.segText, edit?.kind === 'asset' && styles.segTextActive]}>Asset</Text>
                </Pressable>
                <Pressable testID={`networth-manual-kind-liability${edit?.kind === 'liability' ? '-selected' : ''}`} style={[styles.segBtn, edit?.kind === 'liability' && styles.segActive]} onPress={() => setEdit((e) => (e ? { ...e, kind: 'liability' } : e))}>
                  <Text style={[styles.segText, edit?.kind === 'liability' && styles.segTextActive]}>Liability</Text>
                </Pressable>
              </View>
              <Pressable testID="networth-manual-save-button" style={({ pressed }) => [styles.saveBtn, !canSave && { opacity: 0.4 }, pressed && { opacity: 0.85 }]} onPress={doSave} disabled={!canSave}>
                <Text style={styles.saveText}>{saveManual.isPending ? 'Saving…' : 'Save'}</Text>
              </Pressable>
              {edit?.id ? (
                <Pressable testID="networth-manual-delete-button" style={({ pressed }) => [styles.deleteBtn, pressed && { opacity: 0.7 }]} onPress={doDelete} disabled={delManual.isPending}>
                  <Text style={styles.deleteText}>Delete</Text>
                </Pressable>
              ) : null}
            </Pressable>
          </Pressable>
        </KeyboardAvoidingView>
      </Modal>
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
  modalBg: { flex: 1, backgroundColor: 'rgba(0,0,0,0.6)', justifyContent: 'flex-end' },
  sheet: { backgroundColor: colors.surface, borderTopLeftRadius: 18, borderTopRightRadius: 18, padding: 16, paddingBottom: 32 },
  sheetTitle: { color: colors.text, fontSize: 15, fontWeight: '700', marginBottom: 12 },
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
  saveBtn: { backgroundColor: colors.accent, borderRadius: 10, paddingVertical: 13, alignItems: 'center', marginTop: 16 },
  saveText: { color: '#fff', fontSize: 15, fontWeight: '700' },
  deleteBtn: { paddingVertical: 12, alignItems: 'center', marginTop: 6 },
  deleteText: { color: colors.red, fontSize: 14, fontWeight: '600' },
});
