import React, { useCallback, useMemo, useState } from 'react';
import { Pressable, StyleSheet, Text, TextInput, useWindowDimensions, View } from 'react-native';
import { useSafeAreaInsets } from 'react-native-safe-area-context';
import { useBudgets, useSetBudget, useTrends } from '@/api/hooks/finance.hooks';
import { BudgetCategory } from '@/api/generated/types';
import {
  MutationFieldError,
  MutationFormBanner,
  MutationLiveRegion,
  MutationSheet,
  MutationSubmitButton,
} from '@/components/mutation-form';
import { PushScreen } from '@/components/screen';
import { QueryRefetchBanners, resolveQueryDisplay } from '@/components/query-display';
import { Card, CardTitle, EmptyState, ErrorState } from '@/components/ui';
import { SkeletonList } from '@/components/skeleton';
import { GroupedBars, MonthNavigator, ProgressBar, trendPeriodComplete } from '@/components/charts';
import { categoryEnvelopeDebtDisplay, categoryReserveDisplay } from '@/lib/budget-category-display';
import { useMutationForm } from '@/hooks/useMutationForm';
import { FORM_SCREEN_PATH_OVERRIDES } from '@/lib/mutation-form-field-paths';
import { haptics } from '@/lib/haptics';
import { collectFieldErrors, parseStrictMoneyDollars, validateMoneyField } from '@/lib/mutation-form-validation';
import { useCurrentMonthKey, useSelectedMonth } from '@/lib/selectedMonth';
import { colors, fmtPos } from '@/theme/colors';

type Editing = (BudgetCategory & { groupName: string }) | null;
const statusColor = (s?: BudgetCategory['status']) => s === 'over' ? colors.red : s === 'watch' ? colors.yellow : s === 'snoozed' ? colors.muted : colors.green;
const statusLabel = (s?: BudgetCategory['status']) => s === 'over' ? 'Over' : s === 'watch' ? 'Watch' : s === 'snoozed' ? 'Snoozed' : 'On track';
const metaLabel = (c: BudgetCategory) => {
  const parts: string[] = [];
  if (c.rolloverMode && c.rolloverMode !== 'none') parts.push(c.rolloverMode === 'true_expense' ? 'true expense' : 'rollover');
  if (c.trueExpenseCadence) parts.push(c.trueExpenseCadence);
  if (c.priority) parts.push(c.priority);
  return parts.join(' · ');
};

