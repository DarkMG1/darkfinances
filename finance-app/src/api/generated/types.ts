// Response types for the DarkFinances API (/api/v1/*). Mirrors dataModule.js output.

export type Nullish<T> = T | null | undefined;
export type AccountRole = 'operating_cash' | 'protected_savings' | 'credit_card' | 'loan' | 'investment' | 'excluded' | 'unknown';

export type CreditLiabilityCoverage = 'exclude' | 'current_balance' | 'statement';

export interface AccountCreditStatementOverride {
  balanceCents: number;
  paymentDueDate: string;
  observedAt: string;
}

export interface AccountOverrideEntry {
  name?: string;
  hidden?: boolean;
  role?: AccountRole;
  creditLiabilityCoverage?: CreditLiabilityCoverage;
  paymentRecurringKey?: string;
  fundingAccountId?: string;
  statement?: AccountCreditStatementOverride;
  clearCreditLiability?: boolean;
}

export interface AccountCreditLiabilityOverride {
  coverage: CreditLiabilityCoverage | null;
  paymentRecurringKey: string | null;
  fundingAccountId: string | null;
  statement: AccountCreditStatementOverride | null;
}

export interface AccountCreditLiabilityPolicy {
  mode: 'unknown' | 'exclude' | 'current_balance' | 'statement';
  eligible: boolean;
  coverageKind: 'current_balance' | 'statement' | null;
  paymentRecurringKey: string | null;
  fundingAccountId: string | null;
  obligationCents: number | null;
  paymentDueDate: string | null;
  observedAt: string | null;
  quarantineReasons: string[];
}

