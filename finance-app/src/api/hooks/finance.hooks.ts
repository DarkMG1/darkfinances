import { useQueryClient } from '@tanstack/react-query';
import { useFinanceMutation, useFinanceQuery } from '@/api/client/requests';
import { getServerAuthHeaders } from '@/api/client/server-auth';
import { getServerBaseUrl } from '@/api/client/server-url';
import { useServerConfig } from '@/state/server';
import { API_ENDPOINTS } from '@/api/generated/endpoints';
import {
  Account,
  Bills,
  Budgets,
  CategorizeResult,
  Category,
  CreateTransactionInput,
  Goal,
  GoalInput,
  Income,
  Insights,
  ManualAssets,
  MerchantHistory,
  OkResult,
  Receipt,
  Receipts,
  ReconcilePending,
  Reconciliation,
  Recurring,
  RecurringStatus,
  ReimbLinks,
  EventsResponse,
  ReimbTxnRef,
  Reimbursement,
  ReimbursementLedger,
  RepaymentSuggestions,
  Rules,
  TripEvent,
  SearchResult,
  Spending,
  Tags,
  Transaction,
  TransactionDetail,
  Trends,
} from '@/api/generated/types';

export function useAccounts() {
  return useFinanceQuery<Account[]>({
    endpoint: API_ENDPOINTS.accounts.endpoint,
    method: API_ENDPOINTS.accounts.method,
    queryKey: [API_ENDPOINTS.accounts.key],
    staleTime: 60_000,
  });
}

export function useTransactions(
  params: { start?: string; end?: string; accountId?: string; category?: string; collapse?: boolean } = {}
) {
  const query = { ...params, collapse: params.collapse ? 1 : undefined };
  return useFinanceQuery<Transaction[]>({
    endpoint: API_ENDPOINTS.transactions.endpoint,
    method: API_ENDPOINTS.transactions.method,
    params: query,
    queryKey: [API_ENDPOINTS.transactions.key, params.start, params.end, params.accountId, params.category, params.collapse ? 'c' : 'x'],
    staleTime: 60_000,
  });
}

// One transaction (parent or simple) with its split legs — powers the detail view
// and split editor. Needs accountId + date to locate it cheaply on the backend.
export function useTransaction(id?: string, accountId?: string, date?: string) {
  return useFinanceQuery<TransactionDetail>({
    endpoint: `/api/v1/transactions/${encodeURIComponent(id ?? '')}`,
    method: 'GET',
    params: { accountId, date },
    queryKey: [API_ENDPOINTS.transactionById.key, id, accountId, date],
    enabled: !!id && !!accountId && !!date,
    staleTime: 15_000,
  });
}

// Per-merchant spending history for the "See History" screen.
export function useMerchantHistory(payee?: string, months = 12) {
  return useFinanceQuery<MerchantHistory>({
    endpoint: API_ENDPOINTS.merchantHistory.endpoint,
    method: API_ENDPOINTS.merchantHistory.method,
    params: { payee, months },
    queryKey: [API_ENDPOINTS.merchantHistory.key, payee ?? '', months],
    enabled: !!payee,
    staleTime: 120_000,
  });
}

export function useSpending(month?: string) {
  return useFinanceQuery<Spending>({
    endpoint: API_ENDPOINTS.spending.endpoint,
    method: API_ENDPOINTS.spending.method,
    params: month ? { month } : undefined,
    queryKey: [API_ENDPOINTS.spending.key, month ?? 'current'],
    staleTime: 60_000,
  });
}

export function useTrends(months = 12) {
  return useFinanceQuery<Trends>({
    endpoint: API_ENDPOINTS.trends.endpoint,
    method: API_ENDPOINTS.trends.method,
    params: { months },
    queryKey: [API_ENDPOINTS.trends.key, months],
    staleTime: 300_000,
  });
}

export function useBudgets(month?: string) {
  return useFinanceQuery<Budgets>({
    endpoint: API_ENDPOINTS.budgets.endpoint,
    method: API_ENDPOINTS.budgets.method,
    params: month ? { month } : undefined,
    queryKey: [API_ENDPOINTS.budgets.key, month ?? 'current'],
    staleTime: 120_000,
  });
}

