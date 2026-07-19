import React, { useCallback, useMemo, useRef, useState } from 'react';
import { FlatList, KeyboardAvoidingView, Modal, Platform, Pressable, ScrollView, StyleSheet, Text, TextInput, View } from 'react-native';
import { Stack } from 'expo-router';
import { useSafeAreaInsets } from 'react-native-safe-area-context';
import { useApplyRules, useCategories, useDeleteRule, useRules, useSaveRule } from '@/api/hooks/finance.hooks';
import {
  MutationFieldError,
  MutationFormBanner,
  MutationLiveRegion,
  MutationSubmitButton,
} from '@/components/mutation-form';
import { Card, CardTitle, ErrorState } from '@/components/ui';
import { QueryRefetchBanner } from '@/components/query-refetch-banner';
import { SkeletonList } from '@/components/skeleton';
import { resolveQueryDisplay } from '@/components/query-display';
import { useMutationAction } from '@/hooks/useMutationAction';
import { useMutationBannerCoordinator } from '@/hooks/useMutationBannerCoordinator';
import { useMutationForm } from '@/hooks/useMutationForm';
import { useMutationScreenAdmission } from '@/hooks/useMutationScreenAdmission';
import { haptics } from '@/lib/haptics';
import { collectFieldErrors } from '@/lib/mutation-form-validation';
import { colors } from '@/theme/colors';

