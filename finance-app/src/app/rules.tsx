import React, { useState } from 'react';
import { Alert, FlatList, KeyboardAvoidingView, Modal, Platform, Pressable, ScrollView, StyleSheet, Text, TextInput, View } from 'react-native';
import { Stack } from 'expo-router';
import { useSafeAreaInsets } from 'react-native-safe-area-context';
import { useApplyRules, useCategories, useDeleteRule, useRules, useSaveRule } from '@/api/hooks/finance.hooks';
import { Card, CardTitle } from '@/components/ui';
import { SkeletonList } from '@/components/skeleton';
import { haptics } from '@/lib/haptics';
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

  const canAdd = match.trim().length >= 2 && !!catId && !saveRule.isPending;

  const add = () => {
    if (!canAdd) return;
    saveRule.mutate(
      { match: match.trim(), categoryId: catId, categoryName: catName },
      {
        onSuccess: (r) => {
          setMatch('');
          setCatId('');
          setCatName('');
          Alert.alert('Rule added', `“${match.trim()}” → ${catName}.` + (r?.applied ? `\n\nApplied to ${r.applied} past transaction${r.applied === 1 ? '' : 's'}.` : ''));
        },
        onError: (e) => Alert.alert('Could not add rule', e.error || 'Please try again.'),
      }
    );
  };

  const remove = (id: string, label: string) =>
    Alert.alert('Delete rule?', `Stop auto-categorizing “${label}”? Existing transactions keep their category.`, [
      { text: 'Cancel', style: 'cancel' },
      { text: 'Delete', style: 'destructive', onPress: () => deleteRule.mutate({ id }) },
    ]);

  const applyAll = () => {
    haptics.tap();
    applyRules.mutate(undefined, {
      onSuccess: (r) => Alert.alert('Rules applied', r?.applied ? `Categorized ${r.applied} transaction${r.applied === 1 ? '' : 's'}.` : 'No uncategorized transactions matched.'),
      onError: (e) => Alert.alert('Could not apply rules', e.error || 'Please try again.'),
    });
  };

  const list = rules.data?.rules ?? [];
  const catalog = rules.data?.catalog ?? [];

  return (
    <ScrollView style={styles.root} contentContainerStyle={{ padding: 16, paddingBottom: insets.bottom + 32 }} keyboardShouldPersistTaps="handled">
      <Stack.Screen options={{ title: 'Rules' }} />

      <Text style={styles.intro}>Automatically categorize transactions whose payee contains your text. Rules apply to matching uncategorized transactions now and to new ones as they sync.</Text>

      <CardTitle style={{ marginTop: 8 }}>New rule</CardTitle>
      <Card>
        <Text style={styles.label}>When payee contains</Text>
        <TextInput
          style={styles.input}
          value={match}
          onChangeText={setMatch}
          placeholder="e.g. Spotify"
          placeholderTextColor={colors.muted}
          autoCapitalize="none"
          autoCorrect={false}
        />
        <Text style={[styles.label, { marginTop: 12 }]}>Set category to</Text>
        <Pressable style={({ pressed }) => [styles.pickRow, pressed && { opacity: 0.7 }]} onPress={() => { haptics.tap(); setPicking(true); }}>
          <Text style={[styles.pickValue, !catName && { color: colors.muted }]}>{catName || 'Choose a category'}</Text>
          <Text style={styles.pickArrow}>›</Text>
        </Pressable>
        <Pressable style={({ pressed }) => [styles.addBtn, !canAdd && { opacity: 0.4 }, pressed && { opacity: 0.85 }]} onPress={add} disabled={!canAdd}>
          <Text style={styles.addText}>{saveRule.isPending ? 'Saving…' : 'Add rule'}</Text>
        </Pressable>
      </Card>

      <View style={styles.listHeader}>
        <CardTitle style={{ marginTop: 0 }}>Your rules{list.length ? ` (${list.length})` : ''}</CardTitle>
        {list.length ? (
          <Pressable onPress={applyAll} disabled={applyRules.isPending} hitSlop={8} style={({ pressed }) => pressed && { opacity: 0.6 }}>
            <Text style={styles.applyLink}>{applyRules.isPending ? 'Applying…' : 'Apply now'}</Text>
          </Pressable>
        ) : null}
      </View>

      {rules.isLoading && !rules.data ? (
        <SkeletonList rows={4} />
      ) : list.length ? (
        <Card style={styles.list}>
          {list.map((r, i) => (
            <View key={r.id} style={[styles.ruleRow, i === list.length - 1 && { borderBottomWidth: 0 }]}>
              <View style={{ flex: 1, minWidth: 0 }}>
                <Text style={styles.ruleMatch} numberOfLines={1}>“{r.match}”</Text>
                <Text style={styles.ruleCat} numberOfLines={1}>→ {r.categoryName || 'category'}</Text>
              </View>
              <Pressable hitSlop={8} onPress={() => remove(r.id, r.match)} disabled={deleteRule.isPending} style={({ pressed }) => pressed && { opacity: 0.5 }}>
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
            <View style={[styles.sheet, { paddingBottom: insets.bottom + 16 }]}>
              <Text style={styles.sheetTitle}>Choose category</Text>
              <FlatList
                data={categories.data ?? []}
                keyExtractor={(c) => c.id}
                style={{ maxHeight: 420 }}
                keyboardShouldPersistTaps="handled"
                renderItem={({ item }) => (
                  <Pressable
                    style={({ pressed }) => [styles.catOption, pressed && { opacity: 0.6 }]}
                    onPress={() => { setCatId(item.id); setCatName(item.name); setPicking(false); }}
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
  input: { backgroundColor: colors.surface2, borderColor: colors.border, borderWidth: 1, borderRadius: 8, color: colors.text, paddingHorizontal: 12, paddingVertical: 10, fontSize: 15 },
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
