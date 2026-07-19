import React, { useCallback, useMemo, useState } from 'react';
import { Pressable, SectionList, StyleSheet, Switch, Text, TextInput, View } from 'react-native';
import { Stack, useLocalSearchParams, useRouter } from 'expo-router';
import { useSafeAreaInsets } from 'react-native-safe-area-context';
import { useAccounts, useSetAccountOverride, useTransactions } from '@/api/hooks/finance.hooks';
import { DemoRibbon } from '@/components/screen';
import {
  MutationFieldError,
  MutationFormBanner,
  MutationLiveRegion,
  MutationSheet,
  MutationSubmitButton,
} from '@/components/mutation-form';
import { useMutationForm } from '@/hooks/useMutationForm';
import { GestureRefreshControl } from '@/components/gesture-refresh-control';
import { Avatar, Card, EmptyState, ErrorState, PendingPill, SplitPill } from '@/components/ui';
import { QueryRefetchBanners, resolveQueryDisplay } from '@/components/query-display';
import { buildAccountDetailRefetchQueries } from '@/lib/editor-refetch-queries.js';
import { heroMetricAccessibilityLabel } from '@/lib/metric-a11y.js';
import { SkeletonList } from '@/components/skeleton';
import { AccountRole, Transaction } from '@/api/generated/types';
import { previousMonth, useFinanceToday } from '@/lib/date-only';
import { haptics } from '@/lib/haptics';
import { colors, fmtDay, fmtMoney } from '@/theme/colors';

const ROLE_OPTIONS: { value: AccountRole; label: string }[] = [
  { value: 'operating_cash', label: 'Everyday cash' },
  { value: 'protected_savings', label: 'Protected savings' },
  { value: 'credit_card', label: 'Credit card' },
  { value: 'loan', label: 'Loan' },
  { value: 'investment', label: 'Investment' },
  { value: 'excluded', label: 'Exclude from metrics' },
];

