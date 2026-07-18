import React, { useEffect, useMemo, useRef, useState } from 'react';
import { Alert, FlatList, KeyboardAvoidingView, Modal, Platform, Pressable, ScrollView, StyleSheet, Text, TextInput, View } from 'react-native';
import { Stack, useLocalSearchParams, useNavigation, useRouter } from 'expo-router';
import { useSafeAreaInsets } from 'react-native-safe-area-context';
import { useCategories, useSplitTransaction, useTransaction, useUnsplitTransaction } from '@/api/hooks/finance.hooks';
import { Avatar } from '@/components/ui';
import { MutationFormBanner, MutationFieldError, MutationLiveRegion } from '@/components/mutation-form';
import { useMutationAction } from '@/hooks/useMutationAction';
import { useMutationBannerCoordinator } from '@/hooks/useMutationBannerCoordinator';
import { haptics } from '@/lib/haptics';
import { colors, fmtPos } from '@/theme/colors';

type Mode = 'equal' | 'specific' | 'percent';
type Leg = { key: string; id?: string; catId: string | null; catName: string; name: string; notes: string; showNote: boolean; amt: string; pct: string };

const MODE_LABEL: Record<Mode, string> = {
  equal: 'by equal amounts',
  specific: 'by specific amounts',
  percent: 'by percentages',
};

let seq = 0;
const nk = () => `leg-${Date.now()}-${seq++}`;
const r2 = (n: number) => Math.round(n * 100) / 100;

// Master (index 0) always absorbs the balance so the legs sum to the total exactly.
function computeAmounts(legs: Leg[], mode: Mode, total: number): number[] {
  const n = legs.length;
  if (n === 0) return [];
  if (mode === 'equal') {
    const each = Math.floor((total * 100) / n) / 100;
    const arr = legs.map(() => each);
    arr[0] = r2(total - each * (n - 1));
    return arr;
  }
  if (mode === 'percent') {
    const arr = legs.map((l, i) => (i === 0 ? 0 : r2((total * (parseFloat(l.pct) || 0)) / 100)));
    const used = arr.reduce((s, v, i) => (i === 0 ? s : s + v), 0);
    arr[0] = r2(total - used);
    return arr;
  }
  // specific
  const arr = legs.map((l, i) => (i === 0 ? 0 : r2(parseFloat(l.amt) || 0)));
  const used = arr.reduce((s, v, i) => (i === 0 ? s : s + v), 0);
  arr[0] = r2(total - used);
  return arr;
}