// `from`/`to` scope the headline summary window (fronted / paid back / net).
// The People list stays lifetime regardless. Omit both for the all-time summary.
export function useReimbursement(params: { from?: string; to?: string } = {}) {
  const q = { from: params.from, to: params.to };
  return useFinanceQuery<Reimbursement>({
    endpoint: API_ENDPOINTS.reimbursement.endpoint,
    method: API_ENDPOINTS.reimbursement.method,
    params: q.from || q.to ? q : undefined,
    queryKey: [API_ENDPOINTS.reimbursement.key, params.from ?? 'all', params.to ?? 'all'],
    staleTime: 120_000,
  });
}

// Month-scoped, per-person ledger of fronted charges + paybacks applied (the
// Rocket-Money "zero it out" view). `month` undefined = current month.
export function useReimbursementLedger(month?: string) {
  return useFinanceQuery<ReimbursementLedger>({
    endpoint: API_ENDPOINTS.reimbursementLedger.endpoint,
    method: API_ENDPOINTS.reimbursementLedger.method,
    params: month ? { month } : undefined,
    queryKey: [API_ENDPOINTS.reimbursementLedger.key, month ?? 'current'],
    staleTime: 60_000,
  });
}

// ---- Monthly reconciliation ----------------------------------------------
export function useReconciliation(month?: string) {
  return useFinanceQuery<Reconciliation>({
    endpoint: API_ENDPOINTS.reconciliation.endpoint,
    method: API_ENDPOINTS.reconciliation.method,
    params: month ? { month } : undefined,
    queryKey: [API_ENDPOINTS.reconciliation.key, month ?? 'current'],
    staleTime: 30_000,
  });
}

// Drives the home nag banner: the previous month if it still needs closing.
export function useReconcilePending() {
  return useFinanceQuery<ReconcilePending>({
    endpoint: API_ENDPOINTS.reconcilePending.endpoint,
    method: API_ENDPOINTS.reconcilePending.method,
    queryKey: [API_ENDPOINTS.reconcilePending.key],
    staleTime: 60_000,
  });
}

export interface SetReconItemVars { month: string; id: string; reconciled: boolean }
export function useSetReconcileItem() {
  const qc = useQueryClient();
  return useFinanceMutation<OkResult, SetReconItemVars>({
    endpoint: API_ENDPOINTS.setReconcileItem.endpoint,
    method: 'POST',
    // Optimistically flip the checkbox so tapping down a long list feels instant.
    onMutate: async (v) => {
      const key = [API_ENDPOINTS.reconciliation.key, v.month];
      await qc.cancelQueries({ queryKey: key });
      const prev = qc.getQueryData<Reconciliation>(key);
      if (prev) {
        const items = prev.items.map((it) => (it.id === v.id ? { ...it, reconciled: v.reconciled } : it));
        const reconciledCount = items.filter((it) => it.reconciled).length;
        qc.setQueryData<Reconciliation>(key, { ...prev, items, reconciledCount, remaining: items.length - reconciledCount, done: v.reconciled ? prev.done : false });
      }
      return { prev, key } as { prev?: Reconciliation; key: (string | undefined)[] };
    },
    onError: (_e, _v, ctx) => {
      const c = ctx as { prev?: Reconciliation; key: (string | undefined)[] } | undefined;
      if (c?.prev) qc.setQueryData(c.key, c.prev);
    },
    onSuccess: async () => { await qc.invalidateQueries({ queryKey: [API_ENDPOINTS.reconcilePending.key] }); },
  });
}

export function useSetReconcileMonth() {
  const qc = useQueryClient();
  return useFinanceMutation<OkResult, { month: string; done?: boolean }>({
    endpoint: API_ENDPOINTS.setReconcileMonth.endpoint,
    method: 'POST',
    onSuccess: async () => {
      await Promise.all([
        qc.invalidateQueries({ queryKey: [API_ENDPOINTS.reconciliation.key] }),
        qc.invalidateQueries({ queryKey: [API_ENDPOINTS.reconcilePending.key] }),
      ]);
    },
  });
}

export function useSetReconcileEnabled() {
  const qc = useQueryClient();
  return useFinanceMutation<OkResult, { enabled: boolean }>({
    endpoint: API_ENDPOINTS.setReconcileEnabled.endpoint,
    method: 'POST',
    onSuccess: async () => {
      await Promise.all([
        qc.invalidateQueries({ queryKey: [API_ENDPOINTS.reconciliation.key] }),
        qc.invalidateQueries({ queryKey: [API_ENDPOINTS.reconcilePending.key] }),
      ]);
    },
  });
}

