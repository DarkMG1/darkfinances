import React, { useCallback, useMemo, useRef, useState } from 'react';
import { Alert, Platform, Pressable, ScrollView, StyleSheet, Text, TextInput, View } from 'react-native';
import { Stack, useRouter } from 'expo-router';
import { useSafeAreaInsets } from 'react-native-safe-area-context';
import { useDeleteEvent, useEvents, useSaveEvent } from '@/api/hooks/finance.hooks';
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
import { useEditableFinanceDate } from '@/lib/date-only';
import { haptics } from '@/lib/haptics';
import { collectFieldErrors, validateDateOnlyField, validateRequiredText } from '@/lib/mutation-form-validation';
import { colors } from '@/theme/colors';

export default function Events() {
  const insets = useSafeAreaInsets();
  const router = useRouter();
  const events = useEvents();
  const saveEvent = useSaveEvent();
  const deleteEvent = useDeleteEvent();

  const [name, setName] = useState('');
  const { value: start, setValue: setStart, resetToToday, today } = useEditableFinanceDate();
  const [members, setMembers] = useState('');
  const [group, setGroup] = useState('');
  const nameRef = useRef<TextInput>(null);
  const startRef = useRef<TextInput>(null);
  const membersRef = useRef<TextInput>(null);
  const groupRef = useRef<TextInput>(null);
  const admissionRef = useMutationScreenAdmission();

  const fields = useMemo(() => ({ name, start, members, group }), [group, members, name, start]);

  const applyFields = useCallback((updater: React.SetStateAction<typeof fields>) => {
    const prev = { name, start, members, group };
    const next = typeof updater === 'function' ? updater(prev) : updater;
    if (next.name !== undefined) setName(String(next.name));
    if (next.start !== undefined) setStart(String(next.start));
    if (next.members !== undefined) setMembers(String(next.members));
    if (next.group !== undefined) setGroup(String(next.group));
  }, [group, members, name, setStart, start]);

  const form = useMutationForm({
    formId: 'events-create',
    fields,
    setFields: applyFields,
    persistDraft: true,
    mutation: saveEvent,
    mutationLabel: 'Create trip',
    fieldOrder: ['name', 'start', 'members', 'group'],
    fieldRefs: { name: nameRef, start: startRef, members: membersRef, group: groupRef },
    admissionRef,
    onRefetch: () => events.refetch(),
    validate: (f) => collectFieldErrors({
      name: validateRequiredText(f.name, 'Trip name'),
      start: validateDateOnlyField(String(f.start).trim() || today, 'Start date'),
    }),
    buildVariables: (f) => ({
      name: String(f.name).trim(),
      start: String(f.start).trim() || today,
      members: String(f.members).trim(),
      group: String(f.group).trim(),
    }),
    onSuccessClose: () => {
      setName('');
      setMembers('');
      setGroup('');
      resetToToday();
    },
  });

  const deleteAction = useMutationAction({
    mutation: deleteEvent,
    mutationLabel: 'Delete trip',
    admissionRef,
    onActivate: () => form.clearErrors(),
    onSuccess: () => {
      form.clearErrors();
      events.refetch();
    },
  });

  const banner = useMutationBannerCoordinator(useMemo(() => [
    { key: 'form', outcome: form.outcome, retry: form.retry, announce: form.announce, isLocked: form.isLocked, activitySeq: form.activitySeq },
    { key: 'delete', outcome: deleteAction.outcome, retry: deleteAction.retry, announce: deleteAction.announce, isLocked: deleteAction.isLocked, activitySeq: deleteAction.activitySeq },
  ], [deleteAction.activitySeq, deleteAction.announce, deleteAction.isLocked, deleteAction.outcome, deleteAction.retry, form.activitySeq, form.announce, form.isLocked, form.outcome, form.retry]));

  const inputLocked = banner.isLocked;

  const remove = (slug: string, label: string) => {
    if (inputLocked) return;
    Alert.alert('Delete trip?', `Remove “${label}”? Tagged transactions keep their #ev-${slug} tag but the trip disappears from this list.`, [
      { text: 'Cancel', style: 'cancel' },
      {
        text: 'Delete',
        style: 'destructive',
        onPress: () => { if (inputLocked) return; haptics.tap(); deleteAction.run({ slug }); },
      },
    ]);
  };

  const list = events.data?.events ?? [];
  const eventsDisplay = resolveQueryDisplay(events);

  return (
    <ScrollView testID="events-screen" style={styles.root} contentContainerStyle={{ padding: 16, paddingBottom: insets.bottom + 32 }} keyboardShouldPersistTaps="handled">
      <Stack.Screen options={{ title: 'Trips & Events' }} />
      <MutationLiveRegion message={banner.announce} />
      <MutationFormBanner outcome={banner.outcome} onRetry={banner.retry} onRefetch={() => events.refetch()} />

      {eventsDisplay.refetchError ? (
        <QueryRefetchBanner onRetry={() => events.refetch()} testID="events-refetch-banner" />
      ) : null}

      <Text style={styles.intro}>
        Create a trip or event, then tag its charges with <Text style={styles.mono}>#ev-slug</Text> from any transaction’s notes. If you link a Splitwise
        group, who-owes-me pulls in automatically.
      </Text>

      <CardTitle style={{ marginTop: 8 }}>New trip / event</CardTitle>
      <Card>
        <Text style={styles.label}>Name</Text>
        <TextInput
          testID="events-name-input"
          ref={nameRef}
          style={[styles.input, form.getFieldError('name') && styles.inputError]}
          value={name}
          onChangeText={setName}
          editable={!inputLocked}
          placeholder="e.g. Summer trip 2026"
          placeholderTextColor={colors.muted}
          autoCorrect={false}
          accessibilityLabel="Trip name"
        />
        <MutationFieldError error={form.getFieldError('name')} testID="events-name-error" />

        <Text style={[styles.label, { marginTop: 12 }]}>Start date</Text>
        <TextInput
          testID="events-start-input"
          ref={startRef}
          style={[styles.input, form.getFieldError('start') && styles.inputError]}
          value={start}
          onChangeText={setStart}
          editable={!inputLocked}
          placeholder="YYYY-MM-DD"
          placeholderTextColor={colors.muted}
          autoCapitalize="none"
          autoCorrect={false}
          accessibilityLabel="Start date"
        />
        <MutationFieldError error={form.getFieldError('start')} testID="events-start-error" />

        <Text style={[styles.label, { marginTop: 12 }, form.getFieldError('members') && styles.fieldErrorLabel]}>People (comma-separated)</Text>
        <TextInput
          testID="events-members-input"
          ref={membersRef}
          style={[styles.input, form.getFieldError('members') && styles.inputError]}
          value={members}
          onChangeText={setMembers}
          editable={!inputLocked}
          placeholder="e.g. alex, sam, jordan"
          placeholderTextColor={colors.muted}
          autoCapitalize="none"
          autoCorrect={false}
          accessibilityLabel="People"
          accessibilityHint={form.getFieldError('members') ? `Error: ${form.getFieldError('members')}` : undefined}
        />
        <MutationFieldError error={form.getFieldError('members')} testID="events-members-error" />

        <Text style={[styles.label, { marginTop: 12 }, form.getFieldError('group') && styles.fieldErrorLabel]}>Splitwise group (optional)</Text>
        <TextInput
          testID="events-group-input"
          ref={groupRef}
          style={[styles.input, form.getFieldError('group') && styles.inputError]}
          value={group}
          onChangeText={setGroup}
          editable={!inputLocked}
          placeholder="Exact Splitwise group name"
          placeholderTextColor={colors.muted}
          autoCorrect={false}
          accessibilityLabel="Splitwise group"
          accessibilityHint={form.getFieldError('group') ? `Error: ${form.getFieldError('group')}` : undefined}
        />
        <MutationFieldError error={form.getFieldError('group')} testID="events-group-error" />

        <MutationSubmitButton
          testID="events-create-button"
          label="Create trip"
          pendingLabel="Saving…"
          onPress={form.submit}
          disabled={inputLocked}
        />
      </Card>

      <CardTitle style={{ marginTop: 24 }}>Your trips{list.length ? ` (${list.length})` : ''}</CardTitle>
      {eventsDisplay.initialLoad ? (
        <SkeletonList rows={3} />
      ) : eventsDisplay.fatalError ? (
        <ErrorState error={eventsDisplay.errorMessage} onRetry={() => events.refetch()} />
      ) : list.length ? (
        <Card style={styles.list}>
          {list.map((e, i) => (
            <View key={e.slug} style={[styles.row, i === list.length - 1 && { borderBottomWidth: 0 }]}>
              <Pressable
                testID={`events-row-${e.slug}`}
                accessibilityRole="link"
                accessibilityLabel={`${e.name}, #ev-${e.slug}${e.start ? `, starts ${e.start}` : ''}`}
                accessibilityHint="Opens transactions tagged for this trip"
                style={({ pressed }) => [styles.rowLink, pressed && { opacity: 0.6 }]}
                onPress={() => { haptics.tap(); router.push({ pathname: '/tag/[tag]', params: { tag: `ev-${e.slug}` } }); }}
              >
                <View style={{ flex: 1 }}>
                  <Text style={styles.rowName}>{e.name}</Text>
                  <Text style={styles.rowSub}>#{`ev-${e.slug}`}{e.start ? ` · starts ${e.start}` : ''}</Text>
                </View>
                <Text style={styles.chev}>›</Text>
              </Pressable>
              <Pressable
                testID={`events-delete-${e.slug}`}
                accessibilityRole="button"
                accessibilityLabel={`Delete ${e.name}`}
                accessibilityHint="Shows a confirmation before deleting this trip"
                accessibilityState={{ disabled: inputLocked }}
                disabled={inputLocked}
                hitSlop={8}
                onPress={() => remove(e.slug, e.name)}
                style={({ pressed }) => [styles.deleteButton, pressed && !inputLocked && { opacity: 0.5 }, inputLocked && { opacity: 0.4 }]}
              >
                <Text style={styles.deleteText}>Delete</Text>
              </Pressable>
            </View>
          ))}
        </Card>
      ) : (
        <Card><Text style={styles.empty}>No trips yet — create one above.</Text></Card>
      )}
    </ScrollView>
  );
}