export default function SplitEditor() {
  const p = useLocalSearchParams<{ id: string; accountId: string; date: string }>();
  const router = useRouter();
  const navigation = useNavigation();
  const insets = useSafeAreaInsets();

  const detail = useTransaction(p.id, p.accountId, p.date);
  const categories = useCategories();
  const split = useSplitTransaction();
  const unsplit = useUnsplitTransaction();

  const [mode, setMode] = useState<Mode>('equal');
  const [legs, setLegs] = useState<Leg[]>([]);
  const [modePick, setModePick] = useState(false);
  const [catPick, setCatPick] = useState<number | null>(null);
  const [focusKey, setFocusKey] = useState<string | null>(null);
  const inited = useRef(false);

  const legFieldOrder = useMemo(() => legs.map((_, i) => `leg-${i}`), [legs]);
  const splitAction = useMutationAction({
    mutation: split,
    mutationLabel: 'Save split',
    onRefetch: () => detail.refetch(),
    fieldOrder: legFieldOrder,
  });
  const unsplitAction = useMutationAction({
    mutation: unsplit,
    mutationLabel: 'Remove split',
    onRefetch: () => detail.refetch(),
  });
  const banner = useMutationBannerCoordinator(useMemo(() => [
    { key: 'split', outcome: splitAction.outcome, retry: splitAction.retry, announce: splitAction.announce, isLocked: splitAction.isLocked },
    { key: 'unsplit', outcome: unsplitAction.outcome, retry: unsplitAction.retry, announce: unsplitAction.announce, isLocked: unsplitAction.isLocked },
  ], [
    splitAction.announce, splitAction.isLocked, splitAction.outcome, splitAction.retry,
    unsplitAction.announce, unsplitAction.isLocked, unsplitAction.outcome, unsplitAction.retry,
  ]));
  const mutationLocked = banner.isLocked;
  const legFieldError = (i: number) => splitAction.outcome?.fieldErrors?.[`leg-${i}`];

  const d = detail.data;
  const total = d ? Math.abs(d.amount) : 0;
  const sign = d && d.amount < 0 ? -1 : 1;

  // Seed the editor once the transaction loads.
  useEffect(() => {
    if (!d || inited.current) return;
    inited.current = true;
    const nextMode = d.isSplit && d.legs.length ? 'specific' : mode;
    const nextLegs = d.isSplit && d.legs.length
      ? d.legs.map((l) => ({
          key: nk(),
          id: l.id,
          catId: l.categoryId,
          catName: l.category || '',
          name: l.name || '',
          notes: l.notes || '',
          showNote: !!l.notes,
          amt: Math.abs(l.amount).toFixed(2),
          pct: total ? String(r2((Math.abs(l.amount) / total) * 100)) : '',
        }))
      : [
          // First split: master carries the whole amount + inherits the category.
          { key: nk(), catId: d.categoryId, catName: d.category || '', name: '', notes: '', showNote: false, amt: total.toFixed(2), pct: '100' },
        ];
    const timer = setTimeout(() => {
      setMode(nextMode);
      setLegs(nextLegs);
    }, 0);
    return () => clearTimeout(timer);
  }, [d, mode, total]);

  useEffect(() => {
    const first = splitAction.outcome?.firstField;
    if (!first || !first.startsWith('leg-')) return;
    const idx = Number(first.replace('leg-', ''));
    if (!Number.isFinite(idx) || !legs[idx]) return;
    const key = legs[idx].key;
    const frame = requestAnimationFrame(() => setFocusKey(key));
    return () => cancelAnimationFrame(frame);
  }, [legs, splitAction.outcome]);

  useEffect(() => {
    const unsub = navigation.addListener('beforeRemove', (e) => {
      if (!mutationLocked) return;
      e.preventDefault();
    });
    return unsub;
  }, [mutationLocked, navigation]);

  const amounts = useMemo(() => computeAmounts(legs, mode, total), [legs, mode, total]);
  const master = amounts[0] ?? 0;
  const balanced = Math.abs(amounts.reduce((s, v) => s + v, 0) - total) < 0.005;
  const allPositive = amounts.every((v) => v > 0.0049);
  const canSave = legs.length >= 2 && balanced && allPositive && master > 0.0049;

  const setLeg = (i: number, patch: Partial<Leg>) => setLegs((ls) => ls.map((l, idx) => (idx === i ? { ...l, ...patch } : l)));

  const addLeg = () => {
    haptics.tap();
    const key = nk();
    setLegs((ls) => [...ls, { key, catId: null, catName: '', name: '', notes: '', showNote: false, amt: '', pct: '' }]);
    if (mode === 'specific' || mode === 'percent') setFocusKey(key);
  };
  const removeLeg = (i: number) => {
    if (i === 0) return; // master is not removable
    haptics.tap();
    setLegs((ls) => ls.filter((_, idx) => idx !== i));
  };

  const changeMode = (m: Mode) => {
    setModePick(false);
    setLegs((ls) => {
      const amts = computeAmounts(ls, ls.length ? mode : m, total);
      return ls.map((l, i) => ({
        ...l,
        amt: (amts[i] ?? 0).toFixed(2),
        pct: total ? String(r2(((amts[i] ?? 0) / total) * 100)) : '',
      }));
    });
    setMode(m);
    haptics.tap();
  };

  const pickCat = (cid: string, cname: string) => {
    if (catPick != null) setLeg(catPick, { catId: cid, catName: cname });
    setCatPick(null);
  };

  const doSave = () => {
    if (!d || !canSave) return;
    const payload = legs.map((l, i) => ({
      id: l.id,
      amount: sign * (amounts[i] ?? 0),
      categoryId: l.catId,
      name: l.name.trim() || undefined,
      notes: l.notes.trim() || undefined,
    }));
    splitAction.run(
      { id: d.id, accountId: d.accountId, date: d.date, legs: payload },
      {
        onSuccess: (result) => {
          router.replace({
            pathname: '/transaction/[id]',
            params: { id: (result as { id?: string })?.id || d.id, accountId: d.accountId, date: d.date },
          });
        },
      },
    );
  };

  const doUnsplit = () => {
    if (!d) return;
    Alert.alert('Remove split?', 'This merges the legs back into a single transaction.', [
      { text: 'Cancel', style: 'cancel' },
      {
        text: 'Remove split',
        style: 'destructive',
        onPress: () =>
          unsplitAction.run(
            { id: d.id, accountId: d.accountId, date: d.date, categoryId: legs[0]?.catId ?? null },
            {
              onSuccess: (result) => {
                router.replace({
                  pathname: '/transaction/[id]',
                  params: { id: (result as { id?: string })?.id || d.id, accountId: d.accountId, date: d.date },
                });
              },
            },
          ),
      },
    ]);
  };

  return (
    <KeyboardAvoidingView testID="split-editor-screen" style={{ flex: 1, backgroundColor: colors.bg }} behavior={Platform.OS === 'ios' ? 'padding' : undefined}>
      {/* Custom dark header — the native modal header rendered Cancel/Save as
          light "glass" capsules on iOS 26; this keeps the app's dark styling. */}
      <Stack.Screen options={{ headerShown: false }} />
      <View style={[styles.topBar, { paddingTop: Math.max(insets.top, 8) + 6 }]}>
        <Pressable testID="split-cancel-button" onPress={() => { if (!mutationLocked) router.back(); }} disabled={mutationLocked} hitSlop={12} style={({ pressed }) => [pressed && !mutationLocked && { opacity: 0.6 }, mutationLocked && { opacity: 0.35 }]}>
          <Text style={styles.topCancel}>Cancel</Text>
        </Pressable>
        <Text style={styles.topTitle}>Split</Text>
        <Pressable testID="split-save-button" onPress={doSave} disabled={!canSave || mutationLocked} hitSlop={12} style={({ pressed }) => pressed && { opacity: 0.6 }}>
          <Text style={[styles.topSave, (!canSave || mutationLocked) && { opacity: 0.4 }]}>{splitAction.isLocked ? 'Saving…' : 'Save'}</Text>
        </Pressable>
      </View>

      <MutationLiveRegion message={banner.announce} />

      <ScrollView contentContainerStyle={{ padding: 16, paddingBottom: insets.bottom + 40 }} keyboardShouldPersistTaps="handled" keyboardDismissMode="on-drag">
        <MutationFormBanner
          outcome={banner.outcome}
          onRetry={banner.retry}
          onRefetch={() => detail.refetch()}
        />
        {!d ? (
          <Text style={styles.loading}>{detail.isError ? 'Could not load transaction.' : 'Loading…'}</Text>
        ) : (
          <>
            <View style={styles.hero}>
              <Avatar label={d.payee} category={d.category || undefined} size={44} style={{ marginBottom: 8 }} />
              <Text style={styles.heroPayee} numberOfLines={1}>{d.payee || '(no payee)'}</Text>
              <Text style={styles.heroAmount}>{fmtPos(total)}</Text>
            </View>

            {!d.cleared ? (
              <View style={styles.pendingWarn}>
                <Text style={styles.pendingWarnTitle}>This charge is still pending</Text>
                <Text style={styles.pendingWarnBody}>
                  The final amount may change once it posts. You can split it now — if the posted total differs, we’ll adjust the remainder leg automatically to keep the split balanced.
                </Text>
              </View>
            ) : null}

            <Pressable testID="split-mode-picker" style={styles.modeRow} onPress={() => setModePick(true)}>
              <Text style={styles.modeLead}>Split this transaction</Text>
              <View style={styles.modePill}>
                <Text style={styles.modePillText}>{MODE_LABEL[mode]}</Text>
                <Text style={styles.modeCaret}>▾</Text>
              </View>
            </Pressable>

            {legs.map((l, i) => (
              <View key={l.key} testID={`split-leg-${i}`} style={[styles.legCard, legFieldError(i) && styles.legCardError]}>
                <View style={styles.legTop}>
                  <View style={styles.amtWrap}>
                    {mode === 'percent' ? (
                      <>
                        <TextInput
                          testID={`split-leg-${i}-percent-input`}
                          style={styles.amtInput}
                          value={i === 0 ? String(r2(total ? (master / total) * 100 : 0)) : l.pct}
                          onChangeText={(v) => setLeg(i, { pct: v.replace(/[^0-9.]/g, '') })}
                          editable={i !== 0}
                          keyboardType="decimal-pad"
                          placeholder="0"
                          placeholderTextColor={colors.muted}
                          autoFocus={focusKey === l.key}
                        />
                        <Text style={styles.amtSuffix}>%  ·  {fmtPos(amounts[i] ?? 0)}</Text>
                      </>
                    ) : (
                      <>
                        <Text style={styles.amtDollar}>$</Text>
                        <TextInput
                          testID={`split-leg-${i}-amount-input`}
                          style={styles.amtInput}
                          value={i === 0 || mode === 'equal' ? (amounts[i] ?? 0).toFixed(2) : l.amt}
                          onChangeText={(v) => setLeg(i, { amt: v.replace(/[^0-9.]/g, '') })}
                          editable={i !== 0 && mode === 'specific'}
                          keyboardType="decimal-pad"
                          placeholder="0.00"
                          placeholderTextColor={colors.muted}
                          autoFocus={focusKey === l.key}
                        />
                      </>
                    )}
                  </View>
                  {i === 0 ? (
                    <View style={styles.masterBadge}><Text style={styles.masterBadgeText}>REMAINDER</Text></View>
                  ) : (
                    <Pressable testID={`split-leg-${i}-remove-button`} hitSlop={10} onPress={() => removeLeg(i)} style={({ pressed }) => pressed && { opacity: 0.5 }}>
                      <Text style={styles.legRemove}>✕</Text>
                    </Pressable>
                  )}
                </View>
                <MutationFieldError error={legFieldError(i)} testID={`split-leg-${i}-error`} />

                <Pressable testID={`split-leg-${i}-category-picker`} style={[styles.legField, legFieldError(i) && styles.legFieldError]} onPress={() => setCatPick(i)}>
                  <Text style={styles.legFieldLabel}>Category</Text>
                  <Text style={[styles.legFieldValue, !l.catName && { color: colors.muted }]} numberOfLines={1}>{l.catName || 'Choose'}</Text>
                </Pressable>

                <View style={styles.legField}>
                  <Text style={styles.legFieldLabel}>Name</Text>
                  <TextInput
                    testID={`split-leg-${i}-name-input`}
                    style={styles.legFieldInput}
                    value={l.name}
                    onChangeText={(v) => setLeg(i, { name: v })}
                    placeholder={d.payee || 'Optional'}
                    placeholderTextColor={colors.muted}
                  />
                </View>

                {l.showNote ? (
                  <View style={styles.legField}>
                    <Text style={styles.legFieldLabel}>Note</Text>
                    <TextInput
                      testID={`split-leg-${i}-note-input`}
                      style={styles.legFieldInput}
                      value={l.notes}
                      onChangeText={(v) => setLeg(i, { notes: v })}
                      placeholder="Add a note"
                      placeholderTextColor={colors.muted}
                    />
                  </View>
                ) : (
                  <Pressable testID={`split-leg-${i}-add-note-button`} onPress={() => setLeg(i, { showNote: true })} style={({ pressed }) => [styles.addNote, pressed && { opacity: 0.6 }]}>
                    <Text style={styles.addNoteText}>+ add note</Text>
                  </Pressable>
                )}
              </View>
            ))}

            <Pressable testID="split-add-leg-button" onPress={addLeg} style={({ pressed }) => [styles.addSplit, pressed && { opacity: 0.85 }]}>
              <Text style={styles.addSplitText}>Add Split</Text>
            </Pressable>

            {!balanced || !allPositive ? (
              <Text style={styles.warn}>
                {!allPositive ? 'Each split must be greater than $0.' : `Splits must add up to ${fmtPos(total)}.`}
              </Text>
            ) : null}

            {d.isSplit ? (
              <Pressable testID="split-unsplit-button" onPress={doUnsplit} disabled={mutationLocked} style={({ pressed }) => [styles.unsplitBtn, pressed && { opacity: 0.7 }]}>
                <Text style={styles.unsplitText}>{unsplitAction.isLocked ? 'Removing…' : 'Remove split'}</Text>
              </Pressable>
            ) : null}
          </>
        )}
      </ScrollView>

      <Modal visible={modePick} transparent animationType="fade" onRequestClose={() => setModePick(false)}>
        <Pressable style={styles.modalBg} onPress={() => setModePick(false)}>
          <View testID="split-mode-sheet" style={[styles.sheet, { paddingBottom: insets.bottom + 16 }]}>
            <Text style={styles.sheetTitle}>Split method</Text>
            {(['equal', 'specific', 'percent'] as Mode[]).map((m) => (
              <Pressable testID={`split-mode-${m}${mode === m ? '-selected' : ''}`} key={m} style={({ pressed }) => [styles.modeOption, pressed && { opacity: 0.6 }]} onPress={() => changeMode(m)}>
                <Text style={styles.modeOptionText}>{MODE_LABEL[m]}</Text>
                {mode === m ? <Text style={styles.modeCheck}>✓</Text> : null}
              </Pressable>
            ))}
          </View>
        </Pressable>
      </Modal>

      <Modal visible={catPick !== null} transparent animationType="slide" onRequestClose={() => setCatPick(null)}>
        <Pressable style={styles.modalBg} onPress={() => setCatPick(null)}>
          <View testID="split-category-sheet" style={[styles.sheet, { paddingBottom: insets.bottom + 16 }]}>
            <Text style={styles.sheetTitle}>Category for this split</Text>
            <FlatList
              data={categories.data ?? []}
              keyExtractor={(c) => c.id}
              style={{ maxHeight: 420 }}
              keyboardShouldPersistTaps="handled"
              renderItem={({ item }) => (
                <Pressable testID={`split-category-option-${item.id}`} style={({ pressed }) => [styles.catOption, pressed && { opacity: 0.6 }]} onPress={() => pickCat(item.id, item.name)}>
                  <Text style={styles.catOptionText}>{item.name}</Text>
                  <Text style={styles.catOptionGroup}>{item.group}</Text>
                </Pressable>
              )}
            />
          </View>
        </Pressable>
      </Modal>
    </KeyboardAvoidingView>
  );
}

