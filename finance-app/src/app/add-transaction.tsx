import React, { useEffect, useMemo, useRef, useState } from 'react';
import { Alert, FlatList, KeyboardAvoidingView, Modal, Platform, Pressable, ScrollView, StyleSheet, Text, TextInput, View } from 'react-native';
import { useNavigation, useRouter } from 'expo-router';
import { useSafeAreaInsets } from 'react-native-safe-area-context';
import { useAccounts, useCategories, useCreateTransaction } from '@/api/hooks/finance.hooks';
import { Card, CardTitle } from '@/components/ui';
import { haptics } from '@/lib/haptics';
import { colors } from '@/theme/colors';

const pad = (n: number) => String(n).padStart(2, '0');
const todayYMD = () => {
  const n = new Date();
  return `${n.getFullYear()}-${pad(n.getMonth() + 1)}-${pad(n.getDate())}`;
};

type Kind = 'expense' | 'income';

export default function AddTransaction() {
  const router = useRouter();
  const navigation = useNavigation();
  const insets = useSafeAreaInsets();
  const accounts = useAccounts();
  const categories = useCategories();
  const create = useCreateTransaction();

  const [kind, setKind] = useState<Kind>('expense');
  const [amount, setAmount] = useState('');
  const [payee, setPayee] = useState('');
  const [date, setDate] = useState(todayYMD());
  const [notes, setNotes] = useState('');
  const [accountId, setAccountId] = useState<string | null>(null);
  const [categoryId, setCategoryId] = useState<string | null>(null);
  const [categoryName, setCategoryName] = useState('');
  const [pickingCat, setPickingCat] = useState(false);
  const amountRef = useRef<TextInput>(null);

  const accts = useMemo(() => accounts.data ?? [], [accounts.data]);
  // General manual entry: surface on-budget (spending) accounts first and default
  // to the first one — typically checking. Cash spending itself is tracked by
  // categorizing the synced ATM withdrawal as "Cash & ATM", not as a fake account.
  const ordered = useMemo(
    () => [...accts].sort((a, b) => Number(a.offbudget) - Number(b.offbudget)),
    [accts]
  );
  const selectedAccount = accountId ?? ordered.find((a) => !a.offbudget)?.id ?? ordered[0]?.id ?? null;

  useEffect(() => {
    // Focus only after the NATIVE push transition fully ends. InteractionManager
    // resolves before react-native-screens finishes its native animation, so the
    // keyboard slid up mid-transition and jittered. transitionEnd is the reliable
    // "screen finished animating in" signal; the timeout is a fallback for when the
    // event doesn't fire (e.g. reduce-motion is enabled).
    let focused = false;
    const focus = () => {
      if (focused) return;
      focused = true;
      amountRef.current?.focus();
    };
    const sub = (navigation as any).addListener('transitionEnd', (e: any) => {
      if (!e?.data?.closing) focus();
    });
    const fallback = setTimeout(focus, 600);
    return () => {
      if (typeof sub === 'function') sub();
      clearTimeout(fallback);
    };
  }, [navigation]);

  const submit = () => {
    const value = parseFloat(amount.replace(/[^0-9.]/g, ''));
    if (!isFinite(value) || value <= 0) {
      Alert.alert('Amount', 'Enter an amount greater than zero.');
      return;
    }
    if (!selectedAccount) {
      Alert.alert('Account', 'Pick an account.');
      return;
    }
    create.mutate(
      {
        accountId: selectedAccount,
        amount: kind === 'expense' ? -value : value,
        payee: payee.trim() || undefined,
        date,
        categoryId: categoryId || undefined,
        notes: notes.trim() || undefined,
      },
      {
        onSuccess: () => router.back(),
        onError: (e) => Alert.alert('Could not add', e?.error || e?.message || 'Failed to add the transaction.'),
      }
    );
  };

  return (
    <KeyboardAvoidingView testID="add-transaction-screen" style={styles.root} behavior={Platform.OS === 'ios' ? 'padding' : undefined}>
    <ScrollView style={styles.root} contentContainerStyle={{ padding: 16, paddingBottom: insets.bottom + 32 }} keyboardShouldPersistTaps="handled">
      <View style={styles.typeRow}>
        {(['expense', 'income'] as Kind[]).map((k) => (
          <Pressable testID={`add-transaction-type-${k}${kind === k ? '-selected' : ''}`} key={k} style={({ pressed }) => [styles.typeBtn, kind === k && (k === 'expense' ? styles.typeExpense : styles.typeIncome), pressed && { opacity: 0.8 }]} onPress={() => { haptics.tap(); setKind(k); }}>
            <Text style={[styles.typeText, kind === k && styles.typeTextActive]}>{k === 'expense' ? 'Expense' : 'Income'}</Text>
          </Pressable>
        ))}
      </View>

      <View style={styles.amountWrap}>
        <Text style={[styles.amountSign, { color: kind === 'expense' ? colors.text : colors.green }]}>{kind === 'expense' ? '−' : '+'}$</Text>
        <TextInput
          testID="add-transaction-amount-input"
          ref={amountRef}
          style={styles.amountInput}
          value={amount}
          onChangeText={setAmount}
          placeholder="0.00"
          placeholderTextColor={colors.muted}
          keyboardType="decimal-pad"
        />
      </View>

      <CardTitle>Account</CardTitle>
      <ScrollView horizontal showsHorizontalScrollIndicator={false} contentContainerStyle={styles.chips}>
        {ordered.map((a) => {
          const active = a.id === selectedAccount;
          return (
            <Pressable testID={`add-transaction-account-${a.id}${active ? '-selected' : ''}`} key={a.id} style={[styles.chip, active && styles.chipActive]} onPress={() => { haptics.tap(); setAccountId(a.id); }}>
              <Text style={[styles.chipText, active && styles.chipTextActive]} numberOfLines={1}>{a.name}</Text>
            </Pressable>
          );
        })}
      </ScrollView>

      <CardTitle>Payee</CardTitle>
      <Card>
        <TextInput testID="add-transaction-payee-input" style={styles.input} value={payee} onChangeText={setPayee} placeholder="Who was it?" placeholderTextColor={colors.muted} autoCapitalize="words" />
      </Card>

      <CardTitle>Date</CardTitle>
      <Card>
        <TextInput testID="add-transaction-date-input" style={styles.input} value={date} onChangeText={setDate} placeholder="YYYY-MM-DD" placeholderTextColor={colors.muted} autoCapitalize="none" />
      </Card>

      <CardTitle>Category</CardTitle>
      <Pressable testID="add-transaction-category-picker" onPress={() => { haptics.tap(); setPickingCat(true); }} style={({ pressed }) => pressed && { opacity: 0.7 }}>
        <Card style={styles.pickRow}>
          <Text style={[styles.pickValue, !categoryName && { color: colors.muted }]}>{categoryName || 'Optional — tap to set'}</Text>
          <Text style={styles.pickArrow}>›</Text>
        </Card>
      </Pressable>

      <CardTitle>Notes</CardTitle>
      <Card>
        <TextInput testID="add-transaction-notes-input" style={[styles.input, { minHeight: 44, textAlignVertical: 'top' }]} value={notes} onChangeText={setNotes} placeholder="Add a note…" placeholderTextColor={colors.muted} multiline />
      </Card>

      <Pressable testID="add-transaction-submit-button" style={({ pressed }) => [styles.submit, (create.isPending || pressed) && { opacity: 0.7 }]} onPress={submit} disabled={create.isPending}>
        <Text style={styles.submitText}>{create.isPending ? 'Adding…' : 'Add transaction'}</Text>
      </Pressable>
      <Text style={styles.warn}>This writes to your real budget.</Text>

      <Modal visible={pickingCat} animationType="slide" transparent onRequestClose={() => setPickingCat(false)}>
        <Pressable style={styles.modalBg} onPress={() => setPickingCat(false)}>
          <View testID="add-transaction-category-sheet" style={[styles.sheet, { paddingBottom: insets.bottom + 16 }]}>
            <Text style={styles.sheetTitle}>Set category</Text>
            <FlatList
              data={categories.data ?? []}
              keyExtractor={(c) => c.id}
              style={{ maxHeight: 400 }}
              ListHeaderComponent={
                <Pressable testID="add-transaction-category-none" style={styles.catOption} onPress={() => { setCategoryId(null); setCategoryName(''); setPickingCat(false); }}>
                  <Text style={styles.catOptionText}>Uncategorized</Text>
                </Pressable>
              }
              renderItem={({ item }) => (
                <Pressable testID={`add-transaction-category-${item.id}`} style={styles.catOption} onPress={() => { setCategoryId(item.id); setCategoryName(item.name); setPickingCat(false); }}>
                  <Text style={styles.catOptionText}>{item.name}</Text>
                  <Text style={styles.catOptionGroup}>{item.group}</Text>
                </Pressable>
              )}
            />
          </View>
        </Pressable>
      </Modal>
    </ScrollView>
    </KeyboardAvoidingView>
  );
}

