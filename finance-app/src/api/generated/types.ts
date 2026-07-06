// Response types for the DarkFinances API (/api/v1/*). Mirrors dataModule.js output.

export type Nullish<T> = T | null | undefined;

export interface Account {
  id: string;
  name: string;
  offbudget: boolean;
  balance: number;
  hidden?: boolean;
}

export interface ManualAsset {
  id: string;
  name: string;
  value: number;
  kind: 'asset' | 'liability';
  updated: string;
}
export interface ManualAssets {
  items: ManualAsset[];
  assets: number;
  liabilities: number;
  net: number;
}

export interface Transaction {
  id: string;
  parentId: string | null;
  isLeg: boolean;
  date: string;
  payee: string;
  account: string;
  accountId: string;
  cleared: boolean;
  amount: number;
  category: string | null;
  categoryId: string | null;
  notes: string;
  // Present on collapsed list rows: a whole split shown as one line.
  isSplit?: boolean;
  splitCount?: number;
  // True for bank-imported rows (not user-deletable, mirrors Rocket Money).
  imported?: boolean;
}

// One leg of a split, as returned by GET /transactions/:id and sent back on save.
export interface SplitLeg {
  id?: string; // present for existing legs; omit to add a new one
  amount: number; // signed dollars (matches the parent's sign)
  categoryId: string | null;
  category?: string | null;
  name?: string; // per-leg display name (maps to the leg's payee)
  notes?: string;
}

// A single transaction with its legs, for the detail + split editor.
export interface TransactionDetail {
  id: string;
  accountId: string;
  account: string;
  date: string;
  payee: string;
  amount: number;
  category: string | null;
  categoryId: string | null;
  notes: string;
  cleared: boolean;
  imported: boolean;
  isSplit: boolean;
  legs: SplitLeg[];
}

// Per-merchant history ("See History") — a zero-filled monthly series, each bucket
// carrying its own drill-down items.
export interface MerchantHistoryItem {
  id: string;
  date: string;
  payee: string;
  amount: number;
  category: string | null;
  categoryId: string | null;
  account: string;
  accountId: string;
  isLeg: boolean;
  parentId: string | null;
  cleared: boolean;
  notes: string;
}
export interface MerchantHistoryMonth {
  month: string;
  total: number;
  count: number;
  items: MerchantHistoryItem[];
}
export interface MerchantHistory {
  payee: string;
  count: number;
  total: number;
  avg: number;
  monthsSeen: number;
  months: MerchantHistoryMonth[];
}

export interface SpendSummary {
  spending: Record<string, number>;
  totalSpend: number;
  totalIncome: number;
}
export interface Spending {
  current: SpendSummary;
  prev: SpendSummary;
  month: string;
}

export interface TrendMonth {
  month: string;
  netWorth: number;
  spend: number;
  income: number;
  net: number;
}
export interface Trends {
  months: TrendMonth[];
}

export interface BudgetCategory {
  id: string;
  name: string;
  budgeted: number;
  spent: number;
  balance: number;
  pct: number | null;
  over: boolean;
}
export interface BudgetGroup {
  id: string;
  name: string;
  budgeted: number;
  spent: number;
  categories: BudgetCategory[];
}
export interface Budgets {
  month: string;
  supported: boolean;
  totalBudgeted: number;
  totalSpent: number;
  groups: BudgetGroup[];
}

export interface ReimbLeg {
  id?: string;
  parentId?: string | null;
  isLeg?: boolean;
  accountId?: string;
  account?: string;
  payee?: string;
  categoryId?: string | null;
  notes?: string;
  cleared?: boolean;
  imported?: boolean;
  date: string;
  amount: number;
  label: string;
  event: string | null;
  how: string;
}
export interface ReimbPerson {
  slug: string;
  net: number;
  status: 'owes_you' | 'over_settled' | 'settled';
  legs: ReimbLeg[];
}
export interface ReimbEvent {
  event: string;
  fronted: number;
  recovered: number;
  net: number;
  status: string;
  n: number;
  firstDate: string | null;
  lastDate: string | null;
  settledDate: string | null;
}
export interface ExpectedRow {
  slug: string;
  expected: number;
  received: number;
  remaining: number;
  auto: number;
  status: 'paid' | 'partial' | 'open';
}
export interface ExpectedEvent {
  event: string;
  rows: ExpectedRow[];
  expected: number;
  received: number;
  remaining: number;
}
export interface OwesPerson {
  slug: string;
  owed: number;
  misc: number;
  trips: { event: string; remaining: number }[];
  legs: ReimbLeg[];
}
export interface Reimbursement {
  range: { from: string; to: string };
  totalOwed: number;
  debtorCount: number;
  summary?: { fronted: number; paidBack: number; outstanding: number; window?: { from: string; to: string }; lifetime?: boolean };
  owes: OwesPerson[];
  owesSource?: string;
  owesGeneratedAt?: string | null;
  owesWarning?: string | null;
  ledgerCutoff?: string | null;
  people: ReimbPerson[];
  events: ReimbEvent[];
  expected: ExpectedEvent[];
  buckets: Record<string, { net: number; count: number; legs: ReimbLeg[] }>;
  unattributed?: { net: number; count: number; legs: ReimbLeg[] } | null;
}