const styles = StyleSheet.create({
  root: { flex: 1, backgroundColor: colors.bg },
  intro: { color: colors.muted, fontSize: 13, lineHeight: 19, marginBottom: 4 },
  mono: { fontFamily: Platform.OS === 'ios' ? 'Menlo' : 'monospace', color: colors.accentLight },
  label: { color: colors.muted, fontSize: 12, fontWeight: '600', marginBottom: 6 },
  fieldErrorLabel: { color: '#ff6b6b' },
  input: { backgroundColor: colors.surface2, borderColor: colors.border, borderWidth: 1, borderRadius: 8, color: colors.text, paddingHorizontal: 12, paddingVertical: 10, fontSize: 15, minHeight: 44 },
  inputError: { borderColor: '#ff6b6b' },
  list: { paddingVertical: 2 },
  row: { flexDirection: 'row', alignItems: 'center', borderBottomWidth: StyleSheet.hairlineWidth, borderBottomColor: colors.border, minHeight: 44 },
  rowLink: { flex: 1, flexDirection: 'row', alignItems: 'center', alignSelf: 'stretch', paddingVertical: 12, paddingRight: 12, minHeight: 44 },
  rowName: { color: colors.text, fontSize: 15, fontWeight: '600' },
  rowSub: { color: colors.muted, fontSize: 12, marginTop: 2 },
  chev: { color: colors.muted, fontSize: 20, fontWeight: '700' },
  deleteButton: { alignSelf: 'stretch', justifyContent: 'center', minHeight: 44, paddingLeft: 12 },
  deleteText: { color: colors.red, fontSize: 13, fontWeight: '600' },
  empty: { color: colors.muted, fontSize: 14 },
});
