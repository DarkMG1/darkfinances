import React, { useState } from 'react';
import { Alert, Modal, Pressable, ScrollView, StyleSheet, Text, TextInput, View } from 'react-native';
import { useSafeAreaInsets } from 'react-native-safe-area-context';
import { useAccounts, useDeleteGoal, useGoals, useSaveGoal } from '@/api/hooks/finance.hooks';
import { Goal } from '@/api/generated/types';
import { PushScreen } from '@/components/screen';
import { Card, EmptyState, ErrorState } from '@/components/ui';
import { SkeletonList } from '@/components/skeleton';
import { ProgressBar } from '@/components/charts';
import { haptics } from '@/lib/haptics';
import { colors, fmtPos } from '@/theme/colors';

type Editing = (Partial<Goal> & { isNew?: boolean }) | null;

export default function Goals() {
  const insets = useSafeAreaInsets();
  const goals = useGoals();
  const accounts = useAccounts();
  const saveGoal = useSaveGoal();
  const deleteGoal = useDeleteGoal();

  const [editing, setEditing] = useState<Editing>(null);
  const [name, setName] = useState('');
  const [target, setTarget] = useState('');
  const [current, setCurrent] = useState('');
  const [deadline, setDeadline] = useState('');
  const [accountId, setAccountId] = useState<string | null>(null);

  const openNew = () => { setName(''); setTarget(''); setCurrent('0'); setDeadline(''); setAccountId(null); setEditing({ isNew: true }); };
  const openEdit = (g: Goal) => {
    setName(g.name);
    setTarget(String(g.target));
    setCurrent(String(g.current));
    setDeadline(g.deadline ?? '');
    setAccountId(g.accountId ?? null);
    setEditing(g);
  };

  const submit = () => {
    const t = parseFloat(target);
    const saved = parseFloat(current) || 0;
    const deadlineValue = deadline.trim();
    if (!name.trim() || !(t > 0) || saved < 0) return;
    if (deadlineValue && !/^\d{4}-(0[1-9]|1[0-2])$/.test(deadlineValue)) {
      Alert.alert('Invalid deadline', 'Use YYYY-MM, for example 2027-06.');
      return;
    }
    saveGoal.mutate(
      { id: editing?.id, name: name.trim(), target: t, accountId, current: saved, deadline: deadlineValue || null },
      { onSuccess: () => setEditing(null) }
    );
  };
  const remove = () => {
    if (!editing?.id) return;
    Alert.alert('Delete goal?', `Remove “${editing.name || 'this goal'}”?`, [
      { text: 'Cancel', style: 'cancel' },
      { text: 'Delete', style: 'destructive', onPress: () => deleteGoal.mutate({ id: editing.id! }, { onSuccess: () => setEditing(null) }) },
    ]);
  };

  return (
    <PushScreen testID="goals-screen" onRefresh={goals.refetch}>
      {goals.isLoading ? (
        <SkeletonList rows={4} />
      ) : goals.isError && !goals.data ? (
        <ErrorState error={goals.error?.error} onRetry={goals.refetch} />
      ) : (
        <>
          {(goals.data ?? []).length === 0 ? (
            <EmptyState icon="target">No goals yet — add one below</EmptyState>
          ) : (
            (goals.data ?? []).map((g) => (
              <Pressable testID={`goals-row-${g.id}`} key={g.id} onPress={() => openEdit(g)} style={({ pressed }) => pressed && { opacity: 0.7 }}>
                <Card style={{ marginBottom: 12 }}>
                  <View style={styles.head}>
                    <Text style={styles.name}>{g.name}</Text>
                    <Text style={styles.pct}>{g.pct != null ? `${g.pct}%` : ''}</Text>
                  </View>
                  <ProgressBar pct={g.pct ?? 0} />
                  <Text style={styles.sub}>{fmtPos(g.current)} allocated of {fmtPos(g.target)}</Text>
                  {g.monthlyRequired != null ? <Text style={styles.sub}>{fmtPos(g.monthlyRequired)}/month needed through {g.deadline}</Text> : null}
                </Card>
              </Pressable>
            ))
          )}

          <Pressable testID="goals-add-button" style={({ pressed }) => [styles.addBtn, pressed && { opacity: 0.7 }]} onPress={openNew}>
            <Text style={styles.addText}>+ Add goal</Text>
          </Pressable>
        </>
      )}

      <Modal visible={!!editing} animationType="slide" transparent onRequestClose={() => setEditing(null)}>
        <Pressable style={styles.modalBg} onPress={() => setEditing(null)}>
          <Pressable testID="goals-edit-sheet" style={[styles.sheet, { paddingBottom: insets.bottom + 16 }]} onPress={() => {}}>
            <Text style={styles.sheetTitle}>{editing?.isNew ? 'New goal' : 'Edit goal'}</Text>

            <Text style={styles.field}>Name</Text>
            <TextInput testID="goals-name-input" style={styles.input} value={name} onChangeText={setName} placeholder="Emergency fund" placeholderTextColor={colors.muted} />

            <Text style={styles.field}>Target amount</Text>
            <TextInput testID="goals-target-input" style={styles.input} value={target} onChangeText={setTarget} placeholder="5000" placeholderTextColor={colors.muted} keyboardType="decimal-pad" />

            <Text style={styles.field}>Allocated to this goal</Text>
            <TextInput testID="goals-current-input" style={styles.input} value={current} onChangeText={setCurrent} placeholder="0" placeholderTextColor={colors.muted} keyboardType="decimal-pad" />
            {accountId ? <Text style={styles.help}>The linked account limits total allocations; its full balance is not counted separately for every goal.</Text> : null}

            <Text style={styles.field}>Deadline (optional)</Text>
            <TextInput testID="goals-deadline-input" style={styles.input} value={deadline} onChangeText={setDeadline} placeholder="YYYY-MM" placeholderTextColor={colors.muted} autoCapitalize="none" />

            <Text style={styles.field}>Track an account (optional)</Text>
            <ScrollView horizontal showsHorizontalScrollIndicator={false} contentContainerStyle={styles.chips}>
              <Pressable testID={`goals-account-manual${accountId === null ? '-selected' : ''}`} onPress={() => { haptics.tap(); setAccountId(null); }} style={[styles.chip, accountId === null && styles.chipActive]}>
                <Text style={[styles.chipText, accountId === null && styles.chipTextActive]}>Manual</Text>
              </Pressable>
              {(accounts.data ?? []).map((a) => (
                <Pressable testID={`goals-account-${a.id}${accountId === a.id ? '-selected' : ''}`} key={a.id} onPress={() => { haptics.tap(); setAccountId(a.id); }} style={[styles.chip, accountId === a.id && styles.chipActive]}>
                  <Text style={[styles.chipText, accountId === a.id && styles.chipTextActive]} numberOfLines={1}>{a.name}</Text>
                </Pressable>
              ))}
            </ScrollView>

            <Pressable testID="goals-save-button" style={({ pressed }) => [styles.saveBtn, pressed && { opacity: 0.85 }]} onPress={submit} disabled={saveGoal.isPending}>
              <Text style={styles.saveText}>{saveGoal.isPending ? 'Saving…' : 'Save'}</Text>
            </Pressable>
            {!editing?.isNew ? (
              <Pressable testID="goals-delete-button" style={({ pressed }) => [styles.deleteBtn, pressed && { opacity: 0.7 }]} onPress={remove} disabled={deleteGoal.isPending}>
                <Text style={styles.deleteText}>Delete goal</Text>
              </Pressable>
            ) : null}
          </Pressable>
        </Pressable>
      </Modal>
    </PushScreen>
  );
}