export interface Tag {
  raw: string;
  token: string;
  label: string;
  kind: 'event' | 'tag';
  count: number;
}

export interface Tags {
  tags: Tag[];
}

export interface Insights {
  month: string;
  largestCharges: {
    date: string; payee: string; amount: number; category: string;
    // identity for deep-linking into the transaction detail (present on newer backends)
    id?: string; account?: string; accountId?: string; categoryId?: string | null;
    notes?: string; isLeg?: boolean; parentId?: string | null; cleared?: boolean;
  }[];
  // Real-spend merchants for the month (excludes transfers/investments/CC payments/reimbursement).
  topMerchants?: { payee: string; total: number; count: number; category: string | null }[];
  uncategorized: { date: string; payee: string; amount: number }[];
  recurring: { payee: string; category: string; monthsSeen: number; estimated: number }[];
  anomalies: { category: string; current: number; avg: number; deltaPct: number | null }[];
}

export type Cadence = 'weekly' | 'biweekly' | 'monthly' | 'bimonthly' | 'quarterly' | 'semiannual' | 'annual';
export type RecurringStatus = 'active' | 'inactive' | 'cancelled';

export interface RecurringItem {
  key: string;
  payee: string;
  category: string;
  cadence: Cadence;
  amount: number;
  monthlyEquivalent: number;
  isBill?: boolean;
  occurrences: number;
  firstCharged: string;
  lastCharged: string;
  nextRenewal: string;
  priceChange: { from: number; to: number; pct: number } | null;
  status: RecurringStatus;
  hidden: boolean;
  forced?: boolean; // user manually marked this recurring
  history: { date: string; amount: number }[];
}
export interface Recurring {
  items: RecurringItem[];
  monthlyTotal: number;
  annualTotal: number;
  activeCount: number;
  count: number;
  // Split totals (subscriptions vs true bills) so the home cards don't overlap.
  subMonthlyTotal?: number;
  subActiveCount?: number;
  billMonthlyTotal?: number;
  billActiveCount?: number;
}

export interface Bill {
  id: string;
  key: string;
  payee: string;
  amount: number;
  dueDate: string;
  category: string;
  cadence: Cadence;
  paid: boolean;
  paidDate: string | null;
  // Set when paid was auto-derived from a real recorded transaction.
  matched?: { date: string; amount: number } | null;
}
export interface Bills {
  bills: Bill[];
  total: number;
  count: number;
  unpaidCount: number;
  horizonDays: number;
}

export interface IncomeStream {
  key: string;
  payee: string;
  category: string;
  cadence: Cadence;
  amount: number;
  monthlyEquivalent: number;
  occurrences: number;
  lastPaid: string;
  nextPay: string;
  active: boolean;
  history: { date: string; amount: number }[];
}
export interface Income {
  streams: IncomeStream[];
  activeCount: number;
  count: number;
  monthlyTotal: number;
  annualTotal: number;
  nextPayday: string | null;
  nextPaydayAmount: number | null;
  nextPaydayPayee: string | null;
  primaryPayee?: string | null;
  primaryAmount?: number | null;
  primaryMonthly?: number | null;
  primaryCadence?: Cadence | null;
  primaryNextPay?: string | null;
}

export interface SearchResult {
  transactions: Transaction[];
  total: number;
  truncated: boolean;
  range?: { start: string; end: string };
}