export function useInsights(month?: string) {
  return useFinanceQuery<Insights>({
    endpoint: API_ENDPOINTS.insights.endpoint,
    method: API_ENDPOINTS.insights.method,
    params: month ? { month } : undefined,
    queryKey: [API_ENDPOINTS.insights.key, month ?? 'current'],
    staleTime: 120_000,
  });
}

export function useCategories() {
  return useFinanceQuery<Category[]>({
    endpoint: API_ENDPOINTS.categories.endpoint,
    method: API_ENDPOINTS.categories.method,
    queryKey: [API_ENDPOINTS.categories.key],
    staleTime: 600_000,
  });
}

export function useRecurring(window?: number) {
  return useFinanceQuery<Recurring>({
    endpoint: API_ENDPOINTS.recurring.endpoint,
    method: API_ENDPOINTS.recurring.method,
    params: window ? { window } : undefined,
    queryKey: [API_ENDPOINTS.recurring.key, window ?? 'default'],
    staleTime: 300_000,
  });
}

export function useBills(days?: number) {
  return useFinanceQuery<Bills>({
    endpoint: API_ENDPOINTS.bills.endpoint,
    method: API_ENDPOINTS.bills.method,
    params: days ? { days } : undefined,
    queryKey: [API_ENDPOINTS.bills.key, days ?? 'default'],
    staleTime: 300_000,
  });
}

export function useIncome(window?: number) {
  return useFinanceQuery<Income>({
    endpoint: API_ENDPOINTS.income.endpoint,
    method: API_ENDPOINTS.income.method,
    params: window ? { window } : undefined,
    queryKey: [API_ENDPOINTS.income.key, window ?? 'default'],
    staleTime: 300_000,
  });
}

export function useSearch(q: string) {
  return useFinanceQuery<SearchResult>({
    endpoint: API_ENDPOINTS.search.endpoint,
    method: API_ENDPOINTS.search.method,
    params: { q },
    queryKey: [API_ENDPOINTS.search.key, q],
    enabled: q.trim().length >= 2,
    staleTime: 30_000,
  });
}

export function useTags() {
  return useFinanceQuery<Tags>({
    endpoint: API_ENDPOINTS.tags.endpoint,
    method: API_ENDPOINTS.tags.method,
    queryKey: [API_ENDPOINTS.tags.key],
    staleTime: 120_000,
  });
}

export function useGoals() {
  return useFinanceQuery<Goal[]>({
    endpoint: API_ENDPOINTS.goals.endpoint,
    method: API_ENDPOINTS.goals.method,
    queryKey: [API_ENDPOINTS.goals.key],
    staleTime: 60_000,
  });
}

export interface SetCategoryVars {
  id: string;
  categoryId: string;
  isLeg?: boolean;
  parentId?: string | null;
  accountId?: string;
  date?: string;
}

export function useSetCategory() {
  const qc = useQueryClient();
  return useFinanceMutation<CategorizeResult, SetCategoryVars>({
    endpoint: (v) => `/api/v1/transactions/${encodeURIComponent(v.id)}/category`,
    method: 'POST',
    onSuccess: async () => {
      await Promise.all([
        qc.invalidateQueries({ queryKey: [API_ENDPOINTS.transactions.key] }),
        qc.invalidateQueries({ queryKey: [API_ENDPOINTS.spending.key] }),
        qc.invalidateQueries({ queryKey: [API_ENDPOINTS.insights.key] }),
        qc.invalidateQueries({ queryKey: [API_ENDPOINTS.budgets.key] }),
      ]);
    },
  });
}

export interface SetBudgetVars {
  month?: string;
  categoryId: string;
  amount: number;
}

export function useSetBudget() {
  const qc = useQueryClient();
  return useFinanceMutation<OkResult, SetBudgetVars>({
    endpoint: API_ENDPOINTS.setBudget.endpoint,
    method: 'POST',
    onSuccess: async () => {
      await Promise.all([
        qc.invalidateQueries({ queryKey: [API_ENDPOINTS.budgets.key] }),
        qc.invalidateQueries({ queryKey: [API_ENDPOINTS.insights.key] }),
      ]);
    },
  });
}