export default function AccountDetail() {
  const router = useRouter();
  const insets = useSafeAreaInsets();
  const p = useLocalSearchParams<{ id: string; name?: string; balance?: string; hidden?: string; role?: AccountRole }>();
  const financeToday = useFinanceToday();
  const windowStart = useMemo(() => {
    const current = financeToday.slice(0, 7);
    return `${previousMonth(previousMonth(current))}-01`;
  }, [financeToday]);

  const accounts = useAccounts();
  const txns = useTransactions({ accountId: p.id, start: windowStart, collapse: true });
  const override = useSetAccountOverride();
  const account = (accounts.data ?? []).find((item) => item.id === p.id);
  const balance = account?.balance ?? (p.balance != null && p.balance !== '' ? Number(p.balance) : null);

  const [nameOverride, setNameOverride] = useState<string | null>(null);
  const title = nameOverride ?? account?.name ?? p.name ?? 'Account';
  const [editing, setEditing] = useState(false);
  const [nameText, setNameText] = useState(p.name || '');
  const [hidden, setHidden] = useState(p.hidden === '1');
  const [role, setRole] = useState<AccountRole>(p.role || 'unknown');

  const fields = useMemo(() => ({ nameText, hidden, role }), [hidden, nameText, role]);

  const applyFields = useCallback((updater: React.SetStateAction<typeof fields>) => {
    const prev = fields;
    const next = typeof updater === 'function' ? updater(prev) : updater;
    if (next.nameText !== undefined) setNameText(String(next.nameText));
    if (next.hidden !== undefined) setHidden(!!next.hidden);
    if (next.role !== undefined) setRole(next.role as AccountRole);
  }, [fields, setHidden, setNameText, setRole]);

  const form = useMutationForm({
    formId: editing ? `account-edit-${p.id}` : 'account-edit-none',
    fields,
    setFields: applyFields,
    persistDraft: false,
    mutation: override,
    mutationLabel: 'Save account',
    fieldOrder: ['nameText', 'hidden', 'role'],
    onSuccessClose: () => {
      setNameOverride(nameText.trim() || account?.name || p.name || 'Account');
      setEditing(false);
    },
    onRefetch: () => accounts.refetch(),
    buildVariables: (f) => ({
      id: p.id,
      name: String(f.nameText),
      hidden: !!f.hidden,
      role: f.role as AccountRole,
    }),
  });

  const openEdit = () => {
    if (form.isLocked) return;
    haptics.tap();
    form.clearErrors();
    setNameText(title);
    setHidden(!!account?.hidden);
    setRole(account?.role || 'unknown');
    setEditing(true);
  };

  const closeSheet = () => {
    form.requestDismiss(() => setEditing(false));
  };

  const inputLocked = form.isLocked;
  const txDisplay = resolveQueryDisplay(txns);
  const accountRefetchQueries = useMemo(
    () => buildAccountDetailRefetchQueries({ accounts, txns }),
    [accounts, txns],
  );
  const refetchAccountDetail = () => Promise.all([accounts.refetch(), txns.refetch()]);

  const sections = useMemo(() => {
    const list = (txns.data ?? []).slice().sort((a, b) => b.date.localeCompare(a.date));
    const out: { title: string; data: Transaction[] }[] = [];
    const byDate: Record<string, Transaction[]> = {};
    for (const t of list) {
      if (!byDate[t.date]) {
        byDate[t.date] = [];
        out.push({ title: fmtDay(t.date), data: byDate[t.date] });
      }
      byDate[t.date].push(t);
    }
    return out;
  }, [txns.data]);

  const openDetail = (t: Transaction) =>
    router.push({
      pathname: '/transaction/[id]',
      params: { id: t.id, date: t.date, accountId: t.accountId },
    });

  const renderItem = ({ item }: { item: Transaction }) => {
    const income = item.amount > 0;
    return (
      <Pressable testID={`account-transaction-${item.id}`} style={({ pressed }) => [styles.row, pressed && { opacity: 0.6 }]} onPress={() => openDetail(item)}>
        <Avatar label={item.payee} category={item.isSplit ? undefined : item.category ?? undefined} size={38} />
        <View style={styles.mid}>
          <View style={styles.payeeLine}>
            <Text style={[styles.payee, { flexShrink: 1 }]} numberOfLines={1}>{item.payee || '—'}</Text>
            {item.cleared === false ? <PendingPill /> : null}
            {item.isSplit ? <SplitPill count={item.splitCount} /> : null}
          </View>
          <Text style={styles.sub} numberOfLines={1}>{item.isSplit ? `Split into ${item.splitCount ?? 2}` : item.category || 'uncategorized'}</Text>
        </View>
        <Text style={[styles.amt, { color: income ? colors.green : colors.text }]}>
          {income ? '+' : ''}{fmtMoney(item.amount)}
        </Text>
      </Pressable>
    );
  };

  return (
    <View testID="account-detail-screen" style={styles.root}>
      <Stack.Screen
        options={{
          title,
          headerRight: () => (
            <Pressable testID="account-edit-button" onPress={openEdit} hitSlop={8} disabled={inputLocked} style={({ pressed }) => [pressed && !inputLocked && { opacity: 0.6 }, inputLocked && { opacity: 0.4 }]}>
              <Text style={styles.editBtn}>Edit</Text>
            </Pressable>
          ),
        }}
      />
      <DemoRibbon />
      <MutationLiveRegion message={form.announce} />
      {txDisplay.initialLoad ? (
        <View style={{ padding: 16 }}>
          <SkeletonList hero rows={7} />
        </View>
      ) : txDisplay.fatalError ? (
        <ErrorState error={txDisplay.errorMessage} onRetry={txns.refetch} />
      ) : (
        <SectionList
          sections={sections}
          keyExtractor={(t) => t.id}
          renderItem={renderItem}
          renderSectionHeader={({ section }) => <Text style={styles.sectionHeader}>{section.title}</Text>}
          stickySectionHeadersEnabled={false}
          contentContainerStyle={{ padding: 16, paddingBottom: insets.bottom + 32 }}
          refreshControl={<GestureRefreshControl onRefresh={refetchAccountDetail} />}
          ListHeaderComponent={
            <>
              <QueryRefetchBanners queries={accountRefetchQueries} testID="account-refetch-banner" />
              {balance != null ? (
                <View
                  style={styles.hero}
                  accessible
                  accessibilityLabel={heroMetricAccessibilityLabel('Balance', fmtMoney(balance), 'Last 3 months')}
                >
                  <Text style={styles.heroLabel} accessibilityElementsHidden importantForAccessibility="no">BALANCE</Text>
                  <Text style={[styles.heroValue, { color: balance < 0 ? colors.red : colors.text }]} accessibilityElementsHidden importantForAccessibility="no">{fmtMoney(balance)}</Text>
                  <Text style={styles.heroSub} accessibilityElementsHidden importantForAccessibility="no">Last 3 months</Text>
                </View>
              ) : null}
            </>
          }
          ListEmptyComponent={<Card><EmptyState icon="tray">No recent transactions</EmptyState></Card>}
        />
      )}

      <MutationSheet
        visible={editing}
        title="Edit account"
        testID="account-edit-sheet"
        bottomInset={insets.bottom}
        canDismiss={form.canDismiss}
        onRequestClose={closeSheet}
      >
        <Text style={styles.label}>Display name</Text>
        <TextInput
          testID="account-name-input"
          style={[styles.input, form.getFieldError('nameText') && { borderColor: '#ff6b6b' }]}
          value={nameText}
          onChangeText={setNameText}
          editable={!inputLocked}
          placeholder="Account name"
          placeholderTextColor={colors.muted}
          autoFocus
          accessibilityLabel="Display name"
        />
        <MutationFieldError error={form.getFieldError('nameText')} testID="account-name-error" />
        <Text style={styles.hintText}>Only changes how it shows here — your bank name is untouched. Clear it to reset.</Text>
        <Text style={[styles.label, { marginTop: 18 }]}>Financial role</Text>
        <View style={styles.roleWrap}>
          {ROLE_OPTIONS.map((option) => (
            <Pressable
              key={option.value}
              accessibilityRole="button"
              accessibilityState={{ selected: role === option.value }}
              testID={`account-role-${option.value}`}
              onPress={() => { if (inputLocked) return; setRole(option.value); }}
              disabled={inputLocked}
              style={[styles.roleChip, role === option.value && styles.roleChipOn, inputLocked && { opacity: 0.5 }]}
            >
              <Text style={[styles.roleText, role === option.value && styles.roleTextOn]}>{option.label}</Text>
            </Pressable>
          ))}
        </View>
        <MutationFieldError error={form.getFieldError('role')} testID="account-role-error" />
        <Text style={styles.hintText}>Used for liquidity and planning metrics. Renaming the account never changes this role.</Text>
        <View style={styles.hideRow}>
          <View style={{ flex: 1, paddingRight: 12 }}>
            <Text style={styles.hideLabel}>Hide account</Text>
            <Text style={styles.hintText}>Removes it from lists and net worth.</Text>
          </View>
          <Switch testID="account-hidden-switch" value={hidden} onValueChange={setHidden} disabled={inputLocked} trackColor={{ true: colors.accent }} />
        </View>
        <MutationFieldError error={form.getFieldError('hidden')} testID="account-hidden-error" />
        <MutationFormBanner outcome={form.outcome} onRetry={form.retry} onRefetch={() => accounts.refetch()} />
        <MutationSubmitButton
          testID="account-save-button"
          label="Save"
          pendingLabel="Saving…"
          onPress={() => form.submit()}
          disabled={inputLocked}
        />
      </MutationSheet>
    </View>
  );
}

