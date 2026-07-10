import React, { useState } from 'react';
import { Alert, Pressable, ScrollView, StyleSheet, Text, TextInput, View } from 'react-native';
import { Stack, useRouter } from 'expo-router';
import { useSafeAreaInsets } from 'react-native-safe-area-context';
import { useDeleteEvent, useEvents, useSaveEvent } from '@/api/hooks/finance.hooks';
import { Card, CardTitle } from '@/components/ui';
import { SkeletonList } from '@/components/skeleton';
import { financeToday, isDateOnly } from '@/lib/date-only';
import { haptics } from '@/lib/haptics';
import { colors } from '@/theme/colors';

export default function Events() {
  const insets = useSafeAreaInsets();
  const router = useRouter();
  const events = useEvents();
  const saveEvent = useSaveEvent();
  const deleteEvent = useDeleteEvent();

  const [name, setName] = useState('');
  const [start, setStart] = useState(financeToday());
  const [members, setMembers] = useState('');
  const [group, setGroup] = useState('');

  const canAdd = name.trim().length >= 2 && !saveEvent.isPending;

  const add = () => {
    if (!canAdd) return;
    const startDate = start.trim() || financeToday();
    if (!isDateOnly(startDate)) {
      Alert.alert('Invalid start date', 'Use a real date in YYYY-MM-DD format.');
      return;
    }
    haptics.tap();
    saveEvent.mutate(
      { name: name.trim(), start: startDate, members: members.trim(), group: group.trim() },
      {
        onSuccess: (r) => {
          setName('');
          setMembers('');
          setGroup('');
          setStart(financeToday());
          Alert.alert(
            'Trip created',
            `Tag any charge with #ev-${r?.event?.slug} to add it to “${r?.event?.name}”.` +
              (group.trim() ? '\n\nSplitwise data for this group will pull in on the next refresh.' : ''),
          );
        },
        onError: (e) => Alert.alert('Could not create trip', e.error || 'Please try again.'),
      },
    );
  };

  const remove = (slug: string, label: string) =>
    Alert.alert('Delete trip?', `Remove “${label}”? Tagged transactions keep their #ev-${slug} tag but the trip disappears from this list.`, [
      { text: 'Cancel', style: 'cancel' },
      { text: 'Delete', style: 'destructive', onPress: () => { haptics.tap(); deleteEvent.mutate({ slug }); } },
    ]);

  const list = events.data?.events ?? [];

  return (
    <ScrollView testID="events-screen" style={styles.root} contentContainerStyle={{ padding: 16, paddingBottom: insets.bottom + 32 }} keyboardShouldPersistTaps="handled">
      <Stack.Screen options={{ title: 'Trips & Events' }} />

      <Text style={styles.intro}>
        Create a trip or event, then tag its charges with <Text style={styles.mono}>#ev-slug</Text> from any transaction’s notes. If you link a Splitwise
        group, who-owes-me pulls in automatically.
      </Text>

      <CardTitle style={{ marginTop: 8 }}>New trip / event</CardTitle>
      <Card>
        <Text style={styles.label}>Name</Text>
        <TextInput testID="events-name-input" style={styles.input} value={name} onChangeText={setName} placeholder="e.g. Summer trip 2026" placeholderTextColor={colors.muted} autoCorrect={false} />

        <Text style={[styles.label, { marginTop: 12 }]}>Start date</Text>
        <TextInput testID="events-start-input" style={styles.input} value={start} onChangeText={setStart} placeholder="YYYY-MM-DD" placeholderTextColor={colors.muted} autoCapitalize="none" autoCorrect={false} />

        <Text style={[styles.label, { marginTop: 12 }]}>People (comma-separated)</Text>
        <TextInput testID="events-members-input" style={styles.input} value={members} onChangeText={setMembers} placeholder="e.g. alex, sam, jordan" placeholderTextColor={colors.muted} autoCapitalize="none" autoCorrect={false} />

        <Text style={[styles.label, { marginTop: 12 }]}>Splitwise group (optional)</Text>
        <TextInput testID="events-group-input" style={styles.input} value={group} onChangeText={setGroup} placeholder="Exact Splitwise group name" placeholderTextColor={colors.muted} autoCorrect={false} />

        <Pressable testID="events-create-button" style={({ pressed }) => [styles.addBtn, !canAdd && { opacity: 0.4 }, pressed && { opacity: 0.85 }]} onPress={add} disabled={!canAdd}>
          <Text style={styles.addText}>{saveEvent.isPending ? 'Saving…' : 'Create trip'}</Text>
        </Pressable>
      </Card>

      <CardTitle style={{ marginTop: 24 }}>Your trips{list.length ? ` (${list.length})` : ''}</CardTitle>
      {events.isLoading && !events.data ? (
        <SkeletonList rows={3} />
      ) : list.length ? (
        <Card style={styles.list}>
          {list.map((e, i) => (
            <Pressable
              testID={`events-row-${e.slug}`}
              key={e.slug}
              style={({ pressed }) => [styles.row, i === list.length - 1 && { borderBottomWidth: 0 }, pressed && { opacity: 0.6 }]}
              onLongPress={() => remove(e.slug, e.name)}
              onPress={() => { haptics.tap(); router.push({ pathname: '/tag/[tag]', params: { tag: `ev-${e.slug}` } }); }}
            >
              <View style={{ flex: 1, minWidth: 0 }}>
                <Text style={styles.name} numberOfLines={1}>{e.name}</Text>
                <Text style={styles.sub} numberOfLines={1}>
                  <Text style={styles.mono}>#ev-{e.slug}</Text>
                  {e.members?.length ? ` · ${e.members.length} ${e.members.length === 1 ? 'person' : 'people'}` : ''}
                  {e.group ? ' · Splitwise linked' : ''}
                </Text>
              </View>
              <View style={{ alignItems: 'flex-end' }}>
                <Text style={styles.count}>{e.taggedCount || 0}</Text>
                <Text style={styles.countLbl}>charges</Text>
              </View>
            </Pressable>
          ))}
        </Card>
      ) : (
        <Card>
          <Text style={styles.empty}>No trips yet. Create one above, then tag its charges with the #ev tag it gives you.</Text>
        </Card>
      )}

      {list.length ? <Text style={styles.hint}>Tap a trip to see its tagged charges. Long-press to delete.</Text> : null}
    </ScrollView>
  );
}