const styles = StyleSheet.create({
  loading: { color: colors.muted, fontSize: 14, textAlign: 'center', marginTop: 40 },
  hero: { alignItems: 'center', marginBottom: 18 },
  heroPayee: { color: colors.muted, fontSize: 13, fontWeight: '600' },
  heroAmount: { color: colors.text, fontSize: 34, fontWeight: '800', letterSpacing: -1, marginTop: 2 },
  modeRow: { flexDirection: 'row', alignItems: 'center', justifyContent: 'space-between', marginBottom: 14 },
  modeLead: { color: colors.text, fontSize: 15, fontWeight: '600' },
  modePill: { flexDirection: 'row', alignItems: 'center', gap: 6, backgroundColor: colors.surface2, borderRadius: 10, paddingHorizontal: 12, paddingVertical: 8 },
  modePillText: { color: colors.accentLight, fontSize: 14, fontWeight: '700' },
  modeCaret: { color: colors.accentLight, fontSize: 12, fontWeight: '700' },
  legCard: { backgroundColor: colors.surface, borderRadius: 14, padding: 14, marginBottom: 12, borderWidth: StyleSheet.hairlineWidth, borderColor: colors.border },
  legCardError: { borderColor: '#ff6b6b' },
  legTop: { flexDirection: 'row', alignItems: 'center', justifyContent: 'space-between', marginBottom: 10 },
  amtWrap: { flexDirection: 'row', alignItems: 'center', flex: 1 },
  amtDollar: { color: colors.text, fontSize: 22, fontWeight: '700', marginRight: 2 },
  amtInput: { color: colors.text, fontSize: 22, fontWeight: '700', minWidth: 80, paddingVertical: 2 },
  amtSuffix: { color: colors.muted, fontSize: 13, marginLeft: 6 },
  masterBadge: { backgroundColor: colors.surface2, borderRadius: 6, paddingHorizontal: 7, paddingVertical: 3 },
  masterBadgeText: { color: colors.muted, fontSize: 9, fontWeight: '800', letterSpacing: 0.5 },
  legRemove: { color: colors.red, fontSize: 16, fontWeight: '700', paddingHorizontal: 4 },
  legField: { flexDirection: 'row', alignItems: 'center', justifyContent: 'space-between', gap: 12, paddingVertical: 9, borderTopWidth: StyleSheet.hairlineWidth, borderTopColor: colors.border },
  legFieldError: { backgroundColor: 'rgba(255, 107, 107, 0.08)' },
  legFieldLabel: { color: colors.muted, fontSize: 13 },
  legFieldValue: { color: colors.accentLight, fontSize: 14, fontWeight: '600', flexShrink: 1, textAlign: 'right' },
  legFieldInput: { color: colors.text, fontSize: 14, flex: 1, textAlign: 'right', paddingVertical: 2 },
  addNote: { paddingTop: 9, borderTopWidth: StyleSheet.hairlineWidth, borderTopColor: colors.border },
  addNoteText: { color: colors.muted, fontSize: 13, fontWeight: '600' },
  addSplit: { backgroundColor: colors.surface2, borderRadius: 12, paddingVertical: 13, alignItems: 'center', marginTop: 2 },
  addSplitText: { color: colors.text, fontSize: 15, fontWeight: '700' },
  warn: { color: colors.red, fontSize: 13, textAlign: 'center', marginTop: 14 },
  pendingWarn: { backgroundColor: 'rgba(234,179,8,0.12)', borderColor: colors.yellow, borderWidth: 1, borderRadius: 12, padding: 12, marginBottom: 14 },
  pendingWarnTitle: { color: colors.yellow, fontSize: 13, fontWeight: '800', marginBottom: 4 },
  pendingWarnBody: { color: colors.text, fontSize: 12, lineHeight: 17, opacity: 0.9 },
  unsplitBtn: { marginTop: 22, borderWidth: 1, borderColor: colors.red, borderRadius: 12, paddingVertical: 12, alignItems: 'center' },
  unsplitText: { color: colors.red, fontSize: 14, fontWeight: '700' },
  topBar: { flexDirection: 'row', alignItems: 'center', justifyContent: 'space-between', paddingHorizontal: 16, paddingBottom: 12, borderBottomWidth: StyleSheet.hairlineWidth, borderBottomColor: colors.border },
  topCancel: { color: colors.accentLight, fontSize: 16, fontWeight: '600' },
  topTitle: { color: colors.text, fontSize: 16, fontWeight: '700' },
  topSave: { color: colors.accentLight, fontSize: 16, fontWeight: '700' },
  modalBg: { flex: 1, backgroundColor: 'rgba(0,0,0,0.6)', justifyContent: 'flex-end' },
  sheet: { backgroundColor: colors.surface, borderTopLeftRadius: 18, borderTopRightRadius: 18, padding: 16 },
  sheetTitle: { color: colors.text, fontSize: 15, fontWeight: '700', marginBottom: 12 },
  modeOption: { flexDirection: 'row', alignItems: 'center', justifyContent: 'space-between', paddingVertical: 14, borderBottomWidth: StyleSheet.hairlineWidth, borderBottomColor: colors.border },
  modeOptionText: { color: colors.text, fontSize: 15 },
  modeCheck: { color: colors.accentLight, fontSize: 16, fontWeight: '800' },
  catOption: { flexDirection: 'row', justifyContent: 'space-between', alignItems: 'center', paddingVertical: 12, borderBottomWidth: StyleSheet.hairlineWidth, borderBottomColor: colors.border },
  catOptionText: { color: colors.text, fontSize: 15 },
  catOptionGroup: { color: colors.muted, fontSize: 12 },
});