export interface SetRecurringVars {
  key: string;
  status?: RecurringStatus | null;
  hidden?: boolean;
  forced?: boolean;
  isBill?: boolean | null;
}

export function useSetRecurringOverride() {
  const qc = useQueryClient();
  return useFinanceMutation<OkResult, SetRecurringVars>({
    endpoint: (v) => `/api/v1/recurring/${encodeURIComponent(v.key)}/override`,
    method: 'POST',
    onSuccess: async () => {
      await Promise.all([
        qc.invalidateQueries({ queryKey: [API_ENDPOINTS.recurring.key] }),
        qc.invalidateQueries({ queryKey: [API_ENDPOINTS.bills.key] }),
      ]);
    },
  });
}

export interface MarkRecurringVars {
  payee: string;
  isBill?: boolean;
}

export function useMarkRecurring() {
  const qc = useQueryClient();
  return useFinanceMutation<OkResult, MarkRecurringVars>({
    endpoint: API_ENDPOINTS.markRecurring.endpoint,
    method: 'POST',
    onSuccess: async () => {
      await Promise.all([
        qc.invalidateQueries({ queryKey: [API_ENDPOINTS.recurring.key] }),
        qc.invalidateQueries({ queryKey: [API_ENDPOINTS.bills.key] }),
      ]);
    },
  });
}

export interface SplitLegInput {
  id?: string; // present for existing legs (kept stable on edit); omit to add one
  amount: number; // signed dollars (matches the parent's sign)
  categoryId?: string | null;
  name?: string; // per-leg display name
  notes?: string;
}
export interface SplitVars {
  id: string;
  accountId: string;
  date: string;
  legs: SplitLegInput[];
}

// Everything a split/unsplit touches: lists, the single-txn detail, spending, etc.
function invalidateAfterSplit(qc: ReturnType<typeof useQueryClient>) {
  return Promise.all([
    qc.invalidateQueries({ queryKey: [API_ENDPOINTS.transactions.key] }),
    qc.invalidateQueries({ queryKey: [API_ENDPOINTS.transactionById.key] }),
    qc.invalidateQueries({ queryKey: [API_ENDPOINTS.spending.key] }),
    qc.invalidateQueries({ queryKey: [API_ENDPOINTS.insights.key] }),
    qc.invalidateQueries({ queryKey: [API_ENDPOINTS.budgets.key] }),
    qc.invalidateQueries({ queryKey: [API_ENDPOINTS.reimbLinks.key] }),
  ]);
}

export function useSplitTransaction() {
  const qc = useQueryClient();
  return useFinanceMutation<OkResult, SplitVars>({
    endpoint: (v) => `/api/v1/transactions/${encodeURIComponent(v.id)}/split`,
    method: 'POST',
    onSuccess: async () => {
      await invalidateAfterSplit(qc);
    },
  });
}

export interface UnsplitVars {
  id: string;
  accountId: string;
  date: string;
  categoryId?: string | null;
}
export function useUnsplitTransaction() {
  const qc = useQueryClient();
  return useFinanceMutation<OkResult, UnsplitVars>({
    endpoint: (v) => `/api/v1/transactions/${encodeURIComponent(v.id)}/unsplit`,
    method: 'POST',
    onSuccess: async () => {
      await invalidateAfterSplit(qc);
    },
  });
}

// Permanently delete a transaction. Removing one shifts balances, net worth,
// spending, and budgets, so refresh all of them. accountId+date let the backend
// enforce the "only manual rows are deletable" guard.
export function useDeleteTransaction() {
  const qc = useQueryClient();
  return useFinanceMutation<OkResult, { id: string; accountId?: string; date?: string }>({
    endpoint: (v) => {
      const qs = new URLSearchParams();
      if (v.accountId) qs.set('accountId', v.accountId);
      if (v.date) qs.set('date', v.date);
      const q = qs.toString();
      return `/api/v1/transactions/${encodeURIComponent(v.id)}${q ? `?${q}` : ''}`;
    },
    method: 'DELETE',
    onSuccess: async () => {
      await Promise.all([
        qc.invalidateQueries({ queryKey: [API_ENDPOINTS.transactions.key] }),
        qc.invalidateQueries({ queryKey: [API_ENDPOINTS.accounts.key] }),
        qc.invalidateQueries({ queryKey: [API_ENDPOINTS.spending.key] }),
        qc.invalidateQueries({ queryKey: [API_ENDPOINTS.insights.key] }),
        qc.invalidateQueries({ queryKey: [API_ENDPOINTS.trends.key] }),
        qc.invalidateQueries({ queryKey: [API_ENDPOINTS.budgets.key] }),
      ]);
    },
  });
}