const styles = StyleSheet.create({
  root: { flex: 1, backgroundColor: colors.bg },
  intro: { color: colors.muted, fontSize: 13, lineHeight: 19 },
  mono: { fontFamily: 'Menlo', fontSize: 12, color: colors.accentLight },
  label: { color: colors.muted, fontSize: 12, fontWeight: '600', marginBottom: 6, textTransform: 'uppercase', letterSpacing: 0.5 },
  input: { backgroundColor: colors.surface2, borderColor: colors.border, borderWidth: 1, borderRadius: 8, color: colors.text, paddingHorizontal: 12, paddingVertical: 10, fontSize: 15 },
  addBtn: { backgroundColor: colors.accent, borderRadius: 10, paddingVertical: 12, alignItems: 'center', marginTop: 14 },
  addText: { color: '#fff', fontSize: 15, fontWeight: '700' },
  list: { paddingVertical: 2 },
  row: { flexDirection: 'row', alignItems: 'center', gap: 12, paddingVertical: 12, borderBottomWidth: StyleSheet.hairlineWidth, borderBottomColor: colors.border },
  name: { color: colors.text, fontSize: 15, fontWeight: '600' },
  sub: { color: colors.muted, fontSize: 13, marginTop: 2 },
  count: { color: colors.text, fontSize: 16, fontWeight: '700' },
  countLbl: { color: colors.muted, fontSize: 11 },
  empty: { color: colors.muted, fontSize: 14, lineHeight: 20 },
  hint: { color: colors.muted, fontSize: 12, marginTop: 12, textAlign: 'center' },
});