const styles = StyleSheet.create({
  root: { flex: 1, backgroundColor: colors.bg },
  typeRow: { flexDirection: 'row', gap: 8, marginTop: 4, marginBottom: 8 },
  typeBtn: { flex: 1, paddingVertical: 10, borderRadius: 10, borderWidth: 1, borderColor: colors.border, alignItems: 'center', backgroundColor: colors.surface2 },
  typeExpense: { backgroundColor: colors.surface, borderColor: colors.accent },
  typeIncome: { backgroundColor: 'rgba(34,197,94,0.12)', borderColor: colors.green },
  typeText: { color: colors.muted, fontSize: 14, fontWeight: '700' },
  typeTextActive: { color: colors.text },
  amountWrap: { flexDirection: 'row', alignItems: 'center', justifyContent: 'center', marginVertical: 12 },
  amountSign: { fontSize: 34, fontWeight: '800' },
  amountInput: { color: colors.text, fontSize: 44, fontWeight: '800', letterSpacing: -1.5, minWidth: 140, textAlign: 'center', padding: 0 },
  chips: { gap: 8, paddingVertical: 4, paddingRight: 8 },
  chip: { paddingHorizontal: 12, paddingVertical: 9, borderRadius: 16, borderWidth: 1, borderColor: colors.border, backgroundColor: colors.surface2, maxWidth: 200 },
  chipActive: { backgroundColor: colors.accent, borderColor: colors.accent },
  chipText: { color: colors.muted, fontSize: 13, fontWeight: '600' },
  chipTextActive: { color: '#fff' },
  input: { color: colors.text, fontSize: 15 },
  pickRow: { flexDirection: 'row', alignItems: 'center', justifyContent: 'space-between' },
  pickValue: { color: colors.text, fontSize: 15, flex: 1 },
  pickArrow: { color: colors.muted, fontSize: 20, fontWeight: '700' },
  submit: { backgroundColor: colors.accent, borderRadius: 12, paddingVertical: 15, alignItems: 'center', marginTop: 20 },
  submitText: { color: '#fff', fontSize: 16, fontWeight: '700' },
  warn: { color: colors.muted, fontSize: 12, textAlign: 'center', marginTop: 10 },
  modalBg: { flex: 1, backgroundColor: 'rgba(0,0,0,0.6)', justifyContent: 'flex-end' },
  sheet: { backgroundColor: colors.surface, borderTopLeftRadius: 18, borderTopRightRadius: 18, padding: 16 },
  sheetTitle: { color: colors.text, fontSize: 15, fontWeight: '700', marginBottom: 12 },
  catOption: { flexDirection: 'row', justifyContent: 'space-between', alignItems: 'center', paddingVertical: 12, borderBottomWidth: StyleSheet.hairlineWidth, borderBottomColor: colors.border },
  catOptionText: { color: colors.text, fontSize: 15 },
  catOptionGroup: { color: colors.muted, fontSize: 12 },
});