export interface SetPayeeVars {
  id: string;
  payee: string;
  isLeg?: boolean;
  parentId?: string | null;
  accountId?: string;
  date?: string;
}
export function useSetPayee() {
  const qc = useQueryClient();
  return useFinanceMutation<OkResult, SetPayeeVars>({
    endpoint: (v) => `/api/v1/transactions/${encodeURIComponent(v.id)}/payee`,
    method: 'POST',
    onSuccess: async () => {
      await Promise.all([
        qc.invalidateQueries({ queryKey: [API_ENDPOINTS.transactions.key] }),
        qc.invalidateQueries({ queryKey: [API_ENDPOINTS.transactionById.key] }),
        qc.invalidateQueries({ queryKey: [API_ENDPOINTS.search.key] }),
        qc.invalidateQueries({ queryKey: [API_ENDPOINTS.insights.key] }),
      ]);
    },
  });
}

// Manual "Sync with bank" — pull fresh transactions then refresh everything.
export function useBankSync() {
  const qc = useQueryClient();
  return useFinanceMutation<{ ok: boolean; warning?: string | null; at?: string; phantom?: { deletedCount: number } | null }, void>({
    endpoint: API_ENDPOINTS.bankSync.endpoint,
    method: 'POST',
    onSuccess: async () => {
      await qc.invalidateQueries();
    },
  });
}

export function useRules() {
  return useFinanceQuery<Rules>({
    endpoint: API_ENDPOINTS.rules.endpoint,
    method: API_ENDPOINTS.rules.method,
    queryKey: [API_ENDPOINTS.rules.key],
    staleTime: 60_000,
  });
}

export interface SaveRuleVars {
  match: string;
  categoryId: string;
  categoryName?: string;
}

// Invalidate everything a fresh categorization touches — a rule can recategorize
// many past transactions at once.
function invalidateAfterRules(qc: ReturnType<typeof useQueryClient>) {
  return Promise.all([
    qc.invalidateQueries({ queryKey: [API_ENDPOINTS.rules.key] }),
    qc.invalidateQueries({ queryKey: [API_ENDPOINTS.transactions.key] }),
    qc.invalidateQueries({ queryKey: [API_ENDPOINTS.spending.key] }),
    qc.invalidateQueries({ queryKey: [API_ENDPOINTS.insights.key] }),
    qc.invalidateQueries({ queryKey: [API_ENDPOINTS.budgets.key] }),
  ]);
}

export function useSaveRule() {
  const qc = useQueryClient();
  return useFinanceMutation<OkResult, SaveRuleVars>({
    endpoint: API_ENDPOINTS.saveRule.endpoint,
    method: 'POST',
    onSuccess: async () => {
      await invalidateAfterRules(qc);
    },
  });
}

export function useApplyRules() {
  const qc = useQueryClient();
  return useFinanceMutation<OkResult, void>({
    endpoint: API_ENDPOINTS.applyRules.endpoint,
    method: 'POST',
    onSuccess: async () => {
      await invalidateAfterRules(qc);
    },
  });
}

export function useDeleteRule() {
  const qc = useQueryClient();
  return useFinanceMutation<OkResult, { id: string }>({
    endpoint: (v) => `/api/v1/rules/${encodeURIComponent(v.id)}`,
    method: 'DELETE',
    onSuccess: async () => {
      await qc.invalidateQueries({ queryKey: [API_ENDPOINTS.rules.key] });
    },
  });
}

export function useEvents() {
  return useFinanceQuery<EventsResponse>({
    endpoint: API_ENDPOINTS.events.endpoint,
    method: API_ENDPOINTS.events.method,
    queryKey: [API_ENDPOINTS.events.key],
    staleTime: 60_000,
  });
}

