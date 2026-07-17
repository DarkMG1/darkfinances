import React, { useEffect, useMemo, useRef, useState } from 'react';
import { FlatList, KeyboardAvoidingView, Modal, Platform, Pressable, ScrollView, StyleSheet, Text, TextInput, View } from 'react-native';
import { useNavigation, useRouter } from 'expo-router';
import { useSafeAreaInsets } from 'react-native-safe-area-context';
import { useAccounts, useCategories, useCreateTransaction } from '@/api/hooks/finance.hooks';
import {
  MutationFieldError,
  MutationFormBanner,
  MutationLiveRegion,
  MutationSubmitButton,
} from '@/components/mutation-form';
import { Card, CardTitle } from '@/components/ui';
import { useMutationForm } from '@/hooks/useMutationForm';
import { haptics } from '@/lib/haptics';
import {
  collectFieldErrors,
  parseStrictMoneyDollars,
  validateDateOnlyField,
  validateMoneyField,
} from '@/lib/mutation-form-validation';
import { colors } from '@/theme/colors';
import { useEditableFinanceDate } from '@/lib/date-only';

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
  const { value: date, setValue: setDate } = useEditableFinanceDate();
  const [notes, setNotes] = useState('');
  const [accountId, setAccountId] = useState<string | null>(null);
  const [categoryId, setCategoryId] = useState<string | null>(null);
  const [categoryName, setCategoryName] = useState('');
  const [pickingCat, setPickingCat] = useState(false);
  const amountRef = useRef<TextInput>(null);
  const dateRef = useRef<TextInput>(null);

  const accts = useMemo(() => accounts.data ?? [], [accounts.data]);
  const ordered = useMemo(
    () => [...accts].sort((a, b) => Number(a.offbudget) - Number(b.offbudget)),
    [accts],
  );
  const selectedAccount = accountId ?? ordered.find((a) => !a.offbudget)?.id ?? ordered[0]?.id ?? null;

  const fields = useMemo(() => ({
    kind,
    amount,
    payee,
    date,
    notes,
    accountId: selectedAccount,
    categoryId,
  }), [amount, categoryId, date, kind, notes, payee, selectedAccount]);

  const form = useMutationForm({
    formId: 'add-transaction',
    fields,
    setFields: () => {},
    persistDraft: false,
    mutation: create,
    mutationLabel: 'Add transaction',
    fieldOrder: ['amount', 'accountId', 'date', 'payee', 'notes', 'categoryId'],
    fieldRefs: { amount: amountRef, date: dateRef },
    onSuccessClose: () => router.back(),
    validate: (f) => collectFieldErrors({
      amount: validateMoneyField(f.amount, { label: 'Amount' }),
      accountId: f.accountId ? null : 'Pick an account.',
      date: validateDateOnlyField(f.date, 'Date'),
    }),
    buildVariables: (f) => {
      const value = parseStrictMoneyDollars(String(f.amount))!;
      return {
        accountId: String(f.accountId),
        amount: f.kind === 'expense' ? -value : value,
        payee: String(f.payee).trim() || undefined,
        date: String(f.date),
        categoryId: f.categoryId || undefined,
        notes: String(f.notes).trim() || undefined,
      };
    },
  });

  useEffect(() => {
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

  return (
    <KeyboardAvoidingView testID="add-transaction-screen" style={styles.root} behavior={Platform.OS === 'ios' ? 'padding' : undefined}>
    <ScrollView style={styles.root} contentContainerStyle={{ padding: 16, paddingBottom: insets.bottom + 32 }} keyboardShouldPersistTaps="handled">
      <MutationLiveRegion message={form.announce} />
      <MutationFormBanner outcome={form.outcome} onRetry={form.retry} />

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
          style={[styles.amountInput, form.getFieldError('amount') ? styles.inputError : null]}
          value={amount}
          onChangeText={setAmount}
          placeholder="0.00"
          placeholderTextColor={colors.muted}
          keyboardType="decimal-pad"
          accessibilityLabel="Amount"
          accessibilityHint={form.getFieldError('amount') ? `Error: ${form.getFieldError('amount')}` : undefined}
        />
      </View>
      <MutationFieldError error={form.getFieldError('amount')} testID="add-transaction-amount-error" />

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
      <MutationFieldError error={form.getFieldError('accountId')} testID="add-transaction-account-error" />

      <CardTitle>Payee</CardTitle>
      <Card>
        <TextInput testID="add-transaction-payee-input" style={styles.input} value={payee} onChangeText={setPayee} placeholder="Who was it?" placeholderTextColor={colors.muted} autoCapitalize="words" accessibilityLabel="Payee" />
      </Card>

      <CardTitle>Date</CardTitle>
      <Card>
        <TextInput
          testID="add-transaction-date-input"
          ref={dateRef}
          style={[styles.input, form.getFieldError('date') ? styles.inputError : null]}
          value={date}
          onChangeText={setDate}
          placeholder="YYYY-MM-DD"
          placeholderTextColor={colors.muted}
          autoCapitalize="none"
          accessibilityLabel="Date"
          accessibilityHint={form.getFieldError('date') ? `Error: ${form.getFieldError('date')}` : undefined}
        />
      </Card>
      <MutationFieldError error={form.getFieldError('date')} testID="add-transaction-date-error" />

      <CardTitle>Category</CardTitle>
      <Pressable testID="add-transaction-category-picker" onPress={() => { haptics.tap(); setPickingCat(true); }} style={({ pressed }) => pressed && { opacity: 0.7 }}>
        <Card style={styles.pickRow}>
          <Text style={[styles.pickValue, !categoryName && { color: colors.muted }]}>{categoryName || 'Optional — tap to set'}</Text>
          <Text style={styles.pickArrow}>›</Text>
        </Card>
      </Pressable>

      <CardTitle>Notes</CardTitle>
      <Card>
        <TextInput testID="add-transaction-notes-input" style={[styles.input, { minHeight: 44, textAlignVertical: 'top' }]} value={notes} onChangeText={setNotes} placeholder="Add a note…" placeholderTextColor={colors.muted} multiline accessibilityLabel="Notes" />
      </Card>

      <MutationSubmitButton
        testID="add-transaction-submit-button"
        label="Add transaction"
        pendingLabel="Adding…"
        onPress={form.submit}
        disabled={form.isLocked}
      />
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
  inputError: { borderWidth: 1, borderColor: '#ff6b6b' },
  chips: { gap: 8, paddingVertical: 4, paddingRight: 8 },
  chip: { paddingHorizontal: 12, paddingVertical: 9, borderRadius: 16, borderWidth: 1, borderColor: colors.border, backgroundColor: colors.surface2, maxWidth: 200, minHeight: 44, justifyContent: 'center' },
  chipActive: { backgroundColor: colors.accent, borderColor: colors.accent },
  chipText: { color: colors.muted, fontSize: 13, fontWeight: '600' },
  chipTextActive: { color: '#fff' },
  input: { color: colors.text, fontSize: 15 },
  pickRow: { flexDirection: 'row', alignItems: 'center', justifyContent: 'space-between' },
  pickValue: { color: colors.text, fontSize: 15, flex: 1 },
  pickArrow: { color: colors.muted, fontSize: 20, fontWeight: '700' },
  warn: { color: colors.muted, fontSize: 12, textAlign: 'center', marginTop: 10 },
  modalBg: { flex: 1, backgroundColor: 'rgba(0,0,0,0.6)', justifyContent: 'flex-end' },
  sheet: { backgroundColor: colors.surface, borderTopLeftRadius: 18, borderTopRightRadius: 18, padding: 16 },
  sheetTitle: { color: colors.text, fontSize: 15, fontWeight: '700', marginBottom: 12 },
  catOption: { flexDirection: 'row', justifyContent: 'space-between', alignItems: 'center', paddingVertical: 12, borderBottomWidth: StyleSheet.hairlineWidth, borderBottomColor: colors.border, minHeight: 44 },
  catOptionText: { color: colors.text, fontSize: 15 },
  catOptionGroup: { color: colors.muted, fontSize: 12 },
});