export interface ReimbTxnRef {
  id: string;
  date: string | null;
  payee: string;
  amount: number;
}
export interface ReimbLinks {
  asInflow: (ReimbTxnRef & { allocated?: number })[]; // expenses this inflow repays
  asExpense: (ReimbTxnRef & { allocated?: number })[]; // inflows that repaid this expense
}

// Repayment auto-matcher: a suggested match of an incoming payment to what a
// person owes. Confirming files the inflow under Reimbursement (nets it) and
// writes amount-allocated provenance links.
export interface RepaymentAllocation {
  expense: ReimbTxnRef;
  amount: number;
}
export type RepaymentKind = 'exact' | 'subset' | 'multi' | 'partial' | 'over' | 'person';
export interface RepaymentSuggestion {
  id: string;
  inflow: ReimbTxnRef;
  person: string;
  owed: number;
  allocations: RepaymentAllocation[];
  matched: number;
  remainder: number;
  kind: RepaymentKind;
  score: number;
  reason: string;
  createdAt: string;
}
export interface RepaymentSuggestions {
  suggestions: RepaymentSuggestion[];
  count: number;
  generatedAt: string;
  range: { from: string; to: string };
}

export interface ReconItem {
  id: string;
  date: string;
  payee: string;
  amount: number;
  category: string;
  account: string;
  accountId: string;
  reconciled: boolean;
}
export interface Reconciliation {
  enabled: boolean;
  month: string;
  done: boolean;
  doneAt: string | null;
  total: number;
  reconciledCount: number;
  remaining: number;
  items: ReconItem[];
}
export interface ReconcilePending {
  enabled: boolean;
  pending: string | null;
  total?: number;
  reconciledCount?: number;
  remaining?: number;
}

export type ReimbStatus = 'outstanding' | 'partial' | 'settled';
export interface ReimbLedgerPayment {
  id: string;
  date: string | null;
  payee: string;
  amount: number;
}
export interface ReimbLedgerCharge {
  id: string;
  date: string;
  payee: string;
  notes: string;
  event: string | null;
  accountId: string;
  account: string;
  fronted: number;
  allocated: number;
  remaining: number;
  status: ReimbStatus;
  settledDate: string | null;
  payments: ReimbLedgerPayment[];
}
export interface ReimbLedgerPerson {
  person: string;
  fronted: number;
  allocated: number;
  remaining: number;
  status: ReimbStatus;
  count: number;
  charges: ReimbLedgerCharge[];
}
export interface ReimbursementLedger {
  month: string;
  range: { start: string; end: string };
  totals: {
    fronted: number;
    allocated: number;
    remaining: number;
    outstanding: number;
    partial: number;
    settledCount: number;
    peopleCount: number;
  };
  people: ReimbLedgerPerson[];
  months: { month: string; spend: number }[];
}

export interface Receipt {
  id: string;
  txnId: string;
  mime: string;
  size: number;
  ocrText: string;
  ocrLines: string[];
  amount: number | null;
  date: string | null;
  source: string;
  uploadedAt: string;
}
export interface Receipts {
  receipts: Receipt[];
}

export interface CreateTransactionInput {
  accountId: string;
  amount: number; // dollars; negative = expense, positive = income
  payee?: string;
  date?: string; // YYYY-MM-DD; defaults to today
  categoryId?: string | null;
  notes?: string;
}

export interface Goal {
  id: string;
  name: string;
  target: number;
  accountId?: string | null;
  deadline?: string | null;
  current: number;
  pct: number | null;
}
export interface GoalInput {
  id?: string;
  name: string;
  target: number;
  accountId?: string | null;
  deadline?: string | null;
}

export interface OkResult {
  ok: boolean;
  id?: string;
  key?: string;
  applied?: number; // rows touched by a saved/applied rule
  removed?: number; // rules removed
  legs?: number; // legs created by a split
}

export interface Rule {
  id: string;
  match: string;
  categoryId: string;
  categoryName: string;
  created: string;
}
export interface Rules {
  rules: Rule[];
  // Read-only built-in merchant catalog applied after your rules.
  catalog?: { label: string; type: string }[];
}
export interface TripEvent {
  slug: string;
  name: string;
  start: string;
  members: string[];
  group: string;
  created: string;
  taggedCount?: number;
}
export interface EventsResponse {
  events: TripEvent[];
}

export interface Category {
  id: string;
  name: string;
  group: string;
}

export interface CategorizeResult {
  ok: boolean;
  mode: string;
}
export interface Ping {
  ok: boolean;
  ts: number;
}