export interface SaveEventVars {
  slug?: string;
  name: string;
  start?: string;
  members?: string;
  group?: string;
}

export function useSaveEvent() {
  const qc = useQueryClient();
  return useFinanceMutation<{ ok: boolean; event: TripEvent }, SaveEventVars>({
    endpoint: API_ENDPOINTS.saveEvent.endpoint,
    method: 'POST',
    onSuccess: async () => {
      await qc.invalidateQueries({ queryKey: [API_ENDPOINTS.events.key] });
    },
  });
}

export function useDeleteEvent() {
  const qc = useQueryClient();
  return useFinanceMutation<OkResult, { slug: string }>({
    endpoint: (v) => `/api/v1/events/${encodeURIComponent(v.slug)}`,
    method: 'DELETE',
    onSuccess: async () => {
      await qc.invalidateQueries({ queryKey: [API_ENDPOINTS.events.key] });
    },
  });
}

export interface SetNotesVars {
  id: string;
  notes: string;
  isLeg?: boolean;
  parentId?: string | null;
  accountId?: string;
  date?: string;
}

export function useSetNotes() {
  const qc = useQueryClient();
  return useFinanceMutation<CategorizeResult, SetNotesVars>({
    endpoint: (v) => `/api/v1/transactions/${encodeURIComponent(v.id)}/notes`,
    method: 'POST',
    onSuccess: async () => {
      // Notes carry #tags, so refresh anything tag-derived too.
      await Promise.all([
        qc.invalidateQueries({ queryKey: [API_ENDPOINTS.transactions.key] }),
        qc.invalidateQueries({ queryKey: [API_ENDPOINTS.tags.key] }),
        qc.invalidateQueries({ queryKey: [API_ENDPOINTS.search.key] }),
        qc.invalidateQueries({ queryKey: [API_ENDPOINTS.insights.key] }),
      ]);
    },
  });
}

export interface SetDateVars {
  id: string;
  date: string;
  isLeg?: boolean;
}
// Moving a date changes which month a txn lands in — refresh spending/insights/
// trends/budgets/reimbursement so the shift shows everywhere at once.
export function useSetDate() {
  const qc = useQueryClient();
  return useFinanceMutation<{ ok: boolean; date: string }, SetDateVars>({
    endpoint: (v) => `/api/v1/transactions/${encodeURIComponent(v.id)}/date`,
    method: 'POST',
    onSuccess: async () => {
      await Promise.all([
        qc.invalidateQueries({ queryKey: [API_ENDPOINTS.transactions.key] }),
        qc.invalidateQueries({ queryKey: [API_ENDPOINTS.transactionById.key] }),
        qc.invalidateQueries({ queryKey: [API_ENDPOINTS.spending.key] }),
        qc.invalidateQueries({ queryKey: [API_ENDPOINTS.insights.key] }),
        qc.invalidateQueries({ queryKey: [API_ENDPOINTS.trends.key] }),
        qc.invalidateQueries({ queryKey: [API_ENDPOINTS.budgets.key] }),
        qc.invalidateQueries({ queryKey: [API_ENDPOINTS.reimbursement.key] }),
      ]);
    },
  });
}

export interface MarkBillVars {
  id?: string;
  key?: string;
  dueDate?: string;
  paid: boolean;
}

export function useMarkBillPaid() {
  const qc = useQueryClient();
  return useFinanceMutation<OkResult, MarkBillVars>({
    endpoint: API_ENDPOINTS.markBillPaid.endpoint,
    method: 'POST',
    onSuccess: async () => {
      await qc.invalidateQueries({ queryKey: [API_ENDPOINTS.bills.key] });
    },
  });
}

export function useReimbLinks(id?: string) {
  return useFinanceQuery<ReimbLinks>({
    endpoint: API_ENDPOINTS.reimbLinks.endpoint,
    method: API_ENDPOINTS.reimbLinks.method,
    params: id ? { id } : undefined,
    queryKey: [API_ENDPOINTS.reimbLinks.key, id],
    enabled: !!id,
    staleTime: 30_000,
  });
}

export interface AddReimbLinkVars {
  inflow: ReimbTxnRef;
  expense: ReimbTxnRef;
}
export function useAddReimbLink() {
  const qc = useQueryClient();
  return useFinanceMutation<OkResult, AddReimbLinkVars>({
    endpoint: API_ENDPOINTS.addReimbLink.endpoint,
    method: 'POST',
    onSuccess: async () => {
      await qc.invalidateQueries({ queryKey: [API_ENDPOINTS.reimbLinks.key] });
    },
  });
}