export default function Rules() {
  const insets = useSafeAreaInsets();
  const rules = useRules();
  const categories = useCategories();
  const saveRule = useSaveRule();
  const deleteRule = useDeleteRule();
  const applyRules = useApplyRules();

  const [match, setMatch] = useState('');
  const [catId, setCatId] = useState('');
  const [catName, setCatName] = useState('');
  const [picking, setPicking] = useState(false);
  const matchRef = useRef<TextInput>(null);
  const admissionRef = useMutationScreenAdmission();

  const fields = useMemo(() => ({ match, categoryId: catId, categoryName: catName }), [catId, catName, match]);

  const applyFields = useCallback((updater: React.SetStateAction<typeof fields>) => {
    const prev = fields;
    const next = typeof updater === 'function' ? updater(prev) : updater;
    if (next.match !== undefined) setMatch(String(next.match));
    if (next.categoryId !== undefined) setCatId(String(next.categoryId));
    if (next.categoryName !== undefined) setCatName(String(next.categoryName));
  }, [fields]);

  const addForm = useMutationForm({
    formId: 'rules-add',
    fields,
    setFields: applyFields,
    persistDraft: false,
    mutation: saveRule,
    mutationLabel: 'Add rule',
    fieldOrder: ['match', 'categoryId'],
    fieldRefs: { match: matchRef },
    admissionRef,
    onRefetch: () => rules.refetch(),
    validate: (f) => collectFieldErrors({
      match: String(f.match).trim().length >= 2 ? null : 'Enter at least two characters to match.',
      categoryId: f.categoryId ? null : 'Choose a category.',
    }),
    buildVariables: (f) => ({
      match: String(f.match).trim(),
      categoryId: String(f.categoryId),
      categoryName: String(f.categoryName ?? ''),
    }),
    onSuccessClose: () => {
      setMatch('');
      setCatId('');
      setCatName('');
    },
  });

  const deleteAction = useMutationAction({ mutation: deleteRule, mutationLabel: 'Delete rule', admissionRef, onActivate: () => addForm.clearErrors(), onSuccess: () => rules.refetch() });
  const applyAction = useMutationAction({ mutation: applyRules, mutationLabel: 'Apply rules', admissionRef, onActivate: () => addForm.clearErrors(), onSuccess: () => rules.refetch() });

  const banner = useMutationBannerCoordinator(useMemo(() => [
    { key: 'add', outcome: addForm.outcome, retry: addForm.retry, announce: addForm.announce, isLocked: addForm.isLocked, activitySeq: addForm.activitySeq },
    { key: 'delete', outcome: deleteAction.outcome, retry: deleteAction.retry, announce: deleteAction.announce, isLocked: deleteAction.isLocked, activitySeq: deleteAction.activitySeq },
    { key: 'apply', outcome: applyAction.outcome, retry: applyAction.retry, announce: applyAction.announce, isLocked: applyAction.isLocked, activitySeq: applyAction.activitySeq },
  ], [
    addForm.activitySeq, addForm.announce, addForm.isLocked, addForm.outcome, addForm.retry,
    applyAction.activitySeq, applyAction.announce, applyAction.isLocked, applyAction.outcome, applyAction.retry,
    deleteAction.activitySeq, deleteAction.announce, deleteAction.isLocked, deleteAction.outcome, deleteAction.retry,
  ]));

  const inputLocked = banner.isLocked;

  const remove = (id: string) => {
    if (banner.isLocked) return;
    deleteAction.run({ id });
  };

  const list = rules.data?.rules ?? [];
  const catalog = rules.data?.catalog ?? [];
  const rulesDisplay = resolveQueryDisplay(rules);

  return (
    <ScrollView testID="rules-screen" style={styles.root} contentContainerStyle={{ padding: 16, paddingBottom: insets.bottom + 32 }} keyboardShouldPersistTaps="handled">
      <Stack.Screen options={{ title: 'Rules' }} />
      <MutationLiveRegion message={banner.announce} />
      <MutationFormBanner
        outcome={banner.outcome}
        onRetry={banner.retry}
        onRefetch={() => rules.refetch()}
      />

      {rulesDisplay.refetchError ? (
        <QueryRefetchBanner onRetry={() => rules.refetch()} testID="rules-refetch-banner" />
      ) : null}

      <Text style={styles.intro}>Automatically categorize transactions whose payee contains your text. Rules apply to matching uncategorized transactions now and to new ones as they sync.</Text>

      <CardTitle style={{ marginTop: 8 }}>New rule</CardTitle>
      <Card>
        <Text style={styles.label}>When payee contains</Text>
        <TextInput
          testID="rules-match-input"
          ref={matchRef}
          style={[styles.input, addForm.getFieldError('match') && styles.inputError]}
          value={match}
          onChangeText={setMatch}
          editable={!inputLocked}
          placeholder="e.g. Spotify"
          placeholderTextColor={colors.muted}
          autoCapitalize="none"
          autoCorrect={false}
          accessibilityLabel="When payee contains"
        />
        <MutationFieldError error={addForm.getFieldError('match')} testID="rules-match-error" />
        <Text style={[styles.label, { marginTop: 12 }]}>Set category to</Text>
        <Pressable testID="rules-category-picker" style={({ pressed }) => [styles.pickRow, pressed && !inputLocked && { opacity: 0.7 }, inputLocked && { opacity: 0.5 }]} onPress={() => { if (inputLocked) return; haptics.tap(); setPicking(true); }} disabled={inputLocked} accessibilityState={{ disabled: inputLocked }}>
          <Text style={[styles.pickValue, !catName && { color: colors.muted }]}>{catName || 'Choose a category'}</Text>
          <Text style={styles.pickArrow}>›</Text>
        </Pressable>
        <MutationFieldError error={addForm.getFieldError('categoryId')} testID="rules-category-error" />
        <MutationSubmitButton
          testID="rules-add-button"
          label="Add rule"
          pendingLabel="Saving…"
          onPress={addForm.submit}
          disabled={inputLocked}
        />
      </Card>

      <View style={styles.listHeader}>
        <CardTitle style={{ marginTop: 0 }}>Your rules{list.length ? ` (${list.length})` : ''}</CardTitle>
        {list.length ? (
          <Pressable testID="rules-apply-button" onPress={() => { if (inputLocked) return; haptics.tap(); applyAction.run(undefined); }} disabled={inputLocked} hitSlop={8} style={({ pressed }) => [pressed && !inputLocked && { opacity: 0.6 }, inputLocked && { opacity: 0.5 }]}>
            <Text style={styles.applyLink}>{applyAction.isLocked ? 'Applying…' : 'Apply now'}</Text>
          </Pressable>
        ) : null}
      </View>

      {rulesDisplay.initialLoad ? (
        <SkeletonList rows={4} />
      ) : rulesDisplay.fatalError ? (
        <ErrorState error={rulesDisplay.errorMessage} onRetry={() => rules.refetch()} />
      ) : list.length ? (
        <Card style={styles.list}>
          {list.map((r, i) => (
            <View key={r.id} testID={`rules-row-${r.id}`} style={[styles.ruleRow, i === list.length - 1 && { borderBottomWidth: 0 }]}>
              <View style={{ flex: 1, minWidth: 0 }}>
                <Text style={styles.ruleMatch} numberOfLines={1}>“{r.match}”</Text>
                <Text style={styles.ruleCat} numberOfLines={1}>→ {r.categoryName || 'category'}</Text>
              </View>
              <Pressable testID={`rules-delete-${r.id}`} hitSlop={8} onPress={() => remove(r.id)} disabled={inputLocked} style={({ pressed }) => [pressed && !inputLocked && { opacity: 0.5 }, inputLocked && { opacity: 0.4 }]}>
                <Text style={styles.del}>Delete</Text>
              </Pressable>
            </View>
          ))}
        </Card>
      ) : (
        <Card>
          <Text style={styles.empty}>No rules yet. Add one above, or use “Auto-categorize” on any transaction.</Text>
        </Card>
      )}

      {catalog.length ? (
        <>
          <CardTitle style={{ marginTop: 24 }}>Built-in auto-categorization</CardTitle>
          <Text style={styles.intro}>Applied automatically to anything your own rules don’t cover, matched to your closest category.</Text>
          <Card style={styles.builtinList}>
            {catalog.map((c, i) => (
              <View key={c.label} style={[styles.ruleRow, i === catalog.length - 1 && { borderBottomWidth: 0 }]}>
                <View style={{ flex: 1, minWidth: 0 }}>
                  <Text style={styles.ruleMatch} numberOfLines={2}>{c.label}</Text>
                </View>
                <Text style={styles.builtinType}>{c.type}</Text>
              </View>
            ))}
          </Card>
        </>
      ) : null}

      <Modal visible={picking} animationType="slide" transparent onRequestClose={() => setPicking(false)}>
        <KeyboardAvoidingView behavior={Platform.OS === 'ios' ? 'padding' : 'height'} style={{ flex: 1 }}>
          <Pressable style={styles.modalBg} onPress={() => setPicking(false)}>
            <View testID="rules-category-sheet" style={[styles.sheet, { paddingBottom: insets.bottom + 16 }]}>
              <Text style={styles.sheetTitle}>Choose category</Text>
              <FlatList
                data={categories.data ?? []}
                keyExtractor={(c) => c.id}
                style={{ maxHeight: 420 }}
                keyboardShouldPersistTaps="handled"
                renderItem={({ item }) => (
                  <Pressable
                    testID={`rules-category-option-${item.id}`}
                    style={({ pressed }) => [styles.catOption, pressed && { opacity: 0.6 }]}
                    onPress={() => { if (inputLocked) return; setCatId(item.id); setCatName(item.name); setPicking(false); }}
                    disabled={inputLocked}
                  >
                    <Text style={styles.catOptionText}>{item.name}</Text>
                    <Text style={styles.catOptionGroup}>{item.group}</Text>
                  </Pressable>
                )}
              />
            </View>
          </Pressable>
        </KeyboardAvoidingView>
      </Modal>
    </ScrollView>
  );
}

