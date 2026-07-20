import React, { useCallback, useMemo, useRef, useState } from 'react';
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
import { QueryScreenBody, refetchEnabledQueries } from '@/components/query-display';
import { buildGoalsRefetchQueries } from '@/lib/screen-query-display-config.js';
import { Card, EmptyState } from '@/components/ui';
import { SkeletonList } from '@/components/skeleton';
import { ProgressBar } from '@/components/charts';
import { useMutationAction } from '@/hooks/useMutationAction';
import { useMutationBannerCoordinator } from '@/hooks/useMutationBannerCoordinator';
import { useMutationForm } from '@/hooks/useMutationForm';
import { useMutationScreenAdmission } from '@/hooks/useMutationScreenAdmission';
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
  const admissionRef = useMutationScreenAdmission();

  const fields = useMemo(() => ({ name, target, current, deadline, accountId, editingId: editing?.id }), [accountId, current, deadline, editing?.id, name, target]);

  const applyFields = useCallback((updater: React.SetStateAction<typeof fields>) => {
    const prev = { name, target, current, deadline, accountId, editingId: editing?.id };
    const next = typeof updater === 'function' ? updater(prev) : updater;
    if (next.name !== undefined) setName(String(next.name));
    if (next.target !== undefined) setTarget(String(next.target));
    if (next.current !== undefined) setCurrent(String(next.current));
    if (next.deadline !== undefined) setDeadline(String(next.deadline));
    if (next.accountId !== undefined) setAccountId(next.accountId as string | null);
  }, [accountId, current, deadline, editing?.id, name, target]);

  const form = useMutationForm({
    formId: editing?.isNew ? 'goals-new' : `goals-edit-${editing?.id ?? 'none'}`,
    fields,
    setFields: applyFields,
    persistDraft: true,
    mutation: saveGoal,
    mutationLabel: 'Save goal',
    fieldOrder: ['name', 'target', 'current', 'deadline'],
    fieldRefs: { name: nameRef, target: targetRef, deadline: deadlineRef },
    admissionRef,
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
    admissionRef,
    onActivate: () => form.clearErrors(),
    onSuccess: () => {
      form.clearErrors();
      setEditing(null);
    },
  });

  const banner = useMutationBannerCoordinator(useMemo(() => [
    { key: 'form', outcome: form.outcome, retry: form.retry, announce: form.announce, isLocked: form.isLocked, activitySeq: form.activitySeq },
    { key: 'delete', outcome: deleteAction.outcome, retry: deleteAction.retry, announce: deleteAction.announce, isLocked: deleteAction.isLocked, activitySeq: deleteAction.activitySeq },
  ], [deleteAction.activitySeq, deleteAction.announce, deleteAction.isLocked, deleteAction.outcome, deleteAction.retry, form.activitySeq, form.announce, form.isLocked, form.outcome, form.retry]));

  const inputLocked = banner.isLocked;

  const openNew = () => {
    if (inputLocked) return;
    form.clearErrors();
    setName('');
    setTarget('');
    setCurrent('0');
    setDeadline('');
    setAccountId(null);
    setEditing({ isNew: true });
  };
  const openEdit = (g: Goal) => {
    if (inputLocked) return;
    form.clearErrors();
    setName(g.name);
    setTarget(String(g.target));
    setCurrent(String(g.current));
    setDeadline(g.deadline ?? '');
    setAccountId(g.accountId ?? null);
    setEditing(g);
  };

  const closeSheet = () => {
    form.requestDismiss(() => setEditing(null));
  };

  const remove = () => {
    if (!editing?.id || banner.isLocked) return;
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

  const goalsRefetchQueries = useMemo(
    () => buildGoalsRefetchQueries({ goals, accounts }),
    [accounts, goals],
  );
  const refreshGoals = () => refetchEnabledQueries(goalsRefetchQueries);

  return (
    <PushScreen testID="goals-screen" onRefresh={refreshGoals}>
      <MutationLiveRegion message={banner.announce} />
      <MutationFormBanner outcome={banner.outcome} onRetry={banner.retry} onRefetch={() => goals.refetch()} />
      <QueryScreenBody
        query={goals}
        compoundRefetchQueries={goalsRefetchQueries}
        refetchBannerTestID="goals-refetch-banner"
        onRetry={refreshGoals}
        loading={<SkeletonList rows={4} />}
        empty={null}
        hasContent
        renderContent={(goalList) => (
          <>
        {(goalList ?? []).length === 0 ? (
          <EmptyState icon="target">No goals yet — add one below</EmptyState>
        ) : (
          (goalList ?? []).map((g) => (
              <Pressable testID={`goals-row-${g.id}`} key={g.id} onPress={() => openEdit(g)} disabled={inputLocked} style={({ pressed }) => [pressed && !inputLocked && { opacity: 0.7 }, inputLocked && { opacity: 0.5 }]}>
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

          <Pressable testID="goals-add-button" style={({ pressed }) => [styles.addBtn, pressed && !inputLocked && { opacity: 0.7 }, inputLocked && { opacity: 0.5 }]} onPress={openNew} disabled={inputLocked}>
            <Text style={styles.addText}>+ Add goal</Text>
          </Pressable>
          </>
        )}
      />

      <MutationSheet
        visible={!!editing}
        title={editing?.isNew ? 'New goal' : 'Edit goal'}
        testID="goals-edit-sheet"
        bottomInset={insets.bottom}
        canDismiss={form.canDismiss && !banner.isLocked}
        onRequestClose={closeSheet}
      >
        <MutationFormBanner outcome={banner.outcome} onRetry={banner.retry} onRefetch={() => goals.refetch()} />

        <Text style={[styles.field, form.getFieldError('name') && styles.fieldErrorLabel]}>Name</Text>
        <TextInput
          testID="goals-name-input"
          ref={nameRef}
          style={[styles.input, form.getFieldError('name') && styles.inputError]}
          value={name}
          onChangeText={setName}
          editable={!inputLocked}
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
          editable={!inputLocked}
          placeholder="5000"
          placeholderTextColor={colors.muted}
          keyboardType="decimal-pad"
          accessibilityLabel="Target amount"
          accessibilityHint={form.getFieldError('target') ? `Error: ${form.getFieldError('target')}` : undefined}
        />
        <MutationFieldError error={form.getFieldError('target')} testID="goals-target-error" />

        <Text style={[styles.field, form.getFieldError('current') && styles.fieldErrorLabel]}>Allocated to this goal</Text>
        <TextInput
          testID="goals-current-input"
          style={[styles.input, form.getFieldError('current') && styles.inputError]}
          value={current}
          onChangeText={setCurrent}
          editable={!inputLocked}
          placeholder="0"
          placeholderTextColor={colors.muted}
          keyboardType="decimal-pad"
          accessibilityLabel="Allocated amount"
          accessibilityHint={form.getFieldError('current') ? `Error: ${form.getFieldError('current')}` : undefined}
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
          editable={!inputLocked}
          placeholder="YYYY-MM"
          placeholderTextColor={colors.muted}
          autoCapitalize="none"
          accessibilityLabel="Deadline"
          accessibilityHint={form.getFieldError('deadline') ? `Error: ${form.getFieldError('deadline')}` : undefined}
        />
        <MutationFieldError error={form.getFieldError('deadline')} testID="goals-deadline-error" />

        <Text style={styles.field}>Track an account (optional)</Text>
        <ScrollView horizontal showsHorizontalScrollIndicator={false} contentContainerStyle={styles.chips}>
          <Pressable testID={`goals-account-manual${accountId === null ? '-selected' : ''}`} onPress={() => { if (inputLocked) return; haptics.tap(); setAccountId(null); }} disabled={inputLocked} style={[styles.chip, accountId === null && styles.chipActive, inputLocked && { opacity: 0.5 }]}>
            <Text style={[styles.chipText, accountId === null && styles.chipTextActive]}>Manual</Text>
          </Pressable>
          {(accounts.data ?? []).map((a) => (
            <Pressable testID={`goals-account-${a.id}${accountId === a.id ? '-selected' : ''}`} key={a.id} onPress={() => { if (inputLocked) return; haptics.tap(); setAccountId(a.id); }} disabled={inputLocked} style={[styles.chip, accountId === a.id && styles.chipActive, inputLocked && { opacity: 0.5 }]}>
              <Text style={[styles.chipText, accountId === a.id && styles.chipTextActive]} numberOfLines={1}>{a.name}</Text>
            </Pressable>
          ))}
        </ScrollView>

        <MutationSubmitButton
          testID="goals-save-button"
          label="Save"
          pendingLabel="Saving…"
          onPress={form.submit}
          disabled={inputLocked}
        />
        {!editing?.isNew ? (
          <Pressable testID="goals-delete-button" style={({ pressed }) => [styles.deleteBtn, pressed && { opacity: 0.7 }]} onPress={remove} disabled={inputLocked}>
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