export default function Budgets() {
  const { width } = useWindowDimensions();
  const insets = useSafeAreaInsets();
  const curKey = useCurrentMonthKey();
  const [month, setMonth] = useSelectedMonth();
  // Current month keeps hitting the warmed `budgets-current` cache (month=undefined).
  const apiMonth = month === curKey ? undefined : month;
  const trends = useTrends(60);
  const budgets = useBudgets(apiMonth);
  const setBudget = useSetBudget();

  const [editing, setEditing] = useState<Editing>(null);
  const [targetText, setTargetText] = useState('');

  const onRefresh = () => Promise.all([trends.refetch(), budgets.refetch()]);

  const allMonths = useMemo(() => trends.data?.months ?? [], [trends.data?.months]);
  const monthComplete = trendPeriodComplete;
  // Bars/navigation span exactly as far back as there's data.
  const availMonths = useMemo(() => {
    let i = 0;
    while (i < allMonths.length && (allMonths[i].spend == null || allMonths[i].spend === 0) && (allMonths[i].income == null || allMonths[i].income === 0)) i++;
    const trimmed = allMonths.slice(i).map((m) => ({
      month: m.month,
      spend: monthComplete(m) ? m.spend! : null,
    }));
    return trimmed.length ? trimmed : [{ month: curKey, spend: 0 }];
  }, [allMonths, curKey, monthComplete]);

  // Income vs spending chart keeps the most recent 12 months.
  const chart = allMonths.slice(-12);
  const labels = chart.map((m) => m.month.slice(5));
  const income = chart.map((m) => (monthComplete(m) ? m.income! : null));
  const spend = chart.map((m) => (monthComplete(m) ? m.spend! : null));
  const chartHasIncomplete = chart.some((m) => !monthComplete(m));

  const b = budgets.data;
  const hasTargets = (b?.totalTarget ?? b?.totalBudgeted ?? 0) > 0;
  const budgetsDisplay = resolveQueryDisplay(budgets);

  const fields = useMemo(() => ({
    targetText,
    categoryId: editing?.id ?? '',
    month: b?.month,
  }), [b?.month, editing?.id, targetText]);

  const applyFields = useCallback((updater: React.SetStateAction<typeof fields>) => {
    const prev = { targetText, categoryId: editing?.id ?? '', month: b?.month };
    const next = typeof updater === 'function' ? updater(prev) : updater;
    if (next.targetText !== undefined) setTargetText(String(next.targetText));
  }, [b?.month, editing?.id, targetText]);

  const form = useMutationForm({
    formId: editing ? `budget-${editing.id}-${month}` : 'budget-none',
    fields,
    setFields: applyFields,
    persistDraft: false,
    mutation: setBudget,
    mutationLabel: 'Save budget',
    fieldOrder: ['targetText'],
    fieldPathOverrides: FORM_SCREEN_PATH_OVERRIDES.budgets,
    onSuccessClose: () => setEditing(null),
    onRefetch: () => budgets.refetch(),
    validate: (f) => collectFieldErrors({
      targetText: validateMoneyField(f.targetText, { label: 'Target', allowZero: true }),
    }),
    buildVariables: (f) => ({
      month: f.month as string | undefined,
      categoryId: String(f.categoryId),
      amount: parseStrictMoneyDollars(String(f.targetText), { allowZero: true }) ?? 0,
    }),
  });

  const save = () => form.submit();
  const closeSheet = () => {
    form.requestDismiss(() => setEditing(null));
  };
  const inputLocked = form.isLocked;

  const openEdit = (c: BudgetCategory, groupName: string) => {
    if (inputLocked) return;
    haptics.tap();
    form.clearErrors();
    setEditing({ ...c, groupName });
    setTargetText(c.budgeted > 0 ? String(c.budgeted) : '');
  };

  return (
    <PushScreen testID="budgets-screen" onRefresh={onRefresh}>
      <MutationLiveRegion message={form.announce} />
      <MonthNavigator months={availMonths} selected={month} onSelect={setMonth} currentKey={curKey} disabled={inputLocked} />
      {chart.length > 1 ? (
        <Card style={{ marginBottom: 20 }}>
          <CardTitle>Income vs Spending · 12 mo</CardTitle>
          {chartHasIncomplete ? <Text style={styles.incompleteNote} accessibilityRole="text">Some months unavailable — transfer identity unresolved</Text> : null}
          <GroupedBars width={width - 64} labels={labels} seriesA={income} seriesB={spend} />
          <View style={styles.legend}>
            <View style={styles.legendItem}><View style={[styles.legendDot, { backgroundColor: colors.green }]} /><Text style={styles.legendText}>Income</Text></View>
            <View style={styles.legendItem}><View style={[styles.legendDot, { backgroundColor: colors.red }]} /><Text style={styles.legendText}>Spending</Text></View>
          </View>
        </Card>
      ) : null}

      <CardTitle>By Category{b ? ` · ${b.month}` : ''}</CardTitle>
      <QueryRefetchBanners queries={[budgets, trends]} testID="budgets-refetch-banner" />
      {budgetsDisplay.initialLoad ? (
        <SkeletonList rows={6} />
      ) : budgetsDisplay.fatalError ? (
        <ErrorState error={budgetsDisplay.errorMessage} onRetry={onRefresh} />
      ) : !b || !b.groups.length ? (
        <EmptyState icon="chart.pie">No budget data</EmptyState>
      ) : (
        <>
          <Text style={styles.note}>
            {hasTargets ? 'Tap a category to adjust its monthly target. Target health uses Actual plus optional budget-settings.json metadata.' : 'No monthly targets set — tap a category to add one.'}
          </Text>
          <Card style={styles.summaryCard}>
            <View style={styles.summaryItem}>
              <Text style={styles.summaryLabel}>Remaining</Text>
              <Text style={[styles.summaryValue, { color: (b.totalRemaining ?? 0) >= 0 ? colors.green : colors.red }]}>{fmtPos(b.totalRemaining ?? 0)}</Text>
            </View>
            <View style={styles.summaryItem}>
              <Text style={styles.summaryLabel}>Projected</Text>
              <Text style={[styles.summaryValue, { color: statusColor(b.status) }]}>{fmtPos(b.totalProjected ?? b.totalSpent)}</Text>
            </View>
            <View style={styles.summaryItem}>
              <Text style={styles.summaryLabel}>Status</Text>
              <Text style={[styles.summaryValue, { color: statusColor(b.status) }]}>{statusLabel(b.status)}</Text>
            </View>
          </Card>
          {b.groups.map((g) => {
            const groupMax = Math.max(...g.categories.map((c) => c.spent), 1);
            return (
              <Card key={g.id} style={{ marginBottom: 12 }}>
                <View style={styles.groupHead}>
                  <Text style={styles.groupName}>{g.name}</Text>
                  <Text style={[styles.groupAmt, { color: statusColor(g.status) }]}>{hasTargets ? `${fmtPos(g.spent)} / ${fmtPos(g.target ?? g.budgeted)}` : fmtPos(g.spent)}</Text>
                </View>
                {g.categories.map((c) => {
                  const target = c.target ?? c.budgeted;
                  const pct = hasTargets && target > 0 ? (c.spent / target) * 100 : (c.spent / groupMax) * 100;
                  const meta = metaLabel(c);
                  const reserveDisplay = categoryReserveDisplay(c);
                  const debtDisplay = categoryEnvelopeDebtDisplay(c.envelopeDebt);
                  const reserveMeta = reserveDisplay.kind === 'unavailable'
                    ? 'reserve unavailable'
                    : `reserve ${fmtPos(reserveDisplay.dollars)}`;
                  const reserveAccessibility = reserveDisplay.kind === 'unavailable'
                    ? 'Reserve unavailable. Rollover policy unresolved.'
                    : `Reserve ${fmtPos(reserveDisplay.dollars)}`;
                  return (
                    <Pressable
                      testID={`budgets-category-${c.id}`}
                      key={c.id}
                      style={({ pressed }) => [styles.catRow, pressed && !inputLocked && { opacity: 0.6 }, inputLocked && { opacity: 0.5 }]}
                      onPress={() => openEdit(c, g.name)}
                      disabled={inputLocked}
                    >
                      <View style={styles.catTop}>
                        <Text style={styles.catName}>{c.name}</Text>
                        <Text style={[styles.catAmt, { color: statusColor(c.status) }]}>
                          {target > 0 ? `${fmtPos(c.spent)} / ${fmtPos(target)}` : `${fmtPos(c.spent)} · set target`}
                          {` · ${statusLabel(c.status)}`}
                          {'  ›'}
                        </Text>
                      </View>
                      <ProgressBar pct={pct} over={hasTargets && c.over} />
                      <View style={styles.catMetaRow}>
                        <Text
                          style={styles.catMeta}
                          accessibilityRole="text"
                          accessibilityLabel={`Left ${fmtPos(c.remaining ?? 0)}. ${reserveAccessibility}. Projected ${fmtPos(c.projected ?? c.spent)}. ${fmtPos(c.dailyPace ?? 0)} per day.`}
                        >
                          Left {fmtPos(c.remaining ?? 0)} ·{' '}
                          <Text style={reserveDisplay.kind === 'unavailable' ? styles.reserveUnavailable : undefined}>
                            {reserveMeta}
                          </Text>
                          {' · projected '}{fmtPos(c.projected ?? c.spent)} · {fmtPos(c.dailyPace ?? 0)}/day
                        </Text>
                        {debtDisplay.show ? (
                          <Text style={styles.debtMeta} accessibilityRole="text">
                            Advisory envelope debt {fmtPos(debtDisplay.dollars!)}
                          </Text>
                        ) : null}
                        {meta ? <Text style={styles.catMeta}>{meta}</Text> : null}
                      </View>
                    </Pressable>
                  );
                })}
              </Card>
            );
          })}
        </>
      )}

      <MutationSheet
        visible={!!editing}
        title={editing?.name ?? 'Budget'}
        testID="budgets-edit-sheet"
        bottomInset={insets.bottom}
        canDismiss={form.canDismiss}
        onRequestClose={closeSheet}
      >
        <MutationFormBanner outcome={form.outcome} onRetry={form.retry} onRefetch={() => budgets.refetch()} />
        <Text style={styles.sheetSub}>{editing?.groupName} · spent {editing ? fmtPos(editing.spent) : ''} · projected {editing ? fmtPos(editing.projected ?? editing.spent) : ''}</Text>

        <Text style={[styles.field, form.getFieldError('targetText') && { color: '#ff6b6b' }]}>Monthly target</Text>
        <View style={styles.inputRow}>
          <Text style={styles.dollar}>$</Text>
          <TextInput
            testID="budgets-target-input"
            style={[styles.input, form.getFieldError('targetText') && { borderColor: '#ff6b6b' }]}
            value={targetText}
            onChangeText={setTargetText}
            editable={!inputLocked}
            placeholder="0"
            placeholderTextColor={colors.muted}
            keyboardType="decimal-pad"
            autoFocus
            accessibilityLabel="Monthly target"
          />
        </View>
        <MutationFieldError error={form.getFieldError('targetText')} testID="budgets-target-error" />

        <MutationSubmitButton
          testID="budgets-save-target-button"
          label="Save target"
          pendingLabel="Saving…"
          onPress={save}
          disabled={inputLocked}
        />
        <Pressable
          testID="budgets-clear-target-button"
          style={({ pressed }) => [styles.clearBtn, pressed && !inputLocked && { opacity: 0.7 }, inputLocked && { opacity: 0.5 }]}
          onPress={() => { if (inputLocked) return; setTargetText('0'); }}
          disabled={inputLocked}
        >
          <Text style={styles.clearText}>Clear target</Text>
        </Pressable>
      </MutationSheet>
    </PushScreen>
  );
}