const styles = StyleSheet.create({
  root: { flex: 1, backgroundColor: colors.bg },
  intro: { color: colors.muted, fontSize: 13, lineHeight: 19 },
  label: { color: colors.muted, fontSize: 12, fontWeight: '600', marginBottom: 6, textTransform: 'uppercase', letterSpacing: 0.5 },
  input: { backgroundColor: colors.surface2, borderColor: colors.border, borderWidth: 1, borderRadius: 8, color: colors.text, paddingHorizontal: 12, paddingVertical: 10, fontSize: 15, minHeight: 44 },
  inputError: { borderColor: '#ff6b6b' },
  pickRow: { flexDirection: 'row', alignItems: 'center', justifyContent: 'space-between', backgroundColor: colors.surface2, borderColor: colors.border, borderWidth: 1, borderRadius: 8, paddingHorizontal: 12, paddingVertical: 11 },
  pickValue: { color: colors.text, fontSize: 15, flex: 1 },
  pickArrow: { color: colors.muted, fontSize: 20, fontWeight: '700' },
  addBtn: { backgroundColor: colors.accent, borderRadius: 10, paddingVertical: 12, alignItems: 'center', marginTop: 14 },
  addText: { color: '#fff', fontSize: 15, fontWeight: '700' },
  listHeader: { flexDirection: 'row', alignItems: 'flex-end', justifyContent: 'space-between', marginTop: 24, marginBottom: 4 },
  applyLink: { color: colors.accentLight, fontSize: 13, fontWeight: '700' },
  list: { paddingVertical: 2 },
  builtinList: { paddingVertical: 2, marginTop: 8 },
  ruleRow: { flexDirection: 'row', alignItems: 'center', gap: 12, paddingVertical: 12, borderBottomWidth: StyleSheet.hairlineWidth, borderBottomColor: colors.border },
  ruleMatch: { color: colors.text, fontSize: 15, fontWeight: '600' },
  ruleCat: { color: colors.muted, fontSize: 13, marginTop: 2 },
  builtinType: { color: colors.accentLight, fontSize: 12, fontWeight: '700', textTransform: 'capitalize' },
  del: { color: colors.red, fontSize: 13, fontWeight: '600' },
  empty: { color: colors.muted, fontSize: 14, lineHeight: 20 },
  modalBg: { flex: 1, backgroundColor: 'rgba(0,0,0,0.6)', justifyContent: 'flex-end' },
  sheet: { backgroundColor: colors.surface, borderTopLeftRadius: 18, borderTopRightRadius: 18, padding: 16 },
  sheetTitle: { color: colors.text, fontSize: 15, fontWeight: '700', marginBottom: 12 },
  catOption: { flexDirection: 'row', justifyContent: 'space-between', alignItems: 'center', paddingVertical: 12, borderBottomWidth: StyleSheet.hairlineWidth, borderBottomColor: colors.border },
  catOptionText: { color: colors.text, fontSize: 15 },
  catOptionGroup: { color: colors.muted, fontSize: 12 },
});