const styles = StyleSheet.create({
  head: { flexDirection: 'row', justifyContent: 'space-between', alignItems: 'center', marginBottom: 10 },
  name: { color: colors.text, fontSize: 15, fontWeight: '700' },
  pct: { color: colors.accentLight, fontSize: 14, fontWeight: '700' },
  sub: { color: colors.muted, fontSize: 12, marginTop: 8 },
  addBtn: { borderWidth: 1, borderColor: colors.accent, borderStyle: 'dashed', borderRadius: 12, padding: 14, alignItems: 'center', marginTop: 4 },
  addText: { color: colors.accentLight, fontSize: 15, fontWeight: '600' },
  modalBg: { flex: 1, backgroundColor: 'rgba(0,0,0,0.6)', justifyContent: 'flex-end' },
  sheet: { backgroundColor: colors.surface, borderTopLeftRadius: 18, borderTopRightRadius: 18, padding: 16 },
  sheetTitle: { color: colors.text, fontSize: 16, fontWeight: '700', marginBottom: 14 },
  field: { color: colors.muted, fontSize: 12, fontWeight: '600', marginTop: 12, marginBottom: 6 },
  input: { backgroundColor: colors.surface2, borderColor: colors.border, borderWidth: 1, borderRadius: 10, color: colors.text, paddingHorizontal: 12, paddingVertical: 10, fontSize: 15 },
  help: { color: colors.muted, fontSize: 11, lineHeight: 16, marginTop: 6 },
  chips: { gap: 8, paddingVertical: 2 },
  chip: { paddingHorizontal: 12, paddingVertical: 8, borderRadius: 16, borderWidth: 1, borderColor: colors.border, backgroundColor: colors.surface2, maxWidth: 160 },
  chipActive: { backgroundColor: colors.accent, borderColor: colors.accent },
  chipText: { color: colors.muted, fontSize: 12, fontWeight: '600' },
  chipTextActive: { color: '#fff' },
  saveBtn: { backgroundColor: colors.accent, borderRadius: 12, padding: 14, alignItems: 'center', marginTop: 18 },
  saveText: { color: '#fff', fontSize: 15, fontWeight: '700' },
  deleteBtn: { padding: 12, alignItems: 'center', marginTop: 6 },
  deleteText: { color: colors.red, fontSize: 14, fontWeight: '600' },
});