const styles = StyleSheet.create({
  root: { flex: 1, backgroundColor: colors.bg },
  hero: { marginBottom: 12, marginTop: 4 },
  heroLabel: { color: colors.muted, fontSize: 11, fontWeight: '700', letterSpacing: 1 },
  heroValue: { fontSize: 38, fontWeight: '800', letterSpacing: -1.5, marginTop: 4 },
  heroSub: { color: colors.muted, fontSize: 13, marginTop: 4 },
  sectionHeader: { color: colors.muted, fontSize: 12, fontWeight: '700', paddingTop: 14, paddingBottom: 4 },
  row: { flexDirection: 'row', alignItems: 'center', gap: 12, paddingVertical: 10, borderBottomWidth: StyleSheet.hairlineWidth, borderBottomColor: colors.border },
  mid: { flex: 1, minWidth: 0 },
  payeeLine: { flexDirection: 'row', alignItems: 'center', gap: 6 },
  payee: { color: colors.text, fontSize: 15, fontWeight: '600' },
  sub: { color: colors.muted, fontSize: 12, marginTop: 2 },
  amt: { fontSize: 15, fontWeight: '700' },
  editBtn: { color: colors.accentLight, fontSize: 16, fontWeight: '600' },
  label: { color: colors.muted, fontSize: 12, fontWeight: '600', marginBottom: 6, textTransform: 'uppercase', letterSpacing: 0.5 },
  input: { backgroundColor: colors.surface2, borderColor: colors.border, borderWidth: 1, borderRadius: 8, color: colors.text, paddingHorizontal: 12, paddingVertical: 10, fontSize: 15 },
  hintText: { color: colors.muted, fontSize: 11, marginTop: 8, lineHeight: 16 },
  roleWrap: { flexDirection: 'row', flexWrap: 'wrap', gap: 8 },
  roleChip: { paddingHorizontal: 10, paddingVertical: 8, borderRadius: 9, backgroundColor: colors.surface2, borderWidth: 1, borderColor: colors.border },
  roleChipOn: { backgroundColor: colors.accent, borderColor: colors.accent },
  roleText: { color: colors.muted, fontSize: 12, fontWeight: '700' },
  roleTextOn: { color: '#fff' },
  hideRow: { flexDirection: 'row', alignItems: 'center', marginTop: 18, paddingTop: 14, borderTopWidth: StyleSheet.hairlineWidth, borderTopColor: colors.border },
  hideLabel: { color: colors.text, fontSize: 15, fontWeight: '600' },
});