export interface DeleteReimbLinkVars {
  inflowId: string;
  expenseId: string;
}
export function useDeleteReimbLink() {
  const qc = useQueryClient();
  return useFinanceMutation<OkResult, DeleteReimbLinkVars>({
    endpoint: API_ENDPOINTS.deleteReimbLink.endpoint,
    method: 'DELETE',
    onSuccess: async () => {
      await qc.invalidateQueries({ queryKey: [API_ENDPOINTS.reimbLinks.key] });
    },
  });
}

// Repayment auto-matcher: suggested matches of incoming payments to what people owe.
export function useRepaymentSuggestions() {
  return useFinanceQuery<RepaymentSuggestions>({
    endpoint: API_ENDPOINTS.repaymentSuggestions.endpoint,
    method: API_ENDPOINTS.repaymentSuggestions.method,
    queryKey: [API_ENDPOINTS.repaymentSuggestions.key],
    staleTime: 60_000,
  });
}

// Confirming files the inflow under Reimbursement + writes links, so it touches
// spending/reimbursement/links/transactions — refresh them all.
function invalidateAfterRepayment(qc: ReturnType<typeof useQueryClient>) {
  return Promise.all([
    qc.invalidateQueries({ queryKey: [API_ENDPOINTS.repaymentSuggestions.key] }),
    qc.invalidateQueries({ queryKey: [API_ENDPOINTS.reimbursement.key] }),
    qc.invalidateQueries({ queryKey: [API_ENDPOINTS.reimbLinks.key] }),
    qc.invalidateQueries({ queryKey: [API_ENDPOINTS.transactions.key] }),
    qc.invalidateQueries({ queryKey: [API_ENDPOINTS.transactionById.key] }),
    qc.invalidateQueries({ queryKey: [API_ENDPOINTS.spending.key] }),
    qc.invalidateQueries({ queryKey: [API_ENDPOINTS.insights.key] }),
  ]);
}
export function useConfirmRepayment() {
  const qc = useQueryClient();
  return useFinanceMutation<{ ok: boolean; linked: number; inflowId: string }, { id: string }>({
    endpoint: (v) => `/api/v1/repayments/${encodeURIComponent(v.id)}/confirm`,
    method: 'POST',
    onSuccess: async () => { await invalidateAfterRepayment(qc); },
  });
}
export function useDismissRepayment() {
  const qc = useQueryClient();
  return useFinanceMutation<{ ok: boolean; dismissed: string }, { id: string; inflowId?: string }>({
    endpoint: (v) => `/api/v1/repayments/${encodeURIComponent(v.id)}/dismiss`,
    method: 'POST',
    onSuccess: async () => { await qc.invalidateQueries({ queryKey: [API_ENDPOINTS.repaymentSuggestions.key] }); },
  });
}

// Receipts attached to a transaction.
export function useReceipts(txnId?: string) {
  return useFinanceQuery<Receipts>({
    endpoint: API_ENDPOINTS.receipts.endpoint,
    method: 'GET',
    params: txnId ? { txnId } : undefined,
    queryKey: [API_ENDPOINTS.receipts.key, txnId],
    enabled: !!txnId,
    staleTime: 30_000,
  });
}
export interface AddReceiptVars {
  txnId: string;
  imageBase64: string;
  mime: string;
  ocrText?: string;
  ocrLines?: string[];
  amount?: number | null;
  date?: string | null;
  source?: string;
}
export function useAddReceipt() {
  const qc = useQueryClient();
  return useFinanceMutation<Receipt, AddReceiptVars>({
    endpoint: API_ENDPOINTS.addReceipt.endpoint,
    method: 'POST',
    onSuccess: async () => { await qc.invalidateQueries({ queryKey: [API_ENDPOINTS.receipts.key] }); },
  });
}
export function useDeleteReceipt() {
  const qc = useQueryClient();
  return useFinanceMutation<OkResult, { id: string }>({
    endpoint: (v) => `/api/v1/receipts/${encodeURIComponent(v.id)}`,
    method: 'DELETE',
    onSuccess: async () => { await qc.invalidateQueries({ queryKey: [API_ENDPOINTS.receipts.key] }); },
  });
}
// Authed <Image> source for a server-stored receipt (expo-image forwards headers).
export function useReceiptImageSource() {
  const { serverUrl, token } = useServerConfig();
  const base = getServerBaseUrl(serverUrl);
  const headers = getServerAuthHeaders(token);
  return (id: string) => ({ uri: `${base}/api/v1/receipts/${id}/image`, headers });
}