export interface Account {
  id: string;
  name: string;
  offbudget: boolean;
  balance: number;
  hidden?: boolean;
  role: AccountRole;
  roleSource: 'explicit' | 'unknown';
  inclusion?: {
    netWorth: boolean;
    operatingCash: boolean;
    liquidCash: boolean;
    spending: boolean;
    obligations: boolean;
    forecast: boolean;
  };
  creditLiability?: AccountCreditLiabilityOverride | null;
  creditLiabilityPolicy?: AccountCreditLiabilityPolicy | null;
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

export interface InvestmentHolding {
  symbol: string;
  name: string;
  account: string;
  assetClass: string;
  quantity: number;
  price: number;
  value: number;
  costBasis: number | null;
  gainLoss: number | null;
  gainLossPct: number | null;
}
export interface DebtPlan {
  id: string;
  name: string;
  balance: number;
  apr: number;
  minPayment: number;
  dueDate: string | null;
  strategy: string;
  months: number | null;
  totalInterest: number | null;
  payoffDate: string | null;
}
export interface Investments {
  generatedAt: string;
  holdings: InvestmentHolding[];
  totals: { value: number; costBasis: number; gainLoss: number };
  allocation: { byAssetClass: Record<string, number>; byAccount: Record<string, number> };
  debts: DebtPlan[];
  debtTotals: { balance: number; minPayment: number; weightedApr: number };
}

export interface Reports {
  generatedAt: string;
  month: string;
  completeness?: ProjectionCompleteness;
  saved: { id: string; title: string; subtitle: string }[];
  monthlyReview: {
    income: number | null;
    spend: number | null;
    net: number | null;
    knownSpendSubtotal?: number;
    knownIncomeSubtotal?: number;
    completeness?: ProjectionCompleteness;
    transactionCount: number;
    largest: Transaction[];
    uncategorized: Transaction[];
  };
  categoryTrends: { name: string; spend: number; pct: number | null }[];
  merchantTrends: { payee: string; spend: number; count: number }[];
  categoryTrendsComplete?: boolean;
  merchantTrendsComplete?: boolean;
  tagSummary: Tag[];
  cashFlow: TrendMonth[];
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
  parentId: string | null;
  isLeg: boolean;
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

export interface ProjectionCompleteness {
  complete: boolean;
  incompleteReasons: string[];
  transferIdentityUnresolvedCount: number;
  transferIdentityReasons: string[];
}

export interface SpendSummary {
  spending: Record<string, number>;
  totalSpend: number | null;
  totalIncome: number | null;
  knownSpendSubtotal?: number;
  knownIncomeSubtotal?: number;
  completeness: ProjectionCompleteness;
}
export interface Spending {
  current: SpendSummary;
  prev: SpendSummary;
  month: string;
  completeness?: ProjectionCompleteness;
  scope?: {
    accountProjectionRevision?: string;
    spendingIncludedAccountIds?: string[];
  };
}

export interface TrendMonth {
  month: string;
  netWorth: number | null;
  spend: number | null;
  income: number | null;
  net: number | null;
  complete?: boolean;
  knownSpendSubtotal?: number;
  knownIncomeSubtotal?: number;
  completeness?: ProjectionCompleteness;
}
export interface Trends {
  months: TrendMonth[];
  completeness?: ProjectionCompleteness;
  scope?: {
    includesClosedAccountHistory: boolean;
    includesManualAssets: boolean;
    excludedHiddenAccounts: boolean;
    excludedRoles?: string[];
    queriedFrom?: string;
    queriedTo?: string;
    netWorthHistoryComplete?: boolean;
    netWorthIncludedRoles?: AccountRole[];
    netWorthIncludedAccountIds?: string[];
    accountProjectionRevision?: string;
    splitwiseMirrorAccountId?: string | null;
    splitwiseMirrorExcludedFromNetWorth?: boolean;
    demoSyntheticHistory?: boolean;
    months?: number;
  };
}

export interface BudgetCategory {
  id: string;
  name: string;
  budgeted: number;
  target: number;
  spent: number;
  remaining: number;
  reserve: number | null;
  envelope: number | null;
  envelopeDebt: number | null;
  reserveCents: number | null;
  envelopeCents: number | null;
  envelopeDebtCents: number | null;
  projected: number;
  expectedToDate: number | null;
  dailyPace: number;
  balance: number;
  pct: number | null;
  over: boolean;
  status: 'on_track' | 'watch' | 'over' | 'snoozed';
  rolloverMode: string;
  rolloverAmount: number;
  rolloverConfigured: boolean;
  resolved: boolean;
  annualTarget: number | null;
  trueExpenseCadence: string | null;
  snoozedMonth: string | null;
  priority: string | null;
  linkedGoal: string | null;
}
export interface BudgetGroup {
  id: string;
  name: string;
  budgeted: number;
  target: number;
  spent: number;
  remaining: number;
  projected: number;
  status: 'on_track' | 'watch' | 'over' | 'snoozed';
  categories: BudgetCategory[];
}
export interface Budgets {
  month: string;
  supported: boolean;
  totalBudgeted: number;
  totalTarget: number;
  totalSpent: number;
  totalRemaining: number;
  totalProjected: number;
  daysInMonth: number;
  daysElapsed: number;
  status: 'on_track' | 'watch' | 'over' | 'snoozed';
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
  totalOwed: MetricValue;
  debtorCount: number | null;
  summary?: {
    fronted: number;
    paidBack: number;
    outstanding: number | null;
    outstandingMetric?: MetricValue | null;
    window?: { from: string; to: string };
    lifetime?: boolean;
  };
  owes: OwesPerson[];
  owesSource?: string;
  owesGeneratedAt?: string | null;
  owesWarning?: string | null;
  lastKnownSplitwise?: {
    generatedAt: string | null;
    total: number;
    bySlug: Record<string, { event: string; amount: number }[]>;
    source: string;
  } | null;
  ledgerCutoff?: string | null;
  ledgerScan?: {
    queriedFrom: string;
    configuredFrom: string;
    to: string;
    complete: boolean;
  };
  people: ReimbPerson[];
  events: ReimbEvent[];
  expected: ExpectedEvent[];
  buckets: Record<string, { net: number; count: number; legs: ReimbLeg[] }>;
  unattributed?: { net: number; count: number; legs: ReimbLeg[] } | null;
}

export type ReviewTaskKind =
  | 'uncategorized'
  | 'large_charge'
  | 'missing_receipt'
  | 'pending'
  | 'repayment'
  | 'price_change'
  | 'reconciliation'
  | 'transfer_identity';
export type ReviewTaskAction =
  | 'open_transaction'
  | 'categorize'
  | 'open_reimbursement'
  | 'open_recurring'
  | 'open_reconcile';
export interface ReviewTransactionRef {
  id: string;
  parentId: string | null;
  isLeg: boolean;
  accountId: string;
  account: string;
  payee: string;
  amount: number;
  date: string;
  category: string | null;
  categoryId: string | null;
  notes: string;
  cleared: boolean;
  imported: boolean;
}
export interface ReviewTask {
  id: string;
  kind: ReviewTaskKind;
  priority: number;
  title: string;
  subtitle: string;
  action: ReviewTaskAction;
  amount: number;
  date: string | null;
  transaction?: ReviewTransactionRef;
  person?: string;
  key?: string;
  month?: string;
  transferReason?: string;
}
export interface ReviewInbox {
  generatedAt: string;
  month: string;
  count: number;
  hiddenCount?: number;
  counts: Partial<Record<ReviewTaskKind, number>>;
  tasks: ReviewTask[];
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
  completeness?: ProjectionCompleteness;
}

export type Cadence = 'weekly' | 'biweekly' | 'semimonthly' | 'monthly' | 'bimonthly' | 'quarterly' | 'semiannual' | 'annual';
export type RecurringStatus = 'active' | 'inactive' | 'cancelled';

export interface RecurringItem {
  key: string;
  payee: string;
  category: string;
  categoryId?: string | null;
  categoryIdentityStatus?: 'explicit' | 'inferred' | 'ambiguous' | 'missing';
  cadence: Cadence;
  amount: number;
  monthlyEquivalent: number;
  isBill?: boolean;
  occurrences: number;
  firstCharged: string;
  lastCharged: string;
  nextRenewal: string | null;
  renewalWindow: { start: string; end: string } | null;
  projectionUncertain?: boolean;
  priceChange: { from: number; to: number; pct: number } | null;
  confidence: number;
  firstSeen: string;
  lastAmount: number;
  previousAmount: number | null;
  providerUrl: string;
  cancellation: {
    status?: string | null;
    notes?: string | null;
    confirmationDate?: string | null;
    refundRequested?: boolean;
    retentionOffer?: string | null;
    watchNextRenewal?: boolean;
  } | null;
  status: RecurringStatus;
  hidden: boolean;
  forced?: boolean; // user manually marked this recurring
  history: { date: string; amount: number }[];
}
export interface Recurring {
  items: RecurringItem[];
  hiddenItems?: RecurringItem[];
  hiddenCount?: number;
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
  variance?: number | null;
}
export interface Bills {
  bills: Bill[];
  total: number;
  count: number;
  unpaidCount: number;
  horizonDays: number;
}

export interface ForecastEvent {
  date: string;
  label: string;
  amount: number;
  kind: 'income' | 'bill' | 'budget' | 'reimbursement';
  provenance: 'known' | 'planned' | 'inferred' | 'possible';
  sourceId?: string | null;
}
export interface ForecastPoint {
  date: string;
  balance: number;
  inflow: number;
  outflow: number;
}
export interface Forecast {
  generatedAt: string;
  range: { start: string; end: string; days: number };
  startBalance: number;
  endingBalance: number;
  lowest: { date: string; balance: number };
  totals: { inflow: number; outflow: number };
  points: ForecastPoint[];
  events: ForecastEvent[];
  assumptions?: {
    liquidAccounts: { id: string; name: string }[];
    /** @deprecated Use assumptions.genericBudget.target */
    genericBudgetTarget: number | null;
    genericBudget: {
      target: number | null;
      remaining: number | null;
      complete: boolean;
      incompleteReasons: string[];
    };
    billsExcludedFromGenericBudget: boolean;
    reimbursementsIncluded: boolean;
    obligationGraph?: {
      version: number;
      complete: boolean;
      incompleteReasons: string[];
    };
    stsContainment?: {
      complete: boolean;
      incompleteReasons: string[];
    };
    projectionContainment?: {
      complete: boolean;
      stsContainmentIncomplete: boolean;
      graphEventsWithheld: boolean;
      knownEventsIncludedDespiteStsIncomplete?: boolean;
      incompleteReasons: string[];
    };
  };
  possibleReimbursement?: { date: string; amount: number; includedInBalance: false } | null;
  warnings: string[];
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
  accountId?: string | null;
  account?: string;
  imported?: boolean;
}
export interface ReimbLinkEndpoint extends ReimbTxnRef {
  allocated?: number | null;
  allocatedCents?: number | null;
  allocationTrusted?: boolean;
  allocationAmbiguous?: boolean;
  allocationReason?: string;
  linkVersion?: number;
  linkKey?: string;
}
export interface ReimbLinkCapacity {
  role: 'inflow' | 'expense';
  absCapCents: number;
  allocatedTrustedCents: number;
  remainingTrustedCents: number;
  ambiguousLinkCount: number;
  completeness: 'complete' | 'ambiguous' | 'overallocated';
  completenessReason?: string | null;
}
export interface ReimbLegacyReportRow {
  linkKey: string;
  inflowId: string | null;
  expenseId: string | null;
  inflowDate: string | null;
  expenseDate: string | null;
  reason: string;
  createdAt: string | null;
}
export interface ReimbLegacyReport {
  ambiguousCount: number;
  rows: ReimbLegacyReportRow[];
  generatedAt: string;
}
export interface ReimbLinks {
  links?: ReimbLinkEndpoint[];
  asInflow: ReimbLinkEndpoint[];
  asExpense: ReimbLinkEndpoint[];
  capacity?: ReimbLinkCapacity | null;
  legacyReport?: ReimbLegacyReport;
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
  complete?: boolean;
  incompleteReasons?: string[];
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

export interface ReimbursementExportEndpointScope {
  absCapCents: number | null;
  allocatedTrustedCents: number | null;
  remainingTrustedCents: number | null;
  ambiguousLinkCount: number | null;
  completeness?: string;
  completenessReason?: string | null;
  linkCountLowerBound?: number;
}

export interface ReimbursementExportEndpoint {
  id: string;
  role: 'inflow' | 'expense' | null;
  live: boolean;
  date?: string | null;
  payee?: string;
  amountCents?: number | null;
  global: ReimbursementExportEndpointScope;
  window: {
    allocatedTrustedCents: number | null;
    linkCountLowerBound: number;
  } | null;
}

export interface ReimbursementExportPerson {
  person: string;
  allocatedTrustedCents: number | null;
}

export interface ReimbursementExportProvenance {
  actualGeneration: number | null;
  linksRevision: number | null;
  release: Record<string, unknown> | null;
  linksSidecarDigest: string | null;
  inputDigests: Record<string, unknown>;
  operationBinding: Record<string, unknown> | null;
}

export interface ReimbursementExportIncompleteSection {
  section: string;
  [key: string]: unknown;
}

export interface ReimbursementExportScopeTotals {
  trustedAllocationCents: number | null;
  linkCount: number;
  trustedLinkCountLowerBound: number;
  ambiguousLinkCountLowerBound: number;
  authoritative: boolean;
}

export interface ReimbursementExportLinkEndpointRef {
  id: string;
  date: string | null;
  payee: string;
  amountCents: number | null;
  accountId: string | null;
  account: string;
  identityFingerprint?: string;
  admissionFingerprint?: string | null;
  categoryId?: string | null;
}

export interface ReimbursementExportLink {
  linkKey: string;
  inflowId: string | null;
  expenseId: string | null;
  person: string | null;
  allocationCents: number | null;
  allocationTrusted: boolean;
  allocationAmbiguous: boolean;
  allocationReason: string;
  linkVersion: number;
  inflow: ReimbursementExportLinkEndpointRef | null;
  expense: ReimbursementExportLinkEndpointRef | null;
  inflowOrphan: boolean;
  expenseOrphan: boolean;
  identityMismatch?: boolean;
  eligibilityMismatch?: boolean;
}

export interface ReimbursementExport {
  schemaVersion: number;
  allocationPolicyVersion: string;
  generatedAt: string;
  financeTimeZone: string;
  window: { from: string | null; to: string | null };
  scopes: {
    window: { active: boolean; totals: ReimbursementExportScopeTotals; links: ReimbursementExportLink[] };
    global: { totals: ReimbursementExportScopeTotals; links: ReimbursementExportLink[] };
  };
  provenance: ReimbursementExportProvenance;
  completeness: { status: 'complete' | 'incomplete'; reasons: Record<string, unknown>[] };
  totals: {
    trustedAllocationCents: number | null;
    linkCount: number;
    trustedLinkCount: number;
    ambiguousLinkCount: number;
    authoritative: boolean;
  };
  links: ReimbursementExportLink[];
  endpoints: Record<string, ReimbursementExportEndpoint>;
  people: ReimbursementExportPerson[];
  incompleteSections: ReimbursementExportIncompleteSection[];
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
  evidenceStatus: 'needs-review' | 'matched' | 'mismatch' | 'unreadable';
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

export interface GoalFeasibility {
  remainingCents: number;
  remaining: number;
  monthlyRequiredCents: number | null;
  monthlyRequired: number | null;
  deadlineOverdue: boolean;
  accountStatus: 'manual' | 'linked' | 'missing' | 'closed' | 'hidden' | 'excluded';
  accountRole: string | null;
  overAllocated: boolean;
  overAllocatedCents: number;
  feasible: boolean | null;
  advisoryOnly: true;
}

export interface GoalAccountSummary {
  accountId: string;
  role: string | null;
  accountStatus: string;
  capacityCents: number;
  allocatedCents: number;
  unallocatedCents: number;
  overAllocatedCents: number;
  goalIds: string[];
  capacity: number;
  allocated: number;
  unallocated: number;
  overAllocated: number;
}

export interface GoalAdvisory {
  complete: true;
  advisoryOnly: true;
  totalRemainingCents: number;
  monthlyPressureCents: number;
  overAllocatedAccounts: GoalAccountSummary[];
  overAllocatedAccountCount: number;
}

export interface Goal {
  id: string;
  name: string;
  target: number;
  accountId?: string | null;
  deadline?: string | null;
  current: number;
  pct: number | null;
  fundingSource?: 'allocated-account' | 'manual';
  availableInAccount?: number | null;
  monthlyRequired?: number | null;
  feasibility?: GoalFeasibility;
}

export interface GoalInput {
  id?: string;
  name: string;
  target: number;
  accountId?: string | null;
  deadline?: string | null;
  current?: number;
}

export interface OkResult {
  ok: boolean;
  id?: string;
  feasibility?: GoalFeasibility | null;
  previousId?: string;
  parentId?: string;
  legIds?: string[];
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
  id?: string;
  previousId?: string;
  parentId?: string;
}
export interface ReconnectFreshnessEvidence {
  ok: boolean;
  probeKind: string;
  cacheGenerationBefore: number;
  cacheGenerationAfter: number;
  sourceObservedAt: number;
  sourceObservedRevision: string | null;
  financeTimeZone: string;
  deployIdentity: string | null;
  coalesced?: boolean;
}
export interface Ping {
  ok: boolean;
  ts: number;
  startedAt?: string;
  financeTimeZone?: string;
  queuedMutations?: number;
  actualCoordinator?: {
    generation: number;
    queued?: number;
  };
  release?: {
    commit: string | null;
    dirty: boolean;
    lockSha256: string | null;
    contract: string | null;
    appVersion: string | null;
    builtAt: string | null;
  } | null;
  actual?: {
    ready: boolean;
    initializedAt?: string | null;
    lastSyncAt?: string | null;
    lastErrorAt?: string | null;
    lastError?: string | null;
  };
}

export interface ObligationReservation {
  id: string;
  label: string;
  date: string;
  amountCents: number;
  role: string;
  reserved: boolean;
  source?: { kind?: string; key?: string; id?: string; provenance?: string };
  explanation?: string[];
  incompleteReasons?: string[];
}

export interface ObligationGraphSummary {
  version: number;
  nodeCount: number;
  edgeCount: number;
  occurrenceCount: number;
  reservedOutflowCents: number;
  completeness: { complete: boolean; incompleteReasons: string[]; occurrenceCount: number; reservedOccurrenceCount: number };
}

export interface ObligationGraphView {
  version: number;
  summary: ObligationGraphSummary;
  completeness: { complete: boolean; incompleteReasons: string[]; occurrenceCount: number; reservedOccurrenceCount: number };
  reservations: ObligationReservation[];
}

export interface MetricProvenance {
  metric: string;
  asOf: string;
  financeDate: string;
  sources: { type: string; id?: string; role?: AccountRole }[];
  method: string;
  excludes: string[];
}
export interface MetricValue {
  value: number | null;
  valueCents: number | null;
  complete: boolean;
  incompleteReasons: string[];
  provenance: MetricProvenance;
  lowerBound?: number | null;
  lowerBoundLabel?: string | null;
}
export interface Today {
  asOf: string;
  financeDate: string;
  revision: string;
  complete: boolean;
  incompleteReasons: string[];
  health: NonNullable<Ping['actual']>;
  accounts: Account[];
  metrics?: {
    netWorth: MetricValue;
    liquidCash: MetricValue;
    operatingCash: MetricValue;
  };
  scope?: {
    accountProjectionRevision?: string;
    netWorthIncludedAccountIds?: string[];
    splitwiseMirrorAccountId?: string | null;
    netWorthIncludesManualAssets?: boolean;
    netWorthHistoryScope?: string;
  };
  spending: Spending;
  liquidity: { safeToSpend: MetricValue; goalAdvisory?: GoalAdvisory | null };
  obligationGraph?: ObligationGraphView;
  obligations: {
    bills: Bill[];
    nextIncome: IncomeStream | null;
    source: 'inferred' | 'confirmed' | 'obligation-graph';
    reserved?: ObligationReservation[];
  };
  review: ReviewInbox;
  activity: { recent: Transaction[] };
}
