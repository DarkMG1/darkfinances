import React, { useMemo, useRef, useState } from 'react';
import { Alert, Pressable, ScrollView, StyleSheet, Text, TextInput, View } from 'react-native';
import { useSafeAreaInsets } from 'react-native-safe-area-context';
import { useAccounts, useDeleteGoal, useGoals, useSaveGoal } from '@/api/hooks/finance.hooks';
import { Goal } from '@/api/generated/types';
import {
  MutationFieldError,
  MutationFormBanner,
  MutationLiveRegion,
  MutationSheet,
  MutationSubmitButton,
} from '@/components/mutation-form';
import { PushScreen } from '@/components/screen';
import { Card, EmptyState, ErrorState } from '@/components/ui';
import { SkeletonList } from '@/components/skeleton';
import { ProgressBar } from '@/components/charts';
import { useMutationAction } from '@/hooks/useMutationAction';
import { useMutationForm } from '@/hooks/useMutationForm';
import { haptics } from '@/lib/haptics';
import {
  collectFieldErrors,
  parseStrictMoneyDollars,
  validateMonthOnlyField,
  validateMoneyField,
  validateRequiredText,
} from '@/lib/mutation-form-validation';
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
  const nameRef = useRef<TextInput>(null);
  const targetRef = useRef<TextInput>(null);
  const deadlineRef = useRef<TextInput>(null);

  const fields = useMemo(() => ({ name, target, current, deadline, accountId, editingId: editing?.id }), [accountId, current, deadline, editing?.id, name, target]);

  const form = useMutationForm({
    formId: editing?.isNew ? 'goals-new' : `goals-edit-${editing?.id ?? 'none'}`,
    fields,
    setFields: () => {},
    persistDraft: true,
    mutation: saveGoal,
    mutationLabel: 'Save goal',
    fieldOrder: ['name', 'target', 'current', 'deadline'],
    fieldRefs: { name: nameRef, target: targetRef, deadline: deadlineRef },
    onSuccessClose: () => setEditing(null),
    onRefetch: () => goals.refetch(),
    validate: (f) => {
      const currentVal = parseStrictMoneyDollars(String(f.current), { allowZero: true });
      return collectFieldErrors({
        name: validateRequiredText(f.name, 'Name'),
        target: validateMoneyField(f.target, { label: 'Target amount' }),
        current: currentVal == null && String(f.current).trim() !== '0'
          ? 'Allocated amount must use whole cents.'
          : currentVal != null && currentVal < 0
            ? 'Allocated amount cannot be negative.'
            : null,
        deadline: validateMonthOnlyField(String(f.deadline), 'Deadline'),
      });
    },
    buildVariables: (f) => ({
      id: f.editingId as string | undefined,
      name: String(f.name).trim(),
      target: parseStrictMoneyDollars(String(f.target))!,
      accountId: f.accountId as string | null,
      current: parseStrictMoneyDollars(String(f.current), { allowZero: true }) ?? 0,
      deadline: String(f.deadline).trim() || null,
    }),
  });

  const deleteAction = useMutationAction({
    mutation: deleteGoal,
    mutationLabel: 'Delete goal',
    onSuccess: () => setEditing(null),
  });

  const openNew = () => {
    form.clearErrors();
    setName('');
    setTarget('');
    setCurrent('0');
    setDeadline('');
    setAccountId(null);
    setEditing({ isNew: true });
  };
  const openEdit = (g: Goal) => {
    form.clearErrors();
    setName(g.name);
    setTarget(String(g.target));
    setCurrent(String(g.current));
    setDeadline(g.deadline ?? '');
    setAccountId(g.accountId ?? null);
    setEditing(g);
  };

  const closeSheet = () => {
    if (!form.requestDismiss()) return;
    setEditing(null);
  };

  const remove = () => {
    if (!editing?.id || deleteAction.isLocked) return;
    haptics.warning();
    Alert.alert('Delete goal?', `Remove “${editing.name || 'this goal'}”?`, [
      { text: 'Cancel', style: 'cancel' },
      {
        text: 'Delete',
        style: 'destructive',
        onPress: () => deleteAction.run({ id: editing.id! }),
      },
    ]);
  };

  return (
    <PushScreen testID="goals-screen" onRefresh={goals.refetch}>
      <MutationLiveRegion message={form.announce || deleteAction.announce} />
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
                  {g.feasibility?.overAllocated ? (
                    <Text style={styles.warn}>Advisory: allocations exceed linked account balance by {fmtPos(g.feasibility.overAllocatedCents / 100)}</Text>
                  ) : null}
                  {g.availableInAccount != null ? (
                    <Text style={styles.sub}>{fmtPos(g.availableInAccount)} available in linked account (advisory capacity)</Text>
                  ) : null}
                  {g.monthlyRequired != null ? <Text style={styles.sub}>{fmtPos(g.monthlyRequired)}/month advisory pace through {g.deadline}</Text> : null}
                </Card>
              </Pressable>
            ))
          )}

          <Pressable testID="goals-add-button" style={({ pressed }) => [styles.addBtn, pressed && { opacity: 0.7 }]} onPress={openNew}>
            <Text style={styles.addText}>+ Add goal</Text>
          </Pressable>
        </>
      )}

      <MutationSheet
        visible={!!editing}
        title={editing?.isNew ? 'New goal' : 'Edit goal'}
        testID="goals-edit-sheet"
        bottomInset={insets.bottom}
        canDismiss={form.canDismiss && !deleteAction.isLocked}
        onRequestClose={closeSheet}
      >
        <MutationFormBanner outcome={form.outcome ?? deleteAction.outcome} onRetry={() => { form.retry(); deleteAction.retry(); }} onRefetch={() => goals.refetch()} />

        <Text style={[styles.field, form.getFieldError('name') && styles.fieldErrorLabel]}>Name</Text>
        <TextInput
          testID="goals-name-input"
          ref={nameRef}
          style={[styles.input, form.getFieldError('name') && styles.inputError]}
          value={name}
          onChangeText={setName}
          placeholder="Emergency fund"
          placeholderTextColor={colors.muted}
          accessibilityLabel="Goal name"
          accessibilityHint={form.getFieldError('name') ? `Error: ${form.getFieldError('name')}` : undefined}
        />
        <MutationFieldError error={form.getFieldError('name')} testID="goals-name-error" />

        <Text style={[styles.field, form.getFieldError('target') && styles.fieldErrorLabel]}>Target amount</Text>
        <TextInput
          testID="goals-target-input"
          ref={targetRef}
          style={[styles.input, form.getFieldError('target') && styles.inputError]}
          value={target}
          onChangeText={setTarget}
          placeholder="5000"
          placeholderTextColor={colors.muted}
          keyboardType="decimal-pad"
          accessibilityLabel="Target amount"
        />
        <MutationFieldError error={form.getFieldError('target')} testID="goals-target-error" />

        <Text style={[styles.field, form.getFieldError('current') && styles.fieldErrorLabel]}>Allocated to this goal</Text>
        <TextInput
          testID="goals-current-input"
          style={[styles.input, form.getFieldError('current') && styles.inputError]}
          value={current}
          onChangeText={setCurrent}
          placeholder="0"
          placeholderTextColor={colors.muted}
          keyboardType="decimal-pad"
          accessibilityLabel="Allocated amount"
        />
        <MutationFieldError error={form.getFieldError('current')} testID="goals-current-error" />
        {accountId ? <Text style={styles.help}>The linked account limits total allocations; its full balance is not counted separately for every goal.</Text> : null}

        <Text style={[styles.field, form.getFieldError('deadline') && styles.fieldErrorLabel]}>Deadline (optional)</Text>
        <TextInput
          testID="goals-deadline-input"
          ref={deadlineRef}
          style={[styles.input, form.getFieldError('deadline') && styles.inputError]}
          value={deadline}
          onChangeText={setDeadline}
          placeholder="YYYY-MM"
          placeholderTextColor={colors.muted}
          autoCapitalize="none"
          accessibilityLabel="Deadline"
        />
        <MutationFieldError error={form.getFieldError('deadline')} testID="goals-deadline-error" />

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

        <MutationSubmitButton
          testID="goals-save-button"
          label="Save"
          pendingLabel="Saving…"
          onPress={form.submit}
          disabled={form.isLocked}
        />
        {!editing?.isNew ? (
          <Pressable testID="goals-delete-button" style={({ pressed }) => [styles.deleteBtn, pressed && { opacity: 0.7 }]} onPress={remove} disabled={deleteAction.isLocked}>
            <Text style={styles.deleteText}>{deleteAction.isLocked ? 'Deleting…' : 'Delete goal'}</Text>
          </Pressable>
        ) : null}
      </MutationSheet>
    </PushScreen>
  );
}