export function useCreateTransaction() {
  const qc = useQueryClient();
  return useFinanceMutation<OkResult, CreateTransactionInput>({
    endpoint: API_ENDPOINTS.createTransaction.endpoint,
    method: 'POST',
    onSuccess: async () => {
      await Promise.all([
        qc.invalidateQueries({ queryKey: [API_ENDPOINTS.transactions.key] }),
        qc.invalidateQueries({ queryKey: [API_ENDPOINTS.accounts.key] }),
        qc.invalidateQueries({ queryKey: [API_ENDPOINTS.spending.key] }),
        qc.invalidateQueries({ queryKey: [API_ENDPOINTS.insights.key] }),
        qc.invalidateQueries({ queryKey: [API_ENDPOINTS.budgets.key] }),
      ]);
    },
  });
}

export function useSaveGoal() {
  const qc = useQueryClient();
  return useFinanceMutation<OkResult, GoalInput>({
    endpoint: API_ENDPOINTS.saveGoal.endpoint,
    method: 'POST',
    onSuccess: async () => {
      await qc.invalidateQueries({ queryKey: [API_ENDPOINTS.goals.key] });
    },
  });
}

export function useDeleteGoal() {
  const qc = useQueryClient();
  return useFinanceMutation<OkResult, { id: string }>({
    endpoint: (v) => `/api/v1/goals/${encodeURIComponent(v.id)}`,
    method: 'DELETE',
    onSuccess: async () => {
      await qc.invalidateQueries({ queryKey: [API_ENDPOINTS.goals.key] });
    },
  });
}

export function useManualAssets() {
  return useFinanceQuery<ManualAssets>({
    endpoint: API_ENDPOINTS.manualAssets.endpoint,
    method: API_ENDPOINTS.manualAssets.method,
    queryKey: [API_ENDPOINTS.manualAssets.key],
    staleTime: 60_000,
  });
}

export interface SaveManualAssetVars {
  id?: string;
  name: string;
  value: number;
  kind: 'asset' | 'liability';
}
export function useSaveManualAsset() {
  const qc = useQueryClient();
  return useFinanceMutation<OkResult, SaveManualAssetVars>({
    endpoint: API_ENDPOINTS.saveManualAsset.endpoint,
    method: 'POST',
    onSuccess: async () => {
      await qc.invalidateQueries({ queryKey: [API_ENDPOINTS.manualAssets.key] });
    },
  });
}

export function useDeleteManualAsset() {
  const qc = useQueryClient();
  return useFinanceMutation<OkResult, { id: string }>({
    endpoint: (v) => `/api/v1/manual-assets/${encodeURIComponent(v.id)}`,
    method: 'DELETE',
    onSuccess: async () => {
      await qc.invalidateQueries({ queryKey: [API_ENDPOINTS.manualAssets.key] });
    },
  });
}

export interface SetAccountOverrideVars {
  id: string;
  name?: string;
  hidden?: boolean;
}
export function useSetAccountOverride() {
  const qc = useQueryClient();
  return useFinanceMutation<OkResult, SetAccountOverrideVars>({
    endpoint: (v) => `/api/v1/accounts/${encodeURIComponent(v.id)}/override`,
    method: 'POST',
    onSuccess: async () => {
      await Promise.all([
        qc.invalidateQueries({ queryKey: [API_ENDPOINTS.accounts.key] }),
        qc.invalidateQueries({ queryKey: [API_ENDPOINTS.transactions.key] }),
      ]);
    },
  });
}

export function useRefresh() {
  const qc = useQueryClient();
  return useFinanceMutation<{ ok: boolean }, void>({
    endpoint: API_ENDPOINTS.refresh.endpoint,
    method: 'POST',
    onSuccess: async () => {
      await qc.invalidateQueries();
    },
  });
}