const styles = StyleSheet.create({
  legend: { flexDirection: 'row', gap: 16, marginTop: 8, justifyContent: 'center' },
  legendItem: { flexDirection: 'row', alignItems: 'center', gap: 6 },
  legendDot: { width: 8, height: 8, borderRadius: 4 },
  legendText: { color: colors.muted, fontSize: 11 },
  incompleteNote: { color: colors.muted, fontSize: 11, marginBottom: 8 },
  note: { color: colors.muted, fontSize: 12, marginBottom: 12 },
  summaryCard: { flexDirection: 'row', gap: 10, marginBottom: 12 },
  summaryItem: { flex: 1 },
  summaryLabel: { color: colors.muted, fontSize: 11, fontWeight: '700', textTransform: 'uppercase' },
  summaryValue: { color: colors.text, fontSize: 15, fontWeight: '800', marginTop: 4 },
  groupHead: { flexDirection: 'row', justifyContent: 'space-between', marginBottom: 10 },
  groupName: { color: colors.text, fontSize: 14, fontWeight: '700' },
  groupAmt: { color: colors.muted, fontSize: 13 },
  catRow: { marginBottom: 10 },
  catTop: { flexDirection: 'row', justifyContent: 'space-between', marginBottom: 4 },
  catName: { color: colors.text, fontSize: 12 },
  catAmt: { color: colors.muted, fontSize: 12 },
  catMetaRow: { marginTop: 5, gap: 2 },
  catMeta: { color: colors.muted, fontSize: 11 },
  reserveUnavailable: { color: colors.yellow, fontStyle: 'italic' },
  debtMeta: { color: colors.yellow, fontSize: 11 },
  modalBg: { flex: 1, backgroundColor: 'rgba(0,0,0,0.6)', justifyContent: 'flex-end' },
  sheet: { backgroundColor: colors.surface, borderTopLeftRadius: 18, borderTopRightRadius: 18, padding: 16 },
  sheetTitle: { color: colors.text, fontSize: 17, fontWeight: '700' },
  sheetSub: { color: colors.muted, fontSize: 12, marginTop: 4, marginBottom: 8 },
  field: { color: colors.muted, fontSize: 12, fontWeight: '600', marginTop: 12, marginBottom: 6 },
  inputRow: { flexDirection: 'row', alignItems: 'center', backgroundColor: colors.surface2, borderColor: colors.border, borderWidth: 1, borderRadius: 10, paddingHorizontal: 12 },
  dollar: { color: colors.muted, fontSize: 18, fontWeight: '700', marginRight: 4 },
  input: { flex: 1, color: colors.text, paddingVertical: 12, fontSize: 18, fontWeight: '700' },
  saveBtn: { backgroundColor: colors.accent, borderRadius: 12, padding: 14, alignItems: 'center', marginTop: 18 },
  saveText: { color: '#fff', fontSize: 15, fontWeight: '700' },
  clearBtn: { padding: 12, alignItems: 'center', marginTop: 4 },
  clearText: { color: colors.muted, fontSize: 14, fontWeight: '600' },
});