const styles = StyleSheet.create({
  head: { flexDirection: 'row', justifyContent: 'space-between', alignItems: 'center', marginBottom: 10 },
  name: { color: colors.text, fontSize: 15, fontWeight: '700' },
  pct: { color: colors.accentLight, fontSize: 14, fontWeight: '700' },
  sub: { color: colors.muted, fontSize: 12, marginTop: 8 },
  addBtn: { borderWidth: 1, borderColor: colors.accent, borderStyle: 'dashed', borderRadius: 12, padding: 14, alignItems: 'center', marginTop: 4, minHeight: 44, justifyContent: 'center' },
  addText: { color: colors.accentLight, fontSize: 15, fontWeight: '600' },
  field: { color: colors.muted, fontSize: 12, fontWeight: '600', marginTop: 12, marginBottom: 6 },
  fieldErrorLabel: { color: '#ff6b6b' },
  input: { backgroundColor: colors.surface2, borderColor: colors.border, borderWidth: 1, borderRadius: 10, color: colors.text, paddingHorizontal: 12, paddingVertical: 10, fontSize: 15, minHeight: 44 },
  inputError: { borderColor: '#ff6b6b' },
  help: { color: colors.muted, fontSize: 11, lineHeight: 16, marginTop: 6 },
  warn: { color: colors.yellow, fontSize: 12, marginTop: 8, lineHeight: 16 },
  chips: { gap: 8, paddingVertical: 2 },
  chip: { paddingHorizontal: 12, paddingVertical: 8, borderRadius: 16, borderWidth: 1, borderColor: colors.border, backgroundColor: colors.surface2, maxWidth: 160, minHeight: 44, justifyContent: 'center' },
  chipActive: { backgroundColor: colors.accent, borderColor: colors.accent },
  chipText: { color: colors.muted, fontSize: 12, fontWeight: '600' },
  chipTextActive: { color: '#fff' },
  deleteBtn: { padding: 12, alignItems: 'center', marginTop: 6, minHeight: 44, justifyContent: 'center' },
  deleteText: { color: colors.red, fontSize: 14, fontWeight: '600' },
});
