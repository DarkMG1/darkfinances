'use strict';
/*
 * dataModule.js — single source of truth for all Actual Budget reads/computations.
 *
 * Shared by the Express API (web dashboard + native app). Keeps the Actual API
 * lifecycle (init / downloadBudget / sync) in one place and exposes pure-ish data
 * getters. HTTP-layer caching lives in server.js; this module just computes.
 *
 * Classification mirrors the finance digest tooling:
 *   income | mm (money movement) | reimb (peer debts) | spend (real) | uncat
 *
 * Env: ACTUAL_SERVER_URL, ACTUAL_PASSWORD, ACTUAL_SYNC_ID, ACTUAL_DATA_DIR
 */

const fs = require('fs');
const path = require('path');
const crypto = require('crypto');
const safeRegex = require('safe-regex2');
const {
  FINANCE_TIME_ZONE,
  addDays,
  addMonths,
  daysBetween,
  daysInMonth,
  monthRange: calendarMonthRange,
  todayYMD,
} = require('./lib/date-only');
const {
  CADENCE_DAYS,
  classifyCadence,
  inactiveGapDays,
  inferRecurrenceSchedule,
  monthlyEquivalentAmount,
  nextOccurrenceAfter,
  paidMatchWindow,
  projectOccurrences,
  projectionConfidencePenalty,
  renewalWindow,
  rollToOnOrAfter,
} = require('./lib/recurrence');
const { readJsonFile, writeJsonFile, JsonStoreError } = require('./lib/json-store');
const { readRuntimeStateByPath, writeRuntimeStateByPath, RuntimeStateError } = require('./lib/runtime-state-store');
const {
  RECEIPT_MAX_DECODED_BYTES,
  exactBase64DecodedBytes,
  stripBase64Envelope,
} = require('./lib/receipt-limits');
const {
  REFERENCE_STEPS: TRANSACTION_DELETION_REFERENCE_STEPS,
  rewriteTransactionDeletionReferences,
} = require('./lib/transaction-deletion-references');
const {
  createTransactionDeletionSaga,
} = require('./lib/transaction-deletion-saga');
const {
  createRepaymentConfirmationSaga,
} = require('./lib/repayment-confirmation-saga');
const {
  createReimbursementLinkSaga,
} = require('./lib/reimbursement-link-saga');
const {
  admitManualLink,
  locateTransactionLive,
  revalidateLinkApply,
  revalidateUnlinkApply,
  resolveManualLinkEndpoints,
} = require('./lib/reimbursement-link-admission');
const {
  buildLegacyMigrationReport,
  classifyStoredLink,
  enrichEndpointForRead,
  summarizeEndpointCapacity,
  sumTrustedAllocationsForExpense,
  sumTrustedAllocationsForInflow,
  trustedLinkedCents,
} = require('./lib/reimbursement-allocation');
const {
  BulkOperationInProgressError,
  createBulkOperationSaga,
} = require('./lib/bulk-operation-saga');
const {
  buildAdmissionPayload,
  RepaymentSuggestionInvalidError,
  resolveRepaymentEndpoints,
} = require('./lib/repayment-confirmation-admission');
const {
  rewriteTransactionReplacementReferences,
} = require('./lib/transaction-replacement-references');
const {
  SagaInterruption,
  addableTransaction,
  assertReconstructableTransaction,
  createTransactionReplacementSaga,
  transactionReplacementMap,
} = require('./lib/transaction-replacement-saga');
const {
  buildCategoryInfo,
  buildTransferIndex,
  classifyLeaf,
  classifyTransactionLeaves,
  hasActualTransferIdentity,
  incompleteTransferReviewFingerprint,
  leafCountsAsRealIncome,
  leafCountsAsRealSpend,
  normalizeTransferId,
  PROVENANCE,
  summarizeCents,
  summarizeClassifiedLeaves,
  transactionLeaves,
  TRANSFER_REASON,
} = require('./lib/domain/classification');
const {
  mergeProjectionCompleteness,
  projectionCompletenessFromLeaves,
  spendSummaryFromClassifiedLeaves,
} = require('./lib/domain/projection-completeness');
const { fromCents, sumCents, toCents } = require('./lib/domain/money');
const {
  buildForecastBudgetDailyCents,
  buildForecastGenericBudgetContext,
} = require('./lib/domain/cent-allocation');
const {
  forecastBillEventCents,
  forecastIncomeEventCents,
  sumOperatingCashBalanceCents,
} = require('./lib/domain/forecast-money');
const { accountsForMetric, readAccountOverrides, writeAccountOverrides } = require('./lib/account-overrides');
const { metricValue } = require('./lib/metric-provenance');
const {
  SAFE_TO_SPEND_INPUTS,
  safeToSpendIncompleteReasons,
} = require('./lib/safe-to-spend');
const {
  AccountNotFoundError,
  TransactionNotFoundError,
} = require('./lib/errors');
const { statePath } = require('./lib/state-registry');
const { myShareExpenseCents, loadSplitwiseMirrorResolutions, owesSnapshotMaxAgeMs, preflightSplitwiseMirrorAdmission, SplitwiseMirrorSnapshotError } = require('./lib/splitwise-mirror');
const { BulkOperationOutcomeUnknownError } = require('./lib/bulk-operation-saga');
const { getActualCoordinator } = require('./lib/actual-coordinator');
const ACTUAL_API_PATH = process.env.ACTUAL_API_PATH || '@actual-app/api';
const api = require(ACTUAL_API_PATH);

// Sidecar JSON for per-user state Actual Budget can't hold (subscription
// overrides, savings goals). Lives next to this module; the systemd service
// user owns ~/finance-dashboard so these are writable.
const OVERRIDES_PATH = statePath('recurringOverrides');
const GOALS_PATH = statePath('goals');
const BILLS_PAID_PATH = statePath('billsPaid');
// Optional richer budgeting metadata keyed by category id or category name.
const BUDGET_SETTINGS_PATH = statePath('budgetSettings');
// "Who owes me" ground truth (Splitwise expected amounts, trips, debtor name
// patterns). Editable by deployment tooling or the user without a code change.
const OWES_CONFIG_PATH = statePath('owesConfig');
// Authoritative "who owes me" snapshot (Splitwise pairwise truth) produced by
// actual-tools/owes-snapshot.js. The dashboard READS this; it never recomputes
// per-person trip debts from line items (that approach always drifted — see
// the project reimbursement docs). Missing file => fall back to the legacy baseline.
const OWES_TRUTH_PATH = statePath('owesTruth');
// Venmo debts imported from a statement CSV (actual-tools/venmo-import.js). Same
// { bySlug: { slug: [{event, amount}] } } shape as owes-truth, merged into
// who-owes-me alongside Splitwise. Absent => Venmo simply contributes nothing.
const VENMO_TRUTH_PATH = statePath('venmoTruth');
// Events / trips: user-created groupings (name, members, Splitwise group) that a
// transaction tag (#ev-<slug>) ties into. owes-snapshot.js reads this same file so
// a trip created in the app auto-pulls its Splitwise group into who-owes-me.
const EVENTS_PATH = statePath('events');
// Manual reimbursement links: maps a repayment inflow (e.g. a Zelle payback) to
// the expense(s) it repays. Actual has no native txn-to-txn link, so we store
// display snapshots of both sides here.
const REIMB_LINKS_PATH = statePath('reimbursementLinks');
// Auto-matcher: suggested repayment→expense matches awaiting your confirmation,
// plus a dismissed set so we never re-surface ones you've waved off.
const REIMB_SUGGEST_PATH = statePath('reimbursementSuggestions');
// Optional deployment-specific cutoffs. By default the app behaves normally:
// direct reimbursement debt scans all history, and suggestions start Jan 1 of
// the current year. Personal deployments can set these env vars to hide already
// settled historical rows.
const REIMB_SUGGEST_FROM = process.env.REIMB_SUGGEST_FROM || `${todayYMD().slice(0, 4)}-01-01`;
const REIMB_LEDGER_FROM = process.env.REIMB_LEDGER_FROM || '2000-01-01';
const REIMB_LEDGER_CUTOFF_ACTIVE = !!process.env.REIMB_LEDGER_FROM;
// Phantom pending cleanup: a strike ledger of pending imported charges we've seen
// (so aged-out deletes only fire after we've watched one linger), plus an audit log
// of everything the cleanup has removed.
const PHANTOM_SEEN_PATH = statePath('phantomSeen');
const PHANTOM_LOG_PATH = statePath('phantomLog');
// Receipts: metadata index (per transaction) + a directory of the raw image files,
// so scanned receipts survive an app reinstall (server is the durable copy).
const RECEIPTS_PATH = statePath('receipts');
const RECEIPTS_DIR = process.env.RECEIPTS_DIR || path.join(__dirname, 'receipts');
// Categorization rules ("always categorize payee X as Y"). Applied to
// uncategorized transactions on create + on each SimpleFIN refresh.
const RULES_PATH = statePath('rules');
// Per-account display overrides (rename / hide) — never touches Actual itself.
const ACCOUNT_OVERRIDES_PATH = statePath('accountOverrides');
// User-entered assets/liabilities that live outside Actual (car, home, cash,
// crypto) and roll into net worth.
const MANUAL_ASSETS_PATH = statePath('manualAssets');
const INVESTMENT_HOLDINGS_PATH = statePath('investmentHoldings');
const DEBT_PLANNER_PATH = statePath('debtPlanner');
// Monthly reconciliation: opt-in month-end review where each expense is checked
// off and then the whole month is closed. Stores the enabled flag + per-month,
// per-transaction reconcile marks so the app can nag until a month is cleared.
const RECON_PATH = statePath('reconciliation');
const REVIEW_STATE_PATH = statePath('reviewState');
const TRANSACTION_SAGAS_PATH = statePath('transactionSagas');
const TRANSACTION_DELETION_SAGAS_PATH = statePath('transactionDeletionSagas');
const REPAYMENT_CONFIRMATION_SAGAS_PATH = statePath('repaymentConfirmationSagas');
const REIMBURSEMENT_LINK_SAGAS_PATH = statePath('reimbursementLinkSagas');
const BULK_OPERATION_SAGAS_PATH = statePath('bulkOperationSagas');
const SPLITWISE_MIRROR_RESOLUTIONS_PATH = statePath('splitwiseMirrorResolutions');
const readJsonSafe = (p, fallback, validate) => {
  try {
    const managed = readRuntimeStateByPath(p, { fallback, validate });
    if (managed.meta.source !== 'unmanaged') return managed.value;
    return readJsonFile(p, fallback, validate);
  } catch (cause) {
    if (cause instanceof RuntimeStateError) {
      if (cause.code === 'RUNTIME_STATE_INVALID_SHAPE' || cause.code === 'RUNTIME_STATE_CORRUPT') {
        throw new JsonStoreError(cause.message, {
          code: cause.code === 'RUNTIME_STATE_CORRUPT' ? 'JSON_CORRUPT' : 'JSON_INVALID_SHAPE',
          file: cause.file,
          cause,
        });
      }
    }
    throw cause;
  }
};
const writeJsonSafe = (p, obj) => writeRuntimeStateByPath(p, obj);

const config = {
  dataDir: process.env.ACTUAL_DATA_DIR || '/tmp/actual-dashboard-cache',
  serverURL: process.env.ACTUAL_SERVER_URL,
  password: process.env.ACTUAL_PASSWORD,
  syncId: process.env.ACTUAL_SYNC_ID,
};

// ---------------------------------------------------------------------------
// API lifecycle
// ---------------------------------------------------------------------------
let apiReady = false;
let initPromise = null;
const apiHealth = {
  initializedAt: null,
  lastSyncAt: null,
  lastErrorAt: null,
  lastError: null,
};

let sagaRecoverCompleted = false;
const TERMINAL_TRANSACTION_REPLACEMENT = new Set(['completed', 'rolled_back', 'legacy_unresolved', 'aborted']);
const TERMINAL_TRANSACTION_DELETION = new Set(['completed']);
const TERMINAL_REPAYMENT_CONFIRMATION = new Set(['completed']);
const TERMINAL_REIMBURSEMENT_LINK = new Set(['completed']);
const TERMINAL_BULK_OPERATION = new Set(['completed', 'unresolved']);
let operationalSagaHealth = {
  recoveryCompleted: false,
  lastRecoveryAt: null,
  lastCheckedAt: null,
  nonterminal: { byStore: {}, total: 0 },
  errors: [],
  needsSync: false,
  ready: false,
};

function normalizeOperationalRecoveryError(store, entry, caught = null) {
  if (caught) {
    return {
      store,
      sagaId: null,
      message: String(caught?.message || caught),
      code: caught?.code || null,
    };
  }
  return {
    store,
    sagaId: entry?.sagaId ?? null,
    message: String(entry?.error?.message || entry?.error),
    code: entry?.error?.code || null,
  };
}

function countOperationalSagaNonterminal() {
  const byStore = {
    transactionReplacement: countNonterminalSagas(TRANSACTION_SAGAS_PATH, TERMINAL_TRANSACTION_REPLACEMENT),
    transactionDeletion: countNonterminalSagas(TRANSACTION_DELETION_SAGAS_PATH, TERMINAL_TRANSACTION_DELETION),
    repaymentConfirmation: countNonterminalSagas(REPAYMENT_CONFIRMATION_SAGAS_PATH, TERMINAL_REPAYMENT_CONFIRMATION),
    reimbursementLinks: countNonterminalSagas(REIMBURSEMENT_LINK_SAGAS_PATH, TERMINAL_REIMBURSEMENT_LINK),
    bulkOperations: countNonterminalSagas(BULK_OPERATION_SAGAS_PATH, TERMINAL_BULK_OPERATION),
  };
  const total = Object.values(byStore).reduce((sum, count) => sum + count, 0);
  return { byStore, total };
}

function countNonterminalSagas(storePath, terminalPhases) {
  const state = readJsonSafe(storePath, { sagas: {} });
  return Object.values(state.sagas || {}).filter((saga) => !terminalPhases.has(saga?.phase)).length;
}

function refreshOperationalSagaHealth({ recovery } = {}) {
  const nonterminal = countOperationalSagaNonterminal();
  if (recovery?.errors) operationalSagaHealth.errors = recovery.errors;
  if (recovery && Object.prototype.hasOwnProperty.call(recovery, 'needsSync')) {
    operationalSagaHealth.needsSync = recovery.needsSync;
  }
  operationalSagaHealth = {
    recoveryCompleted: sagaRecoverCompleted,
    lastRecoveryAt: operationalSagaHealth.lastRecoveryAt,
    lastCheckedAt: new Date().toISOString(),
    nonterminal,
    errors: operationalSagaHealth.errors,
    needsSync: operationalSagaHealth.needsSync,
    ready: apiReady
      && sagaRecoverCompleted
      && operationalSagaHealth.errors.length === 0
      && nonterminal.total === 0,
  };
  return operationalSagaHealth;
}

async function driveOperationalSagaRecovery(actualApi, { deferSync = true } = {}) {
  let needsSync = false;
  const errors = [];
  const recoverers = [
    ['transactionReplacement', () => recoverTransactionSagas(actualApi, { deferSync })],
    ['transactionDeletion', () => recoverTransactionDeletionSagas(actualApi, { deferSync })],
    ['repaymentConfirmation', () => recoverRepaymentConfirmationSagas(actualApi, { deferSync })],
    ['reimbursementLinks', () => recoverReimbursementLinkSagas(actualApi)],
    ['bulkOperations', () => recoverBulkOperationSagas(actualApi, { deferSync })],
  ];
  for (const [store, recover] of recoverers) {
    try {
      const result = await recover();
      needsSync ||= Boolean(result?.needsSync);
      for (const entry of result?.errors || []) {
        errors.push(normalizeOperationalRecoveryError(store, entry));
      }
    } catch (error) {
      errors.push(normalizeOperationalRecoveryError(store, null, error));
    }
  }
  return { needsSync, errors };
}

async function recoverOperationalSagas() {
  if (sagaRecoverCompleted) return operationalSagaHealth;
  const recovery = await driveOperationalSagaRecovery(api, { deferSync: false });
  sagaRecoverCompleted = true;
  operationalSagaHealth.lastRecoveryAt = new Date().toISOString();
  refreshOperationalSagaHealth({ recovery });
  const blockingBulk = recovery.errors.find((entry) => entry.code === 'BULK_OPERATION_OUTCOME_UNKNOWN');
  if (blockingBulk) {
    throw new BulkOperationOutcomeUnknownError(blockingBulk.message);
  }
  return operationalSagaHealth;
}

async function ensureApiReady({ skipRecover = false } = {}) {
  if (!apiReady) {
    if (!initPromise) {
      initPromise = (async () => {
        try {
          await loadBudgetResilient();
          apiReady = true;
          apiHealth.initializedAt = new Date().toISOString();
          apiHealth.lastError = null;
        } catch (error) {
          apiHealth.lastErrorAt = new Date().toISOString();
          apiHealth.lastError = String(error?.message || error);
          throw error;
        }
      })();
    }
    await initPromise;
  }
  if (!skipRecover) {
    await recoverOperationalSagas();
  }
}

async function initApi({ skipRecover = false } = {}) {
  return getActualCoordinator().runRecover(async () => {
    try {
      await ensureApiReady({ skipRecover });
    } catch (error) {
      apiHealth.lastErrorAt = new Date().toISOString();
      apiHealth.lastError = String(error?.message || error);
      throw error;
    }
  }, { label: 'initApi' });
}

function isRecoverableActualCacheError(error) {
  const message = String(error?.message || error || '');
  return /out[\s_-]*of[\s_-]*sync|invalid[\s_-]*schema|SQLITE_CORRUPT|database disk image is malformed|no such table|migration.*(?:failed|mismatch)/i.test(message);
}

async function resetOwnedActualCache(dataDir) {
  const resolved = path.resolve(dataDir || '');
  const home = path.resolve(process.env.HOME || '');
  if (!resolved || resolved === '/' || resolved === home || resolved.split(path.sep).filter(Boolean).length < 3) {
    throw new Error(`Refusing unsafe Actual cache reset: ${resolved || '(empty)'}`);
  }
  const stat = await fs.promises.lstat(resolved);
  if (!stat.isDirectory() || stat.isSymbolicLink() || stat.uid !== process.getuid()) {
    throw new Error(`Refusing unowned or non-directory Actual cache reset: ${resolved}`);
  }
  await fs.promises.rm(resolved, { recursive: true, force: true });
  await fs.promises.mkdir(resolved, { recursive: true, mode: 0o700 });
}

// Self-heal only errors known to describe a disposable local cache. Auth,
// connectivity, server, and configuration failures must preserve the cache for
// diagnosis rather than deleting potentially useful state.
async function loadBudgetResilient() {
  try {
    await api.init({ dataDir: config.dataDir, serverURL: config.serverURL, password: config.password });
    await api.downloadBudget(config.syncId);
  } catch (e) {
    if (!isRecoverableActualCacheError(e)) throw e;
    console.error('Recoverable Actual cache failure; resetting owned cache:', (e && e.message) || e);
    await resetOwnedActualCache(config.dataDir);
    throw new Error('Actual cache was reset after a recoverable startup failure; restart required', { cause: e });
  }
}

async function withApi(fn, { mode = 'read', skipRecover = false } = {}) {
  const coordinator = getActualCoordinator();
  const body = async () => {
    await ensureApiReady({ skipRecover });
    return fn(api);
  };
  if (mode === 'write') return coordinator.runWrite(body, { label: 'withApi:write' });
  return coordinator.runRead(body, { label: 'withApi:read' });
}

function runActualRead(fn, options = {}) {
  return withApi(fn, { mode: 'read', ...options });
}

function runActualWrite(fn) {
  return withApi(fn, { mode: 'write' });
}

function runActualRecover(fn, options = {}) {
  return getActualCoordinator().runRecover(fn, options);
}

// Pull the latest changes from the Actual server into the local cache. Used by a
// periodic timer in server.js so the dashboard never serves stale post-sync data.
async function syncNow() {
  const coordinator = getActualCoordinator();
  return coordinator.runRecover(async () => {
    try {
      await ensureApiReady();
      const recovery = await syncTransactionSagas(api);
      refreshOperationalSagaHealth({
        recovery: {
          needsSync: recovery.needsSync,
          errors: recovery.errors.map((entry) => ({
            store: entry.store || 'unknown',
            sagaId: entry.sagaId ?? null,
            message: String(entry.error?.message || entry.error),
          })),
        },
      });
      coordinator.invalidateGeneration();
      apiHealth.lastSyncAt = new Date().toISOString();
      apiHealth.lastError = null;
    } catch (error) {
      refreshOperationalSagaHealth();
      apiHealth.lastErrorAt = new Date().toISOString();
      apiHealth.lastError = String(error?.message || error);
      throw error;
    }
  }, { label: 'syncNow' });
}

// Manual "Sync with bank": fetch fresh transactions from linked banks (SimpleFIN)
// then pull deltas. Resilient — even if the bank fetch fails (provider down), we
// still sync the ledger and report the warning instead of throwing.
async function bankSync({ sync = true, throwOnBankError = false } = {}) {
  return withApi(async (actualApi) => {
    let warning = null;
    try {
      await actualApi.runBankSync();
    } catch (e) {
      if (throwOnBankError) throw e;
      warning = (e && e.message) || 'bank fetch failed';
    }
    if (sync) await syncTransactionSagas(actualApi);
    return { ok: !warning, warning, at: new Date().toISOString() };
  }, { mode: 'write' });
}

// Force a full re-download on next access (used by /api/refresh).
function resetApi() {
  apiReady = false;
  initPromise = null;
  sagaRecoverCompleted = false;
  operationalSagaHealth = {
    recoveryCompleted: false,
    lastRecoveryAt: null,
    lastCheckedAt: null,
    nonterminal: { byStore: {}, total: 0 },
    errors: [],
    needsSync: false,
    ready: false,
  };
}

async function performActualShutdown() {
  if (apiReady) {
    let recoveryError = null;
    let shutdownError = null;
    try {
      await syncTransactionSagas(api);
    } catch (error) {
      recoveryError = error;
    }
    try {
      if (typeof api.shutdown === 'function') await api.shutdown();
    } catch (error) {
      shutdownError = error;
    }
    resetApi();
    if (recoveryError) throw recoveryError;
    if (shutdownError) throw shutdownError;
    return;
  }
  resetApi();
}

async function shutdownApi() {
  return getActualCoordinator().shutdownHandoff(() => performActualShutdown());
}

function getHealth() {
  if (sagaRecoverCompleted) refreshOperationalSagaHealth();
  return {
    ready: apiReady && sagaRecoverCompleted && operationalSagaHealth.ready,
    initializing: !!initPromise && !apiReady,
    initializedAt: apiHealth.initializedAt,
    lastSyncAt: apiHealth.lastSyncAt,
    lastErrorAt: apiHealth.lastErrorAt,
    lastError: apiHealth.lastError,
    operationalSagas: { ...operationalSagaHealth },
  };
}

// ---------------------------------------------------------------------------
// Small helpers
// ---------------------------------------------------------------------------
const d2 = (cents) => Math.round(cents) / 100; // integer cents -> dollars (number)
const round2 = (n) => Math.round(n * 100) / 100;
const currentFinanceYearMonth = () => {
  const [year, month] = todayYMD().slice(0, 7).split('-').map(Number);
  return { year, monthIndex: month - 1 };
};
function labelFromNotes(notes) {
  let s = String(notes || '')
    .replace(/\[[^\]]+\]/g, '')
    .replace(/#[A-Za-z0-9_-]+/g, '')
    .replace(/^\s*(my share|others?'?\s+share|fronted for group)(?:\s*\([^)]*\))?\s*[:\-]\s*/i, '')
    .replace(/\s*\|\s*.*$/, '')
    .replace(/\s{2,}/g, ' ')
    .trim();
  return s.slice(0, 80);
}
function displayPayeeName(primary, notes, fallback = 'Transaction') {
  const p = String(primary || '').trim();
  if (p) return p;
  return labelFromNotes(notes) || fallback;
}
function median(arr) {
  if (!arr.length) return 0;
  const s = [...arr].sort((a, b) => a - b);
  const n = s.length;
  return n % 2 ? s[(n - 1) / 2] : (s[n / 2 - 1] + s[n / 2]) / 2;
}
function stddev(arr) {
  if (arr.length < 2) return 0;
  const m = arr.reduce((s, x) => s + x, 0) / arr.length;
  return Math.sqrt(arr.reduce((s, x) => s + (x - m) ** 2, 0) / arr.length);
}

// Recurring cadence classification and calendar-safe projection live in lib/recurrence.js.
// Normalize a payee into a stable subscription key (drops store numbers / punctuation).
function recurringKey(payee) {
  return (payee || '')
    .toLowerCase()
    .replace(/[#*]?\d{3,}/g, ' ')
    .replace(/[^a-z0-9 ]+/g, ' ')
    .replace(/\s+/g, ' ')
    .trim();
}
// Month names (full + 3-letter) for stripping date stamps out of income payees.
const MONTH_RX = /\b(jan(uary)?|feb(ruary)?|mar(ch)?|apr(il)?|may|jun(e)?|jul(y)?|aug(ust)?|sep(t(ember)?)?|oct(ober)?|nov(ember)?|dec(ember)?)\b/gi;
// Income-specific key. Banks stamp interest/payroll with the month or a per-deposit
// id, which fragments them under recurringKey. Collapse interest to one stream and
// strip month names so monthly income groups instead of splitting 12 ways.
function incomeKey(payee, note) {
  const s = (payee || '').toLowerCase();
  if (/\binterest\b/.test(s)) return 'interest';
  // Payroll/ACH deposits arrive with inconsistent payee text per deposit (e.g.
  // "GMC" one cycle, "Salary Payroll E Vendor Dirdps" the next) but carry a
  // stable ACH originator id ("PPD ID: 9GM-DIRDPS"). Group by that id so a
  // paycheck collapses into one stream instead of fragmenting into one-offs.
  const ppd = ((note || '').match(/ppd id:\s*([a-z0-9-]+)/i) || [])[1];
  if (ppd) return `ppd:${ppd.toLowerCase()}`;
  return recurringKey(s.replace(MONTH_RX, ' '));
}
// Generic ACH/payroll boilerplate that makes a deposit's payee text unhelpful.
const PAYROLL_NOISE = /payroll|vendor|salary|dirdps|direct dep|division|\bpmt\b|\bppd\b|\bach\b|\bdep\b/i;
// Pick the cleanest display name among a grouped stream's varied payee strings:
// fewest boilerplate words wins, then the shorter one (so "GMC" beats
// "Salary Payroll E Vendor Dirdps").
function bestPayeeLabel(names) {
  const list = [...new Set((names || []).filter(Boolean))];
  if (!list.length) return 'Income';
  return list
    .map((n) => ({ n, noise: (n.match(new RegExp(PAYROLL_NOISE, 'gi')) || []).length, len: n.length }))
    .sort((a, b) => a.noise - b.noise || a.len - b.len)[0].n;
}

// Categories that read as genuine bills/subscriptions — these may legitimately
// swing in amount month to month (utilities especially), so we relax the
// amount-consistency gate for them.
const BILL_CAT = /(util|electric|power|energy|\bgas\b|water|sewer|trash|internet|cable|phone|mobile|wireless|insuranc|rent|mortgage|\bloan|subscription|membership|fitness|gym|\bhealth|software|hosting|cloud|stream|donat|charit)/i;
// Strict "must-pay bill" categories (a due date you owe): housing, utilities,
// connectivity, insurance, loans. Excludes discretionary recurring spend
// (streaming/software/gym/cloud) which we treat as subscriptions instead. Drives
// the Bills view vs the Subscriptions view so the two don't overlap.
const BILL_DUE_CAT = /(util|electric|power|energy|\bgas\b|water|sewer|trash|internet|cable|phone|mobile|wireless|insuranc|rent|mortgage|\bloan)/i;
// Categories that are essentially never recurring subscriptions — discretionary
// spend that merely happens at the same merchant repeatedly (dining, coffee…).
const BLOCK_CAT = /(dining|restaurant|fast.?food|coffee|caf|grocer|\bfood|snack|\bbar\b|alcohol|\bdrink|rideshare|uber|lyft|taxi|\bfuel|gas station|shopping|clothing|apparel|retail|merch|amazon|walmart|\btarget\b|travel|hotel|lodging|flight|airfare|parking|\btoll|pharmacy|convenience|fun money|spending money|personal care)/i;

// Normalizing month range; handles negative / overflow month indices.
function monthRange(year, monthIdx) {
  return calendarMonthRange(year, monthIdx);
}
function firstOfThisMonth() {
  return `${todayYMD().slice(0, 7)}-01`;
}

// ---------------------------------------------------------------------------
// Category classification
// ---------------------------------------------------------------------------
function envRegex(name, fallback) {
  const src = process.env[name];
  if (!src) return fallback;
  try { return new RegExp(src, 'i'); }
  catch (e) {
    console.warn(`[config] ignoring invalid ${name}: ${e.message}`);
    return fallback;
  }
}
const INCOME_GROUP = envRegex('INCOME_GROUP_PATTERN', /^income$/i);
const MONEY_MOVEMENT_GROUP = envRegex('MONEY_MOVEMENT_GROUP_PATTERN', /money\s*movement/i);
const MM_CAT = envRegex('MONEY_MOVEMENT_CATEGORY_PATTERN', /^(transfers?|investments?|credit\s*card\s*payments?|cc\s*payments?)$/i);
const REIMB_CAT = envRegex('REIMBURSEMENT_CATEGORY_PATTERN', /^reimbursement$/i);
// Peer settle-ups (Splitwise/Venmo/etc.) frequently import as "Other Income",
// which inflates real income. They're a payback (money movement), not earnings,
// so they get refiled under Reimbursement — see refileSettleUps().
const SETTLE_UP_PAYEE = envRegex('SETTLE_UP_PAYEE_PATTERN', /splitwise|venmo|cash\s?app|zelle|paypal/i);

function buildCatInfo(groups) {
  return buildCategoryInfo(groups, {
    incomeGroup: INCOME_GROUP,
    moneyMovementGroup: MONEY_MOVEMENT_GROUP,
    moneyMovementCategory: MM_CAT,
    reimbursementCategory: REIMB_CAT,
  });
}

// Flatten a transaction into leaves (split-aware). Drops parent shells.
function leavesOf(t) {
  return transactionLeaves(t);
}

function classifyLeavesForRows(rows, catInfo, { transferIndex: providedIndex } = {}) {
  const transferIndex = providedIndex ?? buildTransferIndex(rows);
  const out = [];
  for (const row of rows) {
    for (const leaf of transactionLeaves(row.transaction)) {
      out.push(classifyLeaf(leaf, catInfo, {
        transactionId: leaf.id,
        accountId: row.accountId,
        transferIndex,
      }));
    }
  }
  return out;
}

function classifyLeavesInDateRange(rows, catInfo, start, end, transferIndex) {
  const out = [];
  for (const row of rows) {
    const date = row.transaction.date;
    if (date < start || date > end) continue;
    for (const leaf of transactionLeaves(row.transaction)) {
      out.push(classifyLeaf(leaf, catInfo, {
        transactionId: leaf.id,
        accountId: row.accountId,
        transferIndex,
      }));
    }
  }
  return out;
}

async function fetchOnBudgetRows(api, start, end, { accountFilter } = {}) {
  const accounts = (await api.getAccounts()).filter((a) => !a.closed && !a.offbudget);
  const rows = [];
  for (const acct of accounts) {
    if (accountFilter && !accountFilter(acct)) continue;
    const txns = await api.getTransactions(acct.id, start, end);
    for (const t of txns) rows.push({ transaction: t, accountId: acct.id });
  }
  return rows;
}

async function classifiedOnBudgetLeavesForWindows(api, windows, catInfo, { accountFilter } = {}) {
  const start = windows.reduce((min, window) => (window.start < min ? window.start : min), windows[0].start);
  const end = windows.reduce((max, window) => (window.end > max ? window.end : max), windows[0].end);
  const rows = await fetchOnBudgetRows(api, start, end, { accountFilter });
  const transferIndex = buildTransferIndex(rows);
  return windows.map(({ start: windowStart, end: windowEnd }) => (
    classifyLeavesInDateRange(rows, catInfo, windowStart, windowEnd, transferIndex)
  ));
}

async function classifiedOnBudgetLeaves(api, start, end, catInfo, { accountFilter } = {}) {
  const [leaves] = await classifiedOnBudgetLeavesForWindows(api, [{ start, end }], catInfo, { accountFilter });
  return leaves;
}

// ---------------------------------------------------------------------------
// Core getters (mirror legacy endpoints)
// ---------------------------------------------------------------------------
async function getAccounts() {
  return withApi(async (api) => {
    // Hide the "Splitwise" spend-attribution ledger: its expenses count as spend
    // (read straight from Actual), but it isn't real cash, so it must stay out of
    // the account list + the app's net-worth sum.
    const accounts = (await api.getAccounts()).filter((a) => !a.closed && (a.name || '').toLowerCase() !== SW_ACCOUNT_NAME.toLowerCase());
    const overrides = readAccountOverrides(ACCOUNT_OVERRIDES_PATH).accounts;
    return Promise.all(
      accounts.map(async (a) => {
        const ov = overrides[a.id] || {};
        return {
          id: a.id,
          name: ov.name || a.name, // display rename (Actual name untouched)
          offbudget: !!a.offbudget,
          balance: (await api.getAccountBalance(a.id)) / 100,
          hidden: !!ov.hidden,
          role: ov.role || 'unknown',
          roleSource: ov.role ? 'explicit' : 'unknown',
        };
      })
    );
  });
}

function setAccountOverride({ id, name, hidden, role } = {}) {
  if (!id) throw new Error('id required');
  const store = readAccountOverrides(ACCOUNT_OVERRIDES_PATH);
  const overrides = store.accounts;
  const cur = overrides[id] || {};
  if (name !== undefined) {
    const trimmed = (name || '').trim();
    if (trimmed) cur.name = trimmed;
    else delete cur.name; // empty resets to the Actual name
  }
  if (hidden !== undefined) {
    if (hidden) cur.hidden = true;
    else delete cur.hidden;
  }
  if (role !== undefined) {
    if (role === null || role === 'unknown') delete cur.role;
    else cur.role = role;
  }
  if (Object.keys(cur).length) overrides[id] = cur;
  else delete overrides[id];
  writeAccountOverrides(ACCOUNT_OVERRIDES_PATH, store);
  return { ok: true, id, override: overrides[id] || null };
}

// ---------------------------------------------------------------------------
// Manual (off-Actual) assets & liabilities that roll into net worth
// ---------------------------------------------------------------------------
function getManualAssets() {
  const store = readJsonSafe(MANUAL_ASSETS_PATH, { items: [] });
  const items = Array.isArray(store.items) ? store.items : [];
  const assets = round2(items.filter((i) => i.kind !== 'liability').reduce((s, i) => s + (Number(i.value) || 0), 0));
  const liabilities = round2(items.filter((i) => i.kind === 'liability').reduce((s, i) => s + (Number(i.value) || 0), 0));
  return { items, assets, liabilities, net: round2(assets - liabilities) };
}

function saveManualAsset({ id, name, value, kind } = {}) {
  const nm = (name || '').trim();
  const val = fromCents(Math.abs(toCents(value)));
  if (!nm) throw new Error('name required');
  if (!val) throw new Error('value must be greater than 0');
  const k = kind === 'liability' ? 'liability' : 'asset';
  const store = readJsonSafe(MANUAL_ASSETS_PATH, { items: [] });
  if (!Array.isArray(store.items)) store.items = [];
  const now = todayYMD();
  if (id) {
    const item = store.items.find((i) => i.id === id);
    if (!item) throw new Error('asset not found');
    Object.assign(item, { name: nm, value: val, kind: k, updated: now });
  } else {
    id = 'm' + Date.now().toString(36);
    store.items.push({ id, name: nm, value: val, kind: k, updated: now });
  }
  writeJsonSafe(MANUAL_ASSETS_PATH, store);
  return { ok: true, id };
}

function deleteManualAsset({ id } = {}) {
  if (!id) throw new Error('id required');
  const store = readJsonSafe(MANUAL_ASSETS_PATH, { items: [] });
  const before = (store.items || []).length;
  store.items = (store.items || []).filter((i) => i.id !== id);
  writeJsonSafe(MANUAL_ASSETS_PATH, store);
  return { ok: true, removed: before - store.items.length };
}

function payoffProjection(debt) {
  const balance = Math.max(0, Number(debt.balance) || 0);
  const apr = Math.max(0, Number(debt.apr) || 0);
  const payment = Math.max(0, Number(debt.minPayment) || 0);
  if (!balance || !payment) return { months: null, totalInterest: null, payoffDate: null };
  let bal = balance;
  let interest = 0;
  let months = 0;
  const monthlyRate = apr / 100 / 12;
  while (bal > 0.005 && months < 600) {
    const charge = bal * monthlyRate;
    if (payment <= charge && monthlyRate > 0) return { months: null, totalInterest: null, payoffDate: null };
    interest += charge;
    bal = Math.max(0, bal + charge - payment);
    months++;
  }
  return { months, totalInterest: round2(interest), payoffDate: addDays(todayYMD(), Math.round(months * 30.44)) };
}

function getInvestments() {
  const hStore = readJsonSafe(INVESTMENT_HOLDINGS_PATH, { holdings: [] }) || {};
  const dStore = readJsonSafe(DEBT_PLANNER_PATH, { debts: [] }) || {};
  const holdings = (Array.isArray(hStore.holdings) ? hStore.holdings : []).map((h) => {
    const quantity = Number(h.quantity) || 0;
    const price = Number(h.price) || 0;
    const value = round2(Number(h.value) || quantity * price);
    const costBasis = h.costBasis == null ? null : round2(Number(h.costBasis) || 0);
    const gainLoss = costBasis == null ? null : round2(value - costBasis);
    const gainLossPct = costBasis && costBasis > 0 ? round2((gainLoss / costBasis) * 100) : null;
    return {
      symbol: h.symbol || '',
      name: h.name || h.symbol || 'Holding',
      account: h.account || 'Investments',
      assetClass: h.assetClass || 'Unclassified',
      quantity,
      price,
      value,
      costBasis,
      gainLoss,
      gainLossPct,
    };
  }).filter((h) => h.value > 0);
  const byAssetClass = {};
  const byAccount = {};
  for (const h of holdings) {
    byAssetClass[h.assetClass] = round2((byAssetClass[h.assetClass] || 0) + h.value);
    byAccount[h.account] = round2((byAccount[h.account] || 0) + h.value);
  }
  const debts = (Array.isArray(dStore.debts) ? dStore.debts : []).map((d) => {
    const projection = payoffProjection(d);
    return {
      id: d.id || slugify(d.name || 'debt'),
      name: d.name || 'Debt',
      balance: round2(Number(d.balance) || 0),
      apr: Number(d.apr) || 0,
      minPayment: round2(Number(d.minPayment) || 0),
      dueDate: d.dueDate || null,
      strategy: d.strategy || 'avalanche',
      ...projection,
    };
  }).filter((d) => d.balance > 0).sort((a, b) => b.apr - a.apr || a.balance - b.balance);
  const debtBalance = debts.reduce((s, d) => s + d.balance, 0);
  return {
    generatedAt: new Date().toISOString(),
    holdings,
    totals: {
      value: round2(holdings.reduce((s, h) => s + h.value, 0)),
      costBasis: round2(holdings.reduce((s, h) => s + (h.costBasis || 0), 0)),
      gainLoss: round2(holdings.reduce((s, h) => s + (h.gainLoss || 0), 0)),
    },
    allocation: { byAssetClass, byAccount },
    debts,
    debtTotals: {
      balance: round2(debtBalance),
      minPayment: round2(debts.reduce((s, d) => s + d.minPayment, 0)),
      weightedApr: debtBalance ? round2(debts.reduce((s, d) => s + d.apr * d.balance, 0) / debtBalance) : 0,
    },
  };
}

// collapse=true renders each split as ONE parent row (for account/activity lists);
// collapse=false explodes splits into their legs (for category/merchant/tag drill-downs).
function spendBucketFor(info) {
  if (!info || info.kind === 'income' || info.kind === 'mm' || info.kind === 'reimb') return null;
  const key = `${info.name || ''} ${info.group || ''}`.toLowerCase();
  if (/rent|housing|electric|internet|phone|utilities?|water|sewer|trash|insurance|loan|mortgage/.test(key)) return 'bills';
  if (/subscription|streaming|software|cloud/.test(key)) return 'subscriptions';
  return 'spending';
}

async function getTransactions({ accountId, start, end, category, bucket, budgetOnly, collapse } = {}) {
  return withApi(async (api) => {
    const startDate = start || firstOfThisMonth();
    const endDate = end || todayYMD();
    const wantCat = category ? String(category).toLowerCase() : null;
    const wantBucket = bucket ? String(bucket).toLowerCase() : null;
    const accountsFull = await api.getAccounts();
    const acctMap = Object.fromEntries(accountsFull.map((a) => [a.id, a.name]));
    const targetAccts = accountId
      ? accountsFull.filter((a) => a.id === accountId)
      : accountsFull.filter((a) => !a.closed && ((!wantBucket && !budgetOnly) || !a.offbudget));
    const groups = await api.getCategoryGroups();
    const catInfo = buildCatInfo(groups);
    const catMap = Object.fromEntries(Object.entries(catInfo).map(([id, info]) => [id, info.name]));
    const payees = await api.getPayees();
    const payeeMap = Object.fromEntries(payees.map((p) => [p.id, p.name]));

    let all = [];
    for (const acct of targetAccts) {
      const txns = await api.getTransactions(acct.id, startDate, endDate);
      for (const t of txns) {
        const rawParentPayee = payeeMap[t.payee] || t.imported_payee || '';
        const parentPayee = displayPayeeName(rawParentPayee, t.notes, '');
        const base = {
          date: t.date,
          payee: parentPayee,
          account: acctMap[acct.id] || acct.id,
          accountId: acct.id,
          cleared: t.cleared,
          imported: !!t.imported_id, // bank-imported rows aren't user-deletable (see delete guard)
          transfer: hasActualTransferIdentity(t),
        };
        const subs = Array.isArray(t.subtransactions) ? t.subtransactions : [];
        if (t.is_parent && subs.length) {
          if (collapse) {
            // One row for the whole split; the app shows a split glyph + "N".
            all.push({
              ...base,
              id: t.id,
              parentId: null,
              isLeg: false,
              isSplit: true,
              splitCount: subs.length,
              amount: t.amount / 100,
              category: 'Split',
              categoryId: null,
              notes: t.notes || '',
            });
          } else {
            subs.forEach((s, i) => {
              const rawLegPayee = (s.payee && payeeMap[s.payee]) || '';
              all.push({
                ...base,
                // a named leg shows its own payee; otherwise it inherits the parent's
                payee: displayPayeeName(rawLegPayee || rawParentPayee, s.notes || t.notes, parentPayee),
                id: s.id || `${t.id}-${i}`,
                parentId: t.id,
                isLeg: true,
                transfer: !!(normalizeTransferId(s.transfer_id) || normalizeTransferId(s.transferred_id)),
                amount: s.amount / 100,
                category: catMap[s.category] || null,
                categoryId: s.category || null,
                notes: s.notes || t.notes || '',
              });
            });
          }
        } else if (!t.is_parent) {
          all.push({
            ...base,
            id: t.id,
            parentId: null,
            isLeg: false,
            amount: t.amount / 100,
            category: catMap[t.category] || null,
            categoryId: t.category || null,
            notes: t.notes || '',
          });
        }
      }
    }
    if (wantCat === 'uncategorized') all = all.filter((t) => !t.category);
    else if (wantCat === 'income') all = all.filter((t) => t.categoryId && catInfo[t.categoryId] && catInfo[t.categoryId].kind === 'income');
    else if (wantCat) {
      all = all.filter((t) => {
        const info = t.categoryId ? catInfo[t.categoryId] : null;
        return (t.category || '').toLowerCase() === wantCat || (info?.group || '').toLowerCase() === wantCat;
      });
    }
    if (wantBucket) {
      all = all.filter((t) => {
        const info = t.categoryId ? catInfo[t.categoryId] : null;
        const kind = info ? info.kind : 'uncat';
        if (t.transfer || kind === 'mm' || kind === 'reimb' || kind === 'income') return false;
        if (kind === 'uncat') return wantBucket === 'spending' && t.amount < 0;
        return spendBucketFor(info) === wantBucket;
      });
    }
    all.sort((a, b) => b.date.localeCompare(a.date));
    return all;
  });
}

// Create a transaction (manual add). Writes to the REAL Actual budget. Amount is
// in dollars (negative = expense, positive = income); resolves/creates the payee
// by name. addTransactions (not importTransactions) so Actual's import dedup
// can't silently drop a legitimate manual entry.
async function createTransaction({ accountId, amount, payee, date, categoryId, notes } = {}, { sync = true } = {}) {
  if (!accountId) throw new Error('accountId required');
  const cents = toCents(amount);
  if (cents === 0) throw new Error('a non-zero amount is required');
  const name = (payee || '').trim();
  return withApi(async (api) => {
    let payeeId;
    if (name) {
      const payees = await api.getPayees();
      const found = payees.find((p) => (p.name || '').toLowerCase() === name.toLowerCase());
      payeeId = found ? found.id : await api.createPayee({ name });
    }
    const txn = {
      date: date || todayYMD(),
      amount: cents,
      payee: payeeId || undefined,
      category: categoryId || undefined,
      notes: notes || (payeeId ? undefined : name) || undefined,
      cleared: false,
    };
    const res = await api.addTransactions(accountId, [txn], { learnCategories: false, runTransfers: false });
    if (sync) await syncNow(); // persist the write back to the Actual server
    const id = Array.isArray(res) ? res[0] : res && Array.isArray(res.added) ? res.added[0] : null;
    return { ok: true, id: id || null };
  }, { mode: 'write' });
}

function summarize(classifiedLeaves) {
  return spendSummaryFromClassifiedLeaves(classifiedLeaves);
}

async function onBudgetLeaves(api, start, end, catInfo) {
  return classifiedOnBudgetLeaves(api, start, end, catInfo);
}

async function getSpending({ month, start, end } = {}) {
  return withApi(async (api) => {
    const financeToday = todayYMD();
    const [financeYear, financeMonth] = financeToday.slice(0, 7).split('-').map(Number);
    let cur;
    let prev;
    let monthKey;
    if (start && end) {
      const startDate = String(start);
      const endDate = String(end);
      const spanDays = Math.max(1, daysBetween(startDate, endDate) + 1);
      const prevEnd = addDays(startDate, -1);
      const prevStart = addDays(prevEnd, -spanDays + 1);
      cur = { start: startDate, end: endDate, key: startDate.slice(0, 7) };
      prev = { start: prevStart, end: prevEnd, key: prevStart.slice(0, 7) };
      monthKey = cur.key;
    } else {
      let year, mIdx;
      if (month) {
      const [Y, M] = month.split('-').map(Number);
      year = Y;
      mIdx = M - 1;
      } else {
        year = financeYear;
        mIdx = financeMonth - 1;
      }
      cur = monthRange(year, mIdx);
      prev = monthRange(year, mIdx - 1);
      monthKey = cur.key;
    }
    const isCurrent = cur.key === todayYMD().slice(0, 7);
    const curEnd = isCurrent && !end ? todayYMD() : cur.end;

    const groups = await api.getCategoryGroups();
    const catInfo = buildCatInfo(groups);
    const [currentLeaves, previousLeaves] = await classifiedOnBudgetLeavesForWindows(api, [
      { start: cur.start, end: curEnd },
      { start: prev.start, end: prev.end },
    ], catInfo);
    const current = summarize(currentLeaves);
    const previous = summarize(previousLeaves);
    return {
      current,
      prev: previous,
      month: monthKey,
      completeness: mergeProjectionCompleteness([current.completeness, previous.completeness]),
    };
  });
}

// ---------------------------------------------------------------------------
// Trends — net worth / spend / income by month
// ---------------------------------------------------------------------------
async function getTrends({ months = 12, endMonth } = {}) {
  return withApi(async (api) => {
    const groups = await api.getCategoryGroups();
    const catInfo = buildCatInfo(groups);
    const accountOverrides = readAccountOverrides(ACCOUNT_OVERRIDES_PATH).accounts;
    const accounts = (await api.getAccounts()).filter((account) => !accountOverrides[account.id]?.hidden);
    const [financeYear, financeMonth] = String(endMonth || todayYMD().slice(0, 7)).split('-').map(Number);

    const buckets = [];
    for (let i = months - 1; i >= 0; i--) {
      const r = monthRange(financeYear, financeMonth - 1 - i);
      buckets.push({ ...r, income: 0, expense: 0, knownIncome: 0, knownExpense: 0, transferIncompleteCount: 0 });
    }
    const byKey = Object.fromEntries(buckets.map((b) => [b.key, b]));
    const lastEnd = buckets[buckets.length - 1].end;

    const contributions = []; // {date, amount} parent totals across ALL accounts (net worth)
    const trendRows = [];
    const accountTransactions = await Promise.all(accounts.map(async (account) => ({
      account,
      transactions: await api.getTransactions(account.id, '2000-01-01', lastEnd),
    })));
    for (const { account: a, transactions: txns } of accountTransactions) {
      for (const t of txns) trendRows.push({ transaction: t, accountId: a.id });
    }
    const trendTransferIndex = buildTransferIndex(trendRows);
    for (const { account: a, transactions: txns } of accountTransactions) {
      // The "Splitwise" account is a spend-attribution ledger (my share of items a
      // friend paid), not real cash — count its expenses toward monthly spend but
      // keep it out of net worth so a growing share balance can't sink it.
      const isSwLedger = (a.name || '').toLowerCase() === SW_ACCOUNT_NAME.toLowerCase();
      for (const t of txns) {
        if (!isSwLedger) contributions.push({ date: t.date, amount: t.amount });
        if (a.offbudget) continue;
        const b = byKey[t.date.slice(0, 7)];
        if (!b) continue;
        for (const lf of classifyTransactionLeaves(t, catInfo, {
          accountId: a.id,
          transferIndex: trendTransferIndex,
        })) {
          if (lf.kind === 'incomplete' && lf.provenance === PROVENANCE.TRANSFER_IDENTITY) {
            b.transferIncompleteCount += 1;
            continue;
          }
          if (lf.countsAsIncome) {
            b.income += lf.amount;
            b.knownIncome += lf.amount;
          } else if (lf.countsAsSpending) {
            b.expense += -lf.amount;
            b.knownExpense += -lf.amount;
          }
        }
      }
    }

    contributions.sort((x, y) => (x.date < y.date ? -1 : 1));
    let idx = 0;
    let run = 0;
    const series = buckets.map((b) => {
      while (idx < contributions.length && contributions[idx].date <= b.end) {
        run += contributions[idx].amount;
        idx++;
      }
      const complete = b.transferIncompleteCount === 0;
      return {
        month: b.key,
        netWorth: d2(run),
        complete,
        spend: complete ? d2(b.expense) : null,
        income: complete ? d2(b.income) : null,
        knownSpendSubtotal: complete ? undefined : d2(b.knownExpense),
        knownIncomeSubtotal: complete ? undefined : d2(b.knownIncome),
        net: complete ? d2(b.income - b.expense) : null,
        completeness: {
          complete,
          incompleteReasons: complete ? [] : ['transfer_identity_unresolved'],
          transferIdentityUnresolvedCount: b.transferIncompleteCount,
          transferIdentityReasons: complete ? [] : ['transfer_identity_unresolved'],
        },
      };
    });
    return {
      months: series,
      completeness: mergeProjectionCompleteness(series.map((entry) => entry.completeness)),
      scope: {
        includesClosedAccountHistory: true,
        includesManualAssets: false,
        excludedHiddenAccounts: true,
      },
    };
  });
}

// ---------------------------------------------------------------------------
// Budgets — Actual budgeted vs actual per category
// ---------------------------------------------------------------------------
function loadBudgetSettings() {
  const raw = readJsonSafe(BUDGET_SETTINGS_PATH, {}) || {};
  return {
    categories: raw.categories && typeof raw.categories === 'object' ? raw.categories : {},
    defaults: raw.defaults && typeof raw.defaults === 'object' ? raw.defaults : {},
  };
}

function monthProgress(m) {
  const days = daysInMonth(m);
  const cur = todayYMD().slice(0, 7);
  const today = Number(todayYMD().slice(8, 10));
  const elapsed = m === cur ? Math.min(today, days) : (m < cur ? days : 0);
  return { days, elapsed: Math.max(0, elapsed) };
}

const RESOLVED_ROLLOVER_MODES = new Set(['none', 'carryover', 'true_expense']);

async function getBudgets({ month } = {}) {
  return withApi(async (api) => {
    const m = month || todayYMD().slice(0, 7);
    const settings = loadBudgetSettings();
    const progress = monthProgress(m);
    let bm;
    try {
      bm = await api.getBudgetMonth(m);
    } catch (e) {
      return {
        month: m,
        supported: false,
        groups: [],
        totalBudgeted: 0,
        totalSpent: 0,
        [SAFE_TO_SPEND_INPUTS]: null,
      };
    }
    const decisionInputs = {
      eligibleCategoryCount: 0,
      targetedCategoryCount: 0,
      targetlessSpentCategoryCount: 0,
      unresolvedRolloverCategoryCount: 0,
    };
    const groups = [];
    for (const g of bm.categoryGroups || []) {
      if (g.is_income) continue;
      if (MONEY_MOVEMENT_GROUP.test(g.name || '')) continue; // transfers/investments/CC payments aren't spend
      const cats = (g.categories || [])
        .filter((c) => !REIMB_CAT.test(c.name || '')) // peer debts aren't spend
        .map((c) => {
          const idSettings = settings.categories[c.id] || {};
          const nameSettings = settings.categories[c.name] || {};
          const meta = { ...settings.defaults, ...idSettings, ...nameSettings };
          const budgeted = (c.budgeted || 0) / 100;
          const spent = Math.max(0, -(c.spent || 0) / 100);
          const legacyTarget = Number(meta.monthlyTarget);
          const target = budgeted > 0 ? budgeted : (Number.isFinite(legacyTarget) && legacyTarget > 0 ? legacyTarget : 0);
          const annualTarget = Number(meta.annualTarget || 0) || null;
          const remaining = round2(Math.max(0, target - spent));
          const projected = progress.elapsed > 0 ? round2((spent / progress.elapsed) * progress.days) : spent;
          const expectedToDate = target > 0 ? round2((target / progress.days) * progress.elapsed) : null;
          const rolloverMode = meta.rolloverMode || 'none';
          const rolloverAmount = rolloverMode === 'none' ? 0 : round2((c.balance || 0) / 100);
          const rolloverConfigured = [settings.defaults, idSettings, nameSettings]
            .some((source) => Object.prototype.hasOwnProperty.call(source, 'rolloverMode'));
          if (!BILL_CAT.test(`${g.name || ''} ${c.name || ''}`)) {
            decisionInputs.eligibleCategoryCount++;
            if (target > 0) decisionInputs.targetedCategoryCount++;
            if (target <= 0 && spent > 0) decisionInputs.targetlessSpentCategoryCount++;
            if (!rolloverConfigured || !RESOLVED_ROLLOVER_MODES.has(meta.rolloverMode)) {
              decisionInputs.unresolvedRolloverCategoryCount++;
            }
          }
          const snoozed = meta.snoozedMonth === m;
          const status = snoozed
            ? 'snoozed'
            : target > 0 && spent > target
              ? 'over'
              : target > 0 && projected > target * 1.05
                ? 'watch'
                : 'on_track';
          return {
            id: c.id,
            name: c.name,
            budgeted,
            spent,
            balance: (c.balance || 0) / 100,
            pct: target > 0 ? Math.min(999, Math.round((spent / target) * 100)) : null,
            over: target > 0 && spent > target,
            target,
            annualTarget,
            remaining,
            projected,
            expectedToDate,
            dailyPace: target > 0 ? round2(target / progress.days) : 0,
            status,
            rolloverMode,
            rolloverAmount,
            trueExpenseCadence: meta.trueExpenseCadence || null,
            snoozedMonth: meta.snoozedMonth || null,
            priority: meta.priority || null,
            linkedGoal: meta.linkedGoal || null,
          };
        })
        .filter((c) => c.target > 0 || c.budgeted > 0 || c.spent > 0)
        .sort((a, b) => b.spent - a.spent);
      if (!cats.length) continue;
      groups.push({
        id: g.id,
        name: g.name,
        budgeted: cats.reduce((s, c) => s + c.budgeted, 0),
        target: cats.reduce((s, c) => s + c.target, 0),
        spent: cats.reduce((s, c) => s + c.spent, 0),
        remaining: cats.reduce((s, c) => s + c.remaining, 0),
        projected: cats.reduce((s, c) => s + c.projected, 0),
        status: cats.some((c) => c.status === 'over') ? 'over' : cats.some((c) => c.status === 'watch') ? 'watch' : cats.every((c) => c.status === 'snoozed') ? 'snoozed' : 'on_track',
        categories: cats,
      });
    }
    const totalTarget = groups.reduce((s, g) => s + g.target, 0);
    const totalSpent = groups.reduce((s, g) => s + g.spent, 0);
    const totalRemaining = groups.reduce((s, g) => s + g.remaining, 0);
    const totalProjected = groups.reduce((s, g) => s + g.projected, 0);
    return {
      month: m,
      supported: true,
      totalBudgeted: groups.reduce((s, g) => s + g.budgeted, 0),
      totalTarget,
      totalSpent,
      totalRemaining,
      totalProjected,
      daysInMonth: progress.days,
      daysElapsed: progress.elapsed,
      status: totalTarget > 0 && totalSpent > totalTarget ? 'over' : totalTarget > 0 && totalProjected > totalTarget * 1.05 ? 'watch' : 'on_track',
      groups,
      [SAFE_TO_SPEND_INPUTS]: decisionInputs,
    };
  });
}

// Set the monthly budgeted target for a category (dollars -> integer cents).
// Wraps Actual's setBudgetAmount; amount 0 clears the target.
async function setBudgetAmount({ month, categoryId, amount } = {}) {
  if (!categoryId) throw new Error('categoryId required');
  const m = month || todayYMD().slice(0, 7);
  const cents = toCents(amount);
  if (cents < 0) throw new Error('amount must be a number >= 0');
  return withApi(async (api) => {
    await api.setBudgetAmount(m, categoryId, cents);
    const settings = loadBudgetSettings();
    if (settings.categories[categoryId] && Object.prototype.hasOwnProperty.call(settings.categories[categoryId], 'monthlyTarget')) {
      delete settings.categories[categoryId].monthlyTarget;
      writeJsonSafe(BUDGET_SETTINGS_PATH, settings);
    }
    return { ok: true, month: m, categoryId, amount: fromCents(cents) };
  }, { mode: 'write' });
}

// ---------------------------------------------------------------------------
// Reimbursement — "who owes me" ledger (port of reimb-report.js, structured)
// ---------------------------------------------------------------------------
// Your roster of people (names/slugs/aliases) lives OUTSIDE the code so this repo
// can be open-sourced without leaking anyone's name. Real values go in
// personal-config.json (gitignored); see personal-config.example.json for the shape.
// Absent => harmless generic placeholders (attribution simply won't match real people
// until you add your own config). loadOwesConfig() also folds in owes-config.json.
const PERSONAL_CONFIG_PATH = statePath('personalConfig');
const _roster = readJsonSafe(PERSONAL_CONFIG_PATH, null) || {};
const PEOPLE = new Set(
  (Array.isArray(_roster.people) && _roster.people.length ? _roster.people : ['alex', 'sam', 'jordan', 'taylor'])
    .map((s) => String(s).toLowerCase())
);
const NAME_MAP = (Array.isArray(_roster.nameMap) && _roster.nameMap.length
  ? _roster.nameMap
  : [['alex', 'alex'], ['sam', 'sam'], ['jordan', 'jordan'], ['taylor', 'taylor']]
).map(([a, b]) => [String(a).toLowerCase(), String(b).toLowerCase()]);
let SETTLED_PREPAID;
try { SETTLED_PREPAID = new RegExp(_roster.settledPrepaid || 'a^', 'i'); } catch (_) { SETTLED_PREPAID = /a^/; }
const GROUP_MARKERS = /roommates|others'|others |fronted for group|group-fronted|\bgroup\b/i;

function slugFromName(raw) {
  const low = raw.trim().toLowerCase();
  for (const [sub, slug] of NAME_MAP) if (low.includes(sub)) return slug;
  const first = low.split(/\s+/)[0];
  return PEOPLE.has(first) ? first : null;
}
function attribute(label, notes) {
  const note = notes || '';
  const tags = (note.match(/#[a-z0-9_-]+/gi) || []).map((s) => s.slice(1).toLowerCase());
  if (tags.includes('adj') || /\[sw-adj\]/i.test(note) || /offset:\s*my share/i.test(note))
    return { person: '(self-offset)', event: null, exclude: true, how: 'tag/adj' };
  if (tags.includes('settled') || SETTLED_PREPAID.test(`${label} ${note}`))
    return { person: '(settled-prepaid)', event: null, exclude: true, how: 'settled' };
  const event = (tags.find((t) => t.startsWith('ev-')) || '').replace(/^ev-/, '') || null;
  const tagPerson = tags.find((t) => PEOPLE.has(t));
  if (tagPerson) return { person: tagPerson, event, how: 'tag' };
  const text = `${label} ${note}`;
  let m = text.match(/\b(?:from|to)\s+([A-Za-z][A-Za-z .'-]+?)(?:\s+[A-Z0-9]{6,}|\s*$|\s*\|)/);
  if (m) { const s = slugFromName(m[1]); if (s) return { person: s, event, how: 'zelle' }; }
  const trail = [...text.matchAll(/-\s*([A-Z][a-z]+)\b/g)];
  if (trail.length) { const s = slugFromName(trail[trail.length - 1][1]); if (s) return { person: s, event, how: 'dash' }; }
  const low = text.toLowerCase();
  for (const [sub, slug] of NAME_MAP) if (low.includes(sub)) return { person: slug, event, how: 'map' };
  if (GROUP_MARKERS.test(text)) return { person: '(group/unsplit)', event, how: 'group' };
  return { person: '(unattributed)', event, how: 'none' };
}

// Defaults preserve prior hardcoded behavior when owes-config.json is absent.
// Expected baseline amounts are in integer cents (e.g. 25488 = $254.88).
// Debtor patterns are stored as strings (case-insensitive) so the config stays
// plain JSON.
// Generic fallback used only when owes-config.json is absent (public repo). Your
// real amounts/patterns/trips live in the gitignored owes-config.json; see
// owes-config.example.json. Keeping this empty means no personal data ships in code.
const DEFAULT_OWES = {
  expected: {},
  debtorPatterns: {},
  tripStart: {},
  swNet: [],
  settledExt: [],
  autoReimbTags: [],
  eventStatus: {},
  autoDetectExcludeEvents: [],
};

// Read + normalize the editable owes-config (falling back to defaults). Compiles
// debtor patterns to RegExp and teaches the attributor about any newly named
// people so their #tags / name matches are recognized.
function loadOwesConfig() {
  const cfg = readJsonSafe(OWES_CONFIG_PATH, null) || {};
  const expected = cfg.expected && typeof cfg.expected === 'object' ? cfg.expected : DEFAULT_OWES.expected;
  const tripStart = cfg.tripStart && typeof cfg.tripStart === 'object' ? cfg.tripStart : DEFAULT_OWES.tripStart;
  const patterns = cfg.debtorPatterns && typeof cfg.debtorPatterns === 'object' ? cfg.debtorPatterns : DEFAULT_OWES.debtorPatterns;
  const swNet = new Set(Array.isArray(cfg.swNet) ? cfg.swNet : DEFAULT_OWES.swNet);
  const settledExt = new Set(Array.isArray(cfg.settledExt) ? cfg.settledExt : DEFAULT_OWES.settledExt);
  const eventStatus = cfg.eventStatus && typeof cfg.eventStatus === 'object' ? cfg.eventStatus : DEFAULT_OWES.eventStatus;
  const autoDetectExcludeEvents = new Set(
    (Array.isArray(cfg.autoDetectExcludeEvents) ? cfg.autoDetectExcludeEvents : DEFAULT_OWES.autoDetectExcludeEvents)
      .map((s) => String(s).toLowerCase())
  );
  // People whose expenses the user merely fronts (e.g. a roommate's bills).
  // Tagging a charge with one of these auto-files it under Reimbursement on next sync
  // so it leaves personal spending and shows up as owed in Who-Owes-Me.
  const autoReimbTags = (Array.isArray(cfg.autoReimbTags) ? cfg.autoReimbTags : DEFAULT_OWES.autoReimbTags).map((s) => String(s).toLowerCase());
  // Manual per-person trip overrides that WIN over the auto Splitwise snapshot
  // (which can lag or miss a group — e.g. a settle-up that wasn't actually paid).
  // Shape: { slug: [{ event, amount }] }. Amounts are dollars, matching the
  // owes-truth bySlug contract; amount 0 clears that event's debt.
  const manualTrips = cfg.manualTrips && typeof cfg.manualTrips === 'object' ? cfg.manualTrips : {};
  const debtorRe = {};
  for (const [slug, src] of Object.entries(patterns)) {
    try { debtorRe[slug] = new RegExp(src, 'i'); } catch (_) { /* skip invalid pattern */ }
  }
  for (const slug of new Set([...Object.keys(patterns), ...Object.values(expected).flatMap((m) => Object.keys(m)), ...Object.keys(manualTrips)])) {
    PEOPLE.add(slug);
    if (!NAME_MAP.some(([, s]) => s === slug)) NAME_MAP.push([slug, slug]);
  }
  return { expected, debtorRe, tripStart, swNet, settledExt, autoReimbTags, manualTrips, eventStatus, autoDetectExcludeEvents };
}

// Only a complete, fresh schema-v2 pairwise snapshot can contribute current
// Splitwise debt. A structurally valid stale snapshot is returned separately as
// last-known context and is never substituted into current totals.
function classifyOwesTruth(t, { now = Date.now(), maxAgeMs = owesSnapshotMaxAgeMs() } = {}) {
  if (!t || typeof t !== 'object' || !t.bySlug || typeof t.bySlug !== 'object') {
    return { current: null, lastKnown: null, warning: 'splitwise-snapshot-missing' };
  }
  const src = String(t.source || '');
  const manifest = t.manifest;
  const complete = t.schemaVersion === 2 &&
    /^splitwise-pairwise\b/i.test(src) &&
    manifest &&
    manifest.complete === true &&
    manifest.itemizedComplete === true &&
    manifest.resolvedEvents === manifest.expectedEvents &&
    Array.isArray(manifest.failedEvents) &&
    manifest.failedEvents.length === 0 &&
    manifest.currency === (process.env.SPLITWISE_CURRENCY || 'USD');
  if (!complete) {
    return { current: null, lastKnown: null, warning: 'splitwise-snapshot-incomplete' };
  }
  const generatedAt = Date.parse(t.generatedAt || '');
  if (!Number.isFinite(generatedAt) || generatedAt > now + 5 * 60 * 1000) {
    return { current: null, lastKnown: null, warning: 'splitwise-snapshot-invalid-time' };
  }
  if (now - generatedAt > maxAgeMs) {
    return { current: null, lastKnown: t, warning: 'splitwise-snapshot-stale' };
  }
  return { current: t, lastKnown: null, warning: null };
}
function loadOwesTruth(options) {
  return classifyOwesTruth(readJsonSafe(OWES_TRUTH_PATH, null), options);
}

function directReimbursementLegs(legs) {
  return (Array.isArray(legs) ? legs : []).filter((leg) => !(leg.event || /splitwise/i.test(leg.label || '')));
}
// Venmo sidecar — same shape as owes-truth. Null when absent/invalid.
function loadVenmoTruth() {
  const t = readJsonSafe(VENMO_TRUTH_PATH, null);
  if (!t || typeof t !== 'object' || !t.bySlug || typeof t.bySlug !== 'object') return null;
  return t;
}

// ---------------------------------------------------------------------------
// Events / trips — a named grouping you tag transactions into with #ev-<slug>.
// Stored as a sidecar; owes-snapshot.js reads the same file to wire a trip's
// Splitwise group into the who-owes-me snapshot automatically.
// ---------------------------------------------------------------------------
const slugify = (s) => String(s || '').toLowerCase().trim().replace(/[^a-z0-9]+/g, '-').replace(/^-+|-+$/g, '').slice(0, 40);
function readEvents() {
  const s = readJsonSafe(EVENTS_PATH, { events: [] });
  return { events: s && Array.isArray(s.events) ? s.events : [] };
}
async function getEvents() {
  const { events } = readEvents();
  // Enrich each event with its tagged-charge count + total from the ledger window.
  let tagCounts = {};
  try {
    tagCounts = await withApi(async (api) => {
      const accts = (await api.getAccounts()).filter((a) => !a.closed);
      const from = addDays(todayYMD(), -400);
      const counts = {};
      for (const a of accts) {
        const tx = await api.getTransactions(a.id, from, todayYMD());
        for (const t of tx) {
          const scan = (notes) => { const m = (notes || '').match(/#ev-([a-z0-9-]+)/gi) || []; for (const tag of m) { const slug = tag.slice(4).toLowerCase(); counts[slug] = counts[slug] || { count: 0, spent: 0 }; counts[slug].count++; } };
          scan(t.notes);
          for (const sub of t.subtransactions || []) scan(sub.notes);
        }
      }
      return counts;
    });
  } catch (_) { /* best-effort enrichment */ }
  return {
    events: events
      .slice()
      .sort((a, b) => (b.start || '').localeCompare(a.start || '') || (b.created || '').localeCompare(a.created || ''))
      .map((e) => ({ ...e, taggedCount: (tagCounts[e.slug] || {}).count || 0 })),
  };
}
function saveEvent({ slug, name, start, members, group } = {}) {
  const nm = (name || '').trim();
  if (!nm && !slug) throw new Error('name required');
  const s = slug ? slugify(slug) : slugify(nm);
  if (!s) throw new Error('a valid name/slug is required');
  const store = readEvents();
  const mem = Array.isArray(members)
    ? members.map((m) => slugify(m)).filter(Boolean)
    : String(members || '').split(/[,\n]/).map((m) => slugify(m)).filter(Boolean);
  const existing = store.events.find((e) => e.slug === s);
  const rec = {
    slug: s,
    name: nm || (existing && existing.name) || s,
    start: start || (existing && existing.start) || todayYMD(),
    members: mem.length ? mem : (existing && existing.members) || [],
    group: (group != null ? String(group).trim() : (existing && existing.group)) || '',
    created: (existing && existing.created) || new Date().toISOString(),
  };
  store.events = store.events.filter((e) => e.slug !== s);
  store.events.push(rec);
  writeJsonSafe(EVENTS_PATH, store);
  return { ok: true, event: rec };
}
function deleteEvent({ slug } = {}) {
  if (!slug) throw new Error('slug required');
  const store = readEvents();
  const before = store.events.length;
  store.events = store.events.filter((e) => e.slug !== slugify(slug));
  writeJsonSafe(EVENTS_PATH, store);
  return { ok: true, removed: before - store.events.length };
}

// Raw config for the GET/PUT endpoint (patterns kept as strings).
function getOwesConfig() {
  return readJsonSafe(OWES_CONFIG_PATH, null) || DEFAULT_OWES;
}
function setOwesConfig(next) {
  if (!next || typeof next !== 'object') throw new Error('config object required');
  const clean = {
    expected: next.expected && typeof next.expected === 'object' ? next.expected : DEFAULT_OWES.expected,
    debtorPatterns: next.debtorPatterns && typeof next.debtorPatterns === 'object' ? next.debtorPatterns : DEFAULT_OWES.debtorPatterns,
    tripStart: next.tripStart && typeof next.tripStart === 'object' ? next.tripStart : DEFAULT_OWES.tripStart,
    swNet: Array.isArray(next.swNet) ? next.swNet : DEFAULT_OWES.swNet,
    settledExt: Array.isArray(next.settledExt) ? next.settledExt : DEFAULT_OWES.settledExt,
    autoReimbTags: Array.isArray(next.autoReimbTags) ? next.autoReimbTags : DEFAULT_OWES.autoReimbTags,
    eventStatus: next.eventStatus && typeof next.eventStatus === 'object' ? next.eventStatus : DEFAULT_OWES.eventStatus,
    autoDetectExcludeEvents: Array.isArray(next.autoDetectExcludeEvents) ? next.autoDetectExcludeEvents : DEFAULT_OWES.autoDetectExcludeEvents,
  };
  // Preserve manual trip overrides (not part of the editable form, but must
  // survive a config write from the settings screen).
  const existing = readJsonSafe(OWES_CONFIG_PATH, null) || {};
  const manualTrips = next.manualTrips && typeof next.manualTrips === 'object' ? next.manualTrips : existing.manualTrips;
  if (manualTrips && typeof manualTrips === 'object') clean.manualTrips = manualTrips;
  for (const [slug, src] of Object.entries(clean.debtorPatterns)) {
    if (typeof src !== 'string' || src.length > 500 || !safeRegex(src)) {
      throw new Error(`Unsafe debtor pattern for ${slug}`);
    }
    try { new RegExp(src, 'i'); } catch (e) { throw new Error(`Bad debtor pattern for ${slug}: ${e.message}`); }
  }
  writeJsonSafe(OWES_CONFIG_PATH, clean);
  return { ok: true };
}

// ---------------------------------------------------------------------------
// Reimbursement links — connect a repayment inflow to the expense(s) it repays
// ---------------------------------------------------------------------------
function readReimbLinks() {
  const store = readJsonSafe(REIMB_LINKS_PATH, { schemaVersion: 2, links: [] });
  if (!store || !Array.isArray(store.links)) return { schemaVersion: 2, links: [] };
  return store;
}
function writeReimbLinks(store) {
  writeJsonSafe(REIMB_LINKS_PATH, { schemaVersion: 2, ...store });
}
function txnRef(t) {
  if (!t || t.id == null) throw new Error('transaction id required');
  return {
    id: String(t.id),
    date: t.date || null,
    payee: t.payee || '',
    amount: fromCents(toCents(t.amount)),
    accountId: t.accountId || null,
    account: t.account || '',
    imported: !!t.imported,
  };
}
async function prepareReimbLinkAdmission(request, api) {
  const run = async (actualApi) => {
    const groups = await actualApi.getCategoryGroups();
    const reimbId = reimbCategoryId(groups);
    const payees = await actualApi.getPayees();
    const pn = Object.fromEntries(payees.map((p) => [p.id, p.name || '']));
    const { links } = readReimbLinks();
    return admitManualLink(actualApi, request, {
      existingLinks: links,
      reimbCategoryId: reimbId,
      payeeNames: pn,
    });
  };
  if (api) return run(api);
  return withApi(run, { mode: 'write' });
}
async function getReimbLinks({ id } = {}) {
  const { links } = readReimbLinks();
  const legacyReport = buildLegacyMigrationReport(links);
  if (!id) return { links, legacyReport };
  return withApi(async (api) => {
    const payees = await api.getPayees();
    const pn = Object.fromEntries(payees.map((p) => [p.id, p.name || '']));
    const txnLive = await locateTransactionLive(api, id, {}, pn);
    const withAlloc = (ref, link, role) => enrichEndpointForRead(ref, link, role);
    const asInflow = links
      .filter((l) => l.inflow && l.inflow.id === id)
      .map((l) => withAlloc(l.expense, l, 'expense'));
    const asExpense = links
      .filter((l) => l.expense && l.expense.id === id)
      .map((l) => withAlloc(l.inflow, l, 'inflow'));
    let capacity = null;
    if (txnLive?.amountCents > 0) {
      capacity = summarizeEndpointCapacity({
        txnId: id,
        txnAmountCents: txnLive.amountCents,
        links,
        role: 'inflow',
      });
    } else if (txnLive?.amountCents < 0) {
      capacity = summarizeEndpointCapacity({
        txnId: id,
        txnAmountCents: txnLive.amountCents,
        links,
        role: 'expense',
      });
    }
    return {
      asInflow,
      asExpense,
      capacity,
      legacyReport,
    };
  });
}
async function addReimbLink(request = {}) {
  const { inflow, expense, person, operationIdentity, faultInjector, admission: preAdmission } = request;
  if (!inflow?.id || !expense?.id) throw new Error('inflow and expense ids required');
  assertTransactionMutationAvailable({ ids: [inflow.id, expense.id] });
  return withApi(async (api) => {
    assertTransactionMutationAvailable({ ids: [inflow.id, expense.id] });
    const prepared = preAdmission || await prepareReimbLinkAdmission({ ...request, person }, api);
    return getReimbursementLinkSagaManager().link(api, prepared, {
      operationIdentity,
      faultInjector,
    });
  }, { mode: 'write' });
}
async function deleteReimbLink({ inflowId, expenseId, expectedVersion, operationIdentity, faultInjector } = {}) {
  if (!inflowId || !expenseId) throw new Error('inflowId and expenseId required');
  assertTransactionMutationAvailable({ ids: [inflowId, expenseId] });
  return withApi(async (api) => {
    assertTransactionMutationAvailable({ ids: [inflowId, expenseId] });
    const existing = readReimbLinks().links.find(
      (link) => String(link?.inflow?.id) === String(inflowId)
        && String(link?.expense?.id) === String(expenseId),
    );
    return getReimbursementLinkSagaManager().unlink(api, {
      inflowId,
      expenseId,
      accountId: existing?.inflow?.accountId || null,
      expectedVersion,
      operationIdentity,
      faultInjector,
    });
  }, { mode: 'write' });
}
function exportReimbursementLegacyReport() {
  return buildLegacyMigrationReport(readReimbLinks().links);
}

// ---------------------------------------------------------------------------
// Repayment auto-matcher — suggest which incoming payments settle which fronted
// (Reimbursement-category) expenses, per person. You confirm; confirming writes
// amount-allocated links. Trip/Splitwise debts stay owned by the snapshot engine.
// ---------------------------------------------------------------------------
function readReimbSuggest() {
  const store = readJsonSafe(REIMB_SUGGEST_PATH, { confirmed: {}, dismissed: [] });
  if (!store || typeof store !== 'object' || Array.isArray(store)) {
    return { confirmed: {}, dismissed: [] };
  }
  if (!store.confirmed || typeof store.confirmed !== 'object' || Array.isArray(store.confirmed)) {
    store.confirmed = {};
  }
  if (!Array.isArray(store.dismissed)) {
    store.dismissed = [];
  }
  return store;
}
function writeReimbSuggest(s) { writeJsonSafe(REIMB_SUGGEST_PATH, s); }

// Best-effort provenance allocation of one inflow across a person's outstanding
// fronted expenses (each { id, date, payee, amount<0 dollars, remaining>0 dollars }).
// Total allocated is always capped at the inflow (remainder >= 0). Returns
// { allocations:[{expense,amount}], matched, kind, score, reason } — allocations may
// be [] when there are no clean ledger charges to point at (person-level repayment).
function allocateInflow(inflow, expenses) {
  const pool = expenses.filter((e) => e.remaining > 0.005).sort((a, b) => (a.date < b.date ? -1 : 1));
  const A = round2(inflow.amount);
  const tol = Math.max(1, A * 0.02);
  const refOf = (e) => ({ id: e.id, date: e.date, payee: e.payee, amount: e.amount });
  const outstanding = round2(pool.reduce((s, e) => s + e.remaining, 0));

  // 1. Exact single expense.
  const exact = pool.find((e) => Math.abs(e.remaining - A) <= tol);
  if (exact) {
    const amt = round2(Math.min(exact.remaining, A));
    return { allocations: [{ expense: refOf(exact), amount: amt }], matched: amt, kind: 'exact', score: 0.98,
      reason: `Matches ${exact.payee || 'a charge'} (${exact.date})` };
  }
  // 2. Subset of 2–3 expenses summing ~ A (each capped so the total never exceeds A).
  for (let k = 2; k <= 3 && k <= pool.length; k++) {
    const combo = findSubset(pool, k, A, tol);
    if (combo) {
      let left = A;
      const allocations = [];
      for (const e of combo) { const take = round2(Math.min(e.remaining, left)); if (take > 0.005) { allocations.push({ expense: refOf(e), amount: take }); left = round2(left - take); } }
      const matched = round2(allocations.reduce((s, x) => s + x.amount, 0));
      return { allocations, matched, kind: 'subset', score: 0.9,
        reason: `Covers ${allocations.length} charges (${combo.map((e) => e.payee || '?').join(', ')})` };
    }
  }
  // 3. Greedy — oldest first until the inflow is spent (or charges run out).
  let left = A;
  const allocations = [];
  for (const e of pool) {
    if (left <= 0.005) break;
    const take = round2(Math.min(e.remaining, left));
    if (take <= 0.005) continue;
    allocations.push({ expense: refOf(e), amount: take });
    left = round2(left - take);
  }
  const matched = round2(allocations.reduce((s, x) => s + x.amount, 0));
  const over = A > outstanding + tol;
  const kind = over ? 'over' : allocations.length > 1 ? 'multi' : allocations.length === 1 ? 'partial' : 'person';
  const reason = allocations.length === 0
    ? 'Looks like a repayment — apply toward what they owe'
    : over
      ? `Covers all ${allocations.length} tracked charge${allocations.length === 1 ? '' : 's'}; ${fmtUSD(round2(A - matched))} extra`
      : `Applies to ${allocations.length} charge${allocations.length === 1 ? '' : 's'} (oldest first)`;
  return { allocations, matched, kind, score: allocations.length ? 0.7 : 0.5, reason };
}
function findSubset(pool, k, target, tol, start = 0, chosen = []) {
  if (chosen.length === k) {
    const sum = chosen.reduce((s, e) => s + e.remaining, 0);
    return Math.abs(sum - target) <= tol ? chosen.slice() : null;
  }
  for (let i = start; i < pool.length; i++) {
    const r = findSubset(pool, k, target, tol, i + 1, [...chosen, pool[i]]);
    if (r) return r;
  }
  return null;
}
const fmtUSD = (n) => `$${(Math.round(n * 100) / 100).toFixed(2)}`;

// Compute (and persist nothing but dismissals) suggested repayment matches.
// Only surfaces inflows for people the engine says currently OWE you (so people who
// already squared up / overpaid never generate noise), attributed to that person,
// not yet filed under Reimbursement, not an internal transfer, not already linked
// or dismissed. Expense remaining is net of prior links; allocations are provenance.
async function suggestRepayments({ from, to } = {}) {
  return withApi(async (api) => {
    from = from || REIMB_SUGGEST_FROM;
    to = to || todayYMD();

    // Who currently owes (authoritative net from the tuned engine).
    const reimb = await getReimbursement({ from, to });
    const owedBySlug = {};
    for (const o of reimb.owes || []) owedBySlug[o.slug] = o.owed;

    const groups = await api.getCategoryGroups();
    const catInfo = buildCatInfo(groups);
    let reimbId = null;
    for (const g of groups) for (const c of g.categories || []) if (REIMB_CAT.test(c.name || '')) reimbId = c.id;
    if (!reimbId) throw new Error('Reimbursement category not found');
    const payees = await api.getPayees();
    const pn = {};
    for (const p of payees) pn[p.id] = p.name || '';
    const accts = (await api.getAccounts()).filter((a) => !a.closed);

    const inflows = [];        // candidate repayments
    const expByPerson = {};    // slug -> [{id,date,payee,amount<0,person}]
    for (const a of accts) {
      const tx = await api.getTransactions(a.id, from, to);
      for (const t of tx) {
        const parentPayee = pn[t.payee] || t.imported_payee || '';
        const isSplit = t.is_parent && Array.isArray(t.subtransactions) && t.subtransactions.length;
        const parentTransfer = hasActualTransferIdentity(t);
        // Fronted reimbursement expenses (with ids) — the settle-able side.
        const pushExp = (id, amount, notes, payeeName) => {
          const at = attribute(`${payeeName} ${notes || ''}`.trim(), notes || '');
          if (!at.person || at.person.startsWith('(')) return; // must map to a real person
          (expByPerson[at.person] = expByPerson[at.person] || []).push({
            id: String(id), date: t.date, payee: payeeName || '(no payee)', amount: d2(amount), person: at.person,
          });
        };
        if (isSplit) {
          for (const s of t.subtransactions)
            if (s.category === reimbId && s.amount < 0) pushExp(s.id, s.amount, s.notes || t.notes, (s.payee && pn[s.payee]) || parentPayee);
        } else if (t.category === reimbId && t.amount < 0) {
          pushExp(t.id, t.amount, t.notes, parentPayee);
        }
        // Candidate repayment inflows: positive, simple, not income, not already
        // filed under Reimbursement, not an internal transfer.
        if (!isSplit && t.amount > 0 && !parentTransfer) {
          const kind = catInfo[t.category] ? catInfo[t.category].kind : 'uncat';
          if (kind === 'income' || t.category === reimbId) continue;
          const at = attribute(`${parentPayee} ${t.notes || ''}`.trim(), t.notes || '');
          if (!at.person || at.person.startsWith('(')) continue;
          inflows.push({ id: String(t.id), date: t.date, payee: parentPayee || 'Payment', amount: d2(t.amount), person: at.person, notes: t.notes || '' });
        }
      }
    }

    // Net each expense's remaining against amounts already linked to it.
    const { links } = readReimbLinks();
    const allocByExp = {};
    const linkedInflow = new Set();
    for (const l of links) {
      if (l.inflow) linkedInflow.add(l.inflow.id);
      if (l.expense) {
        const trusted = trustedLinkedCents(l);
        if (trusted > 0) {
          allocByExp[l.expense.id] = round2((allocByExp[l.expense.id] || 0) + fromCents(trusted));
        }
      }
    }
    for (const slug of Object.keys(expByPerson))
      for (const e of expByPerson[slug]) e.remaining = round2(Math.max(0, -e.amount - (allocByExp[e.id] || 0)));

    const { dismissed } = readReimbSuggest();
    const dismissedSet = new Set(dismissed);

    const suggestions = [];
    for (const inf of inflows.sort((a, b) => (a.date < b.date ? 1 : -1))) {
      if (linkedInflow.has(inf.id) || dismissedSet.has(inf.id)) continue;
      const owed = owedBySlug[inf.person];
      if (!(owed > 0.5)) continue; // only suggest for people who actually owe you
      const alloc = allocateInflow(inf, expByPerson[inf.person] || []);
      const tooLargeForCurrentDebt = inf.amount > owed + Math.max(10, owed * 0.2);
      if (alloc.kind === 'over' && tooLargeForCurrentDebt) continue;
      // Reserve the allocated remaining so a later inflow doesn't double-book it.
      for (const a of alloc.allocations) {
        const e = (expByPerson[inf.person] || []).find((x) => x.id === a.expense.id);
        if (e) e.remaining = round2(Math.max(0, e.remaining - a.amount));
      }
      suggestions.push({
        id: `sg_${inf.id}`,
        inflow: { id: inf.id, date: inf.date, payee: inf.payee, amount: inf.amount },
        person: inf.person,
        owed: round2(owed),
        allocations: alloc.allocations,
        matched: alloc.matched,
        remainder: round2(inf.amount - alloc.matched),
        kind: alloc.kind,
        score: alloc.score,
        reason: alloc.reason,
        createdAt: new Date().toISOString(),
      });
    }
    suggestions.sort((a, b) => b.score - a.score || (a.inflow.date < b.inflow.date ? 1 : -1));
    return { suggestions, count: suggestions.length, generatedAt: new Date().toISOString(), range: { from, to } };
  });
}

// Confirm a suggestion: file the inflow under Reimbursement (so it nets against what
// the person owes — the "zero out" flow) and write amount-allocated provenance links.
// Re-derives the suggestion so a stale client can't act on a vanished match.
async function prepareRepaymentConfirmationAdmission({ id, from, to } = {}) {
  if (!id) throw new Error('suggestion id required');
  const requestedInflowId = id.startsWith('sg_') ? id.slice(3) : null;
  assertTransactionMutationAvailable({ ids: [requestedInflowId] });
  const { suggestions } = await suggestRepayments({ from, to });
  const sg = suggestions.find((s) => s.id === id);
  if (!sg) throw new RepaymentSuggestionInvalidError();
  assertTransactionMutationAvailable({
    ids: [sg.inflow.id, ...sg.allocations.map((allocation) => allocation.expense?.id)],
  });
  return withApi(async (api) => {
    const groups = await api.getCategoryGroups();
    const reimbId = reimbCategoryId(groups);
    const payees = await api.getPayees();
    const pn = Object.fromEntries(payees.map((p) => [p.id, p.name || '']));
    const resolved = await resolveRepaymentEndpoints(api, sg, pn);
    const { links } = readReimbLinks();
    return buildAdmissionPayload({
      suggestionId: id,
      suggestion: sg,
      reimbCategoryId: reimbId,
      resolved,
      existingLinks: links,
    });
  });
}

async function validateRepaymentConfirmationAdmission(options) {
  return prepareRepaymentConfirmationAdmission(options);
}

async function confirmRepayment({
  id,
  from,
  to,
  operationIdentity,
  faultInjector,
  admission,
} = {}) {
  const prepared = admission || await prepareRepaymentConfirmationAdmission({ id, from, to });
  return withApi(async (api) => getRepaymentConfirmationSagaManager().confirm(api, {
    ...prepared,
    operationIdentity,
    faultInjector,
  }), { mode: 'write' });
}
function reimbCategoryId(groups) {
  for (const g of groups) for (const c of g.categories || []) if (REIMB_CAT.test(c.name || '')) return c.id;
  throw new Error('Reimbursement category not found');
}

// Dismiss a suggestion so its inflow is never re-suggested (until re-enabled).
function dismissRepayment({ id, inflowId } = {}) {
  const infId = inflowId || (id && id.startsWith('sg_') ? id.slice(3) : null);
  if (!infId) throw new Error('inflowId (or sg_ id) required');
  assertTransactionMutationAvailable({ ids: [infId] });
  const store = readReimbSuggest();
  if (!store.dismissed.includes(infId)) store.dismissed.push(infId);
  writeReimbSuggest(store);
  return { ok: true, dismissed: infId };
}
// Undo a dismissal (lets a suggestion resurface).
function undismissRepayment({ inflowId } = {}) {
  if (!inflowId) throw new Error('inflowId required');
  assertTransactionMutationAvailable({ ids: [inflowId] });
  const store = readReimbSuggest();
  store.dismissed = store.dismissed.filter((x) => x !== inflowId);
  writeReimbSuggest(store);
  return { ok: true };
}

async function getReimbursement({ from, to, openOnly = false } = {}) {
  return withApi(async (api) => {
    const {
      expected: EXPECTED,
      debtorRe: DEBTOR_RE,
      tripStart: TRIP_START,
      swNet: SW_NET,
      settledExt: SETTLED_EXT,
      eventStatus: EVENT_STATUS,
      autoDetectExcludeEvents: AUTO_DETECT_EXCLUDE_EVENTS,
    } = loadOwesConfig();
    // Who-owes-you and the People roster are stable across UI windows, but direct
    // ledger debts before the cutoff are historical/settled outside this system.
    // `from`/`to` only scope the headline summary below.
    const legFrom = REIMB_LEDGER_FROM;
    const legTo = todayYMD();
    const winFrom = from || legFrom;
    const winTo = to || legTo;
    const groups = await api.getCategoryGroups();
    let reimbId = null;
    for (const g of groups) for (const c of g.categories || []) if (REIMB_CAT.test(c.name || '')) reimbId = c.id;
    if (!reimbId) throw new Error('Reimbursement category not found');
    const payees = await api.getPayees();
    const pn = {};
    for (const p of payees) pn[p.id] = p.name;
    const accts = await api.getAccounts();

    const legs = [];
    const inflows = [];
    for (const a of accts) {
      if (a.offbudget) continue;
      const tx = await api.getTransactions(a.id, legFrom, legTo);
      for (const t of tx) {
        const parentPayee = pn[t.payee] || t.imported_payee || '';
        const push = (amount, notes, meta = {}) => {
          const payeeName = meta.payee || parentPayee;
          const label = [payeeName || '', notes || ''].join(' ').replace(/\s+/g, ' ').trim();
          const at = attribute(label, notes || '');
          legs.push({
            id: String(meta.id || t.id),
            parentId: meta.parentId || null,
            isLeg: !!meta.isLeg,
            accountId: a.id,
            account: a.name || '',
            payee: payeeName || '',
            cleared: t.cleared,
            imported: !!t.imported_id,
            categoryId: reimbId,
            date: t.date,
            amount,
            notes: notes || '',
            label: label.slice(0, 80),
            ...at,
          });
        };
        const isSplit = t.subtransactions && t.subtransactions.length;
        if (isSplit) {
          for (const s of t.subtransactions) if (s.category === reimbId) push(s.amount, s.notes || t.notes, {
            id: s.id || t.id,
            parentId: t.id,
            isLeg: true,
            payee: (s.payee && pn[s.payee]) || parentPayee,
          });
        } else if (t.category === reimbId) push(t.amount, t.notes, { id: t.id });
        if (!isSplit && t.amount > 0)
          inflows.push({
            date: t.date,
            amount: t.amount,
            label: `${pn[t.payee] || ''} ${t.notes || ''}`.replace(/\s+/g, ' ').trim(),
            events: ((t.notes || '').match(/#ev-([a-z0-9-]+)/gi) || []).map((tag) => tag.slice(4).toLowerCase()),
          });
      }
    }
    legs.sort((a, b) => (a.date < b.date ? -1 : 1));

    const byP = {};
    for (const l of legs) (byP[l.person] = byP[l.person] || []).push(l);
    const persons = Object.keys(byP).filter((p) => !p.startsWith('('));
    const sumOf = (p) => byP[p].reduce((s, l) => s + l.amount, 0);
    persons.sort((a, b) => sumOf(a) - sumOf(b));

    const people = persons
      .map((p) => {
        const net = sumOf(p);
        const status = net < -50 ? 'owes_you' : net > 50 ? 'over_settled' : 'settled';
        return {
          slug: p,
          net: d2(net),
          status,
          legs: byP[p].map((l) => ({
            id: l.id, parentId: l.parentId, isLeg: l.isLeg, accountId: l.accountId, account: l.account,
            payee: l.payee, cleared: l.cleared, imported: l.imported, categoryId: l.categoryId,
            date: l.date, amount: d2(l.amount), label: l.label, notes: l.notes, event: l.event, how: l.how,
          })),
        };
      })
      .filter((p) => !openOnly || p.status === 'owes_you');

    const owesYou = persons.filter((p) => sumOf(p) < -50);
    const totalOwedCents = owesYou.reduce((s, p) => s + sumOf(p), 0);

    // Event rollup
    const evMap = {};
    for (const l of legs) if (l.event) (evMap[l.event] = evMap[l.event] || []).push(l);
    const events = Object.keys(evMap)
      .map((e) => {
        const items = evMap[e];
        const fronted = items.filter((l) => l.amount < 0).reduce((s, l) => s + l.amount, 0);
        const recovered = items.filter((l) => l.amount > 0).reduce((s, l) => s + l.amount, 0);
        const net = fronted + recovered;
        let status;
        if (EVENT_STATUS[e]) status = EVENT_STATUS[e];
        else if (SETTLED_EXT.has(e)) status = 'settled_ext';
        else if (SW_NET.has(e)) status = 'sw_net';
        else status = net < -50 ? 'open' : net > 50 ? 'over' : 'settled';
        const dates = items.map((l) => l.date).sort();
        const firstDate = dates[0] || null;
        const lastDate = dates[dates.length - 1] || null;
        // Best available "settled on" proxy: the last activity date once the event
        // is no longer open (i.e. the final settle-up payment landed). Open trips
        // have no settled date yet.
        const settledDate = status === 'open' ? null : lastDate;
        return {
          event: e,
          fronted: d2(fronted),
          recovered: d2(recovered),
          net: d2(net),
          status,
          n: items.length,
          firstDate,
          lastDate,
          settledDate,
        };
      })
      .sort((a, b) => a.net - b.net);

    // Expected debtors (Splitwise ground-truth) with untagged-inflow auto-detect
    const expected = [];
    for (const [ev, peopleMap] of Object.entries(EXPECTED)) {
      let eExp = 0, eRecv = 0;
      const rows = [];
      for (const [slug, exp] of Object.entries(peopleMap)) {
        const tagged = legs
          .filter((l) => l.event === ev && l.person === slug && l.amount > 0)
          .reduce((s, l) => s + l.amount, 0);
        const rem0 = exp - tagged;
        let auto = 0;
        const re = DEBTOR_RE[slug];
        const start = TRIP_START[ev];
        if (re && start && rem0 > 0) {
          auto = inflows
            .filter((i) => !i.events.some((ev) => AUTO_DETECT_EXCLUDE_EVENTS.has(ev)) && i.date >= start && re.test(i.label) && i.amount >= 0.4 * rem0 && i.amount <= 1.6 * rem0)
            .reduce((s, i) => s + i.amount, 0);
        }
        const recv = tagged + auto;
        const rem = exp - recv;
        eExp += exp;
        eRecv += recv;
        rows.push({
          slug,
          expected: d2(exp),
          received: d2(recv),
          remaining: d2(rem),
          auto: d2(auto),
          status: rem <= 50 ? 'paid' : recv > 0 ? 'partial' : 'open',
        });
      }
      expected.push({ event: ev, rows, expected: d2(eExp), received: d2(eRecv), remaining: d2(eExp - eRecv) });
    }

    const buckets = {};
    for (const b of ['(group/unsplit)', '(unattributed)', '(self-offset)']) {
      if (!byP[b]) continue;
      const bucketLegs = b === '(group/unsplit)' || b === '(unattributed)'
        ? byP[b].filter((l) => !(l.event || /splitwise/i.test(l.label || '')))
        : byP[b];
      if (!bucketLegs.length) continue;
      buckets[b] = {
        net: d2(bucketLegs.reduce((s, l) => s + l.amount, 0)),
        count: bucketLegs.length,
        legs: bucketLegs.map((l) => ({
          id: l.id, parentId: l.parentId, isLeg: l.isLeg, accountId: l.accountId, account: l.account,
          payee: l.payee, cleared: l.cleared, imported: l.imported, categoryId: l.categoryId,
          date: l.date, amount: d2(l.amount), label: l.label, notes: l.notes,
        })),
      };
    }

    // Combined "who owes me" — AUTHORITATIVE. Trip/group debts come straight from
    // Splitwise's own pairwise balance via the owes-snapshot (see reimbursement docs:
    // NEVER reconstruct per-person trip debts from line items). Personal loans not
    // in any Splitwise group (e.g. a Venmo loan) still come from the ledger.
    // Legacy/manual values are diagnostics only and never substitute for missing
    // current pairwise truth.
    const truthState = loadOwesTruth();
    const truth = truthState.current;
    const tripBySlug = {}; // slug -> [{ event, remaining }]
    let owesSource = truth ? (truth.source || 'splitwise-snapshot') : 'ledger-only';
    const owesGeneratedAt = truth && truth.generatedAt ? truth.generatedAt : null;
    const owesWarning = truthState.warning;
    const lastKnownSplitwise = truthState.lastKnown ? {
      generatedAt: truthState.lastKnown.generatedAt || null,
      total: round2(Number(truthState.lastKnown.total) || 0),
      bySlug: truthState.lastKnown.bySlug,
      source: truthState.lastKnown.source || 'splitwise-snapshot',
    } : null;
    if (truth) {
      for (const [slug, arr] of Object.entries(truth.bySlug))
        tripBySlug[slug] = (Array.isArray(arr) ? arr : [])
          .filter((t) => t && Number(t.amount) > 0.005)
          .map((t) => ({ event: t.event, remaining: round2(Number(t.amount)) }));
    }

    // Venmo debts (imported from a statement CSV) merge in as another source, so a
    // trip settled partly on Venmo and partly on Splitwise shows the combined total.
    const venmo = loadVenmoTruth();
    if (venmo) {
      owesSource += '+venmo';
      for (const [slug, arr] of Object.entries(venmo.bySlug)) {
        const list = tripBySlug[slug] || (tripBySlug[slug] = []);
        for (const v of Array.isArray(arr) ? arr : []) {
          const amount = round2(Number(v.amount) || 0);
          if (!(amount > 0.005)) continue;
          const event = v.event || 'Venmo';
          const i = list.findIndex((t) => t.event === event);
          if (i >= 0) list[i].remaining = round2(list[i].remaining + amount);
          else list.push({ event, remaining: amount });
        }
      }
    }

    // Suppress only event/Splitwise legs. A person may also have an unrelated
    // direct loan, which must remain visible alongside their pairwise trip debt.
    const personalLegsOf = (p) => directReimbursementLegs(byP[p]);
    const personalNetOf = (p) => personalLegsOf(p).reduce((s, l) => s + l.amount, 0);

    const owesSlugs = new Set([...persons, ...Object.keys(tripBySlug)]);
    const owes = [];
    for (const slug of owesSlugs) {
      if (slug.startsWith('(')) continue;
      const pNet = personalNetOf(slug); // integer cents
      const misc = pNet < -50 ? d2(-pNet) : 0; // dollars
      const trips = tripBySlug[slug] || [];
      const owed = round2(misc + trips.reduce((s, t) => s + t.remaining, 0));
      if (owed <= 0.5) continue;
      const legs = personalLegsOf(slug).filter((l) => l.amount < 0).map((l) => ({
          id: l.id, parentId: l.parentId, isLeg: l.isLeg, accountId: l.accountId, account: l.account,
          payee: l.payee, cleared: l.cleared, imported: l.imported, categoryId: l.categoryId,
          date: l.date, amount: d2(l.amount), label: l.label, notes: l.notes,
        }));
      owes.push({ slug, owed, misc, trips, legs });
    }
    owes.sort((a, b) => b.owed - a.owed);
    const totalOwedCombined = round2(owes.reduce((s, o) => s + o.owed, 0));

    // Window summary: fronted / paid back scoped to [winFrom, winTo] (MTD, 7d, 30d,
    // lifetime, …) so the user can see e.g. "June's activity" without the all-time
    // pile. `outstanding` here is the window's net (fronted − paid back); the true
    // all-time balance still owed lives in `totalOwed` (drives the People list).
    const inWin = (d) => { const x = d || ''; return x >= winFrom && x <= winTo; };
    const frontedWin = round2(legs.filter((l) => l.amount < 0 && inWin(l.date)).reduce((s, l) => s + -l.amount, 0) / 100);
    const paidBackWin = round2(legs.filter((l) => l.amount > 0 && inWin(l.date)).reduce((s, l) => s + l.amount, 0) / 100);
    const isLifetimeWin = winFrom <= legFrom && winTo >= legTo;
    const summary = {
      fronted: frontedWin,
      paidBack: paidBackWin,
      // Over the lifetime window the meaningful "outstanding" is the real balance
      // still owed; for a bounded window it's that window's net flow.
      outstanding: isLifetimeWin ? totalOwedCombined : round2(frontedWin - paidBackWin),
      window: { from: winFrom, to: winTo },
      lifetime: isLifetimeWin,
    };

    return {
      range: { from: winFrom, to: winTo },
      totalOwed: totalOwedCombined,
      summary,
      ledgerCutoff: REIMB_LEDGER_CUTOFF_ACTIVE ? REIMB_LEDGER_FROM : null,
      debtorCount: owes.length,
      owes,
      owesSource,
      owesGeneratedAt,
      owesWarning,
      lastKnownSplitwise,
      people,
      events,
      expected,
      buckets,
      // Surfaced so tagged-but-unmatched repayments are visible instead of
      // silently disappearing into a bucket the UI never renders.
      unattributed: buckets['(unattributed)'] || null,
    };
  });
}

// ---------------------------------------------------------------------------
// Reimbursement LEDGER — the Rocket-Money "zero it out" view. Per person, the
// individual charges you moved to Reimbursement and the paybacks applied to each
// (via the reimb-links store), so every charge reads Outstanding / Partial /
// Settled with a progress-to-zero. Scoped to a month (by the charge/front date),
// plus a trailing 12-month fronted series to drive the month navigator bars.
// This is intentionally ledger-based (what you can act on); the Splitwise
// snapshot in getReimbursement stays the authoritative all-time headline.
// ---------------------------------------------------------------------------
async function getReimbursementLedger({ month } = {}) {
  return withApi(async (api) => {
    const current = currentFinanceYearMonth();
    let year, mIdx;
    if (month) { const [Y, M] = month.split('-').map(Number); year = Y; mIdx = M - 1; }
    else { year = current.year; mIdx = current.monthIndex; }
    const sel = monthRange(year, mIdx);
    const selKey = sel.key;
    const isCurrent = year === current.year && mIdx === current.monthIndex;
    const selEnd = isCurrent ? todayYMD() : sel.end;

    // Trailing 12 months ending at the current month drive the navigator bars.
    const curY = current.year, curM = current.monthIndex;
    const windowStart = monthRange(curY, curM - 11).start;
    const windowEnd = todayYMD();

    const groups = await api.getCategoryGroups();
    let reimbId = null;
    for (const g of groups) for (const c of g.categories || []) if (REIMB_CAT.test(c.name || '')) reimbId = c.id;
    if (!reimbId) throw new Error('Reimbursement category not found');
    const payees = await api.getPayees();
    const pn = {};
    for (const p of payees) pn[p.id] = p.name || '';
    const accts = (await api.getAccounts()).filter((a) => !a.offbudget);

    // All reimbursement charges (fronted, amount<0) over the 12-month window.
    const charges = []; // { id, date, payee, notes, amount(dollars<0), person, event }
    const frontedByMonth = {};
    for (const a of accts) {
      const tx = await api.getTransactions(a.id, windowStart, windowEnd);
      for (const t of tx) {
        const parentPayee = pn[t.payee] || t.imported_payee || '';
        const isSplit = t.subtransactions && t.subtransactions.length;
        const pushCharge = (id, amt, notes, payeeName) => {
          if (!(amt < 0)) return;
          const label = `${payeeName || ''} ${notes || ''}`.replace(/\s+/g, ' ').trim();
          const at = attribute(label, notes || '');
          const mk = (t.date || '').slice(0, 7);
          frontedByMonth[mk] = round2((frontedByMonth[mk] || 0) + -d2(amt));
          charges.push({ id: String(id), date: t.date, payee: payeeName || '(no payee)', notes: notes || '', amount: d2(amt), person: at.person, event: at.event || null, accountId: a.id, account: a.name || '' });
        };
        if (isSplit) { for (const s of t.subtransactions) if (s.category === reimbId) pushCharge(s.id, s.amount, s.notes || t.notes, (s.payee && pn[s.payee]) || parentPayee); }
        else if (t.category === reimbId) pushCharge(t.id, t.amount, t.notes, parentPayee);
      }
    }

    // Payback allocations from the links store (amount-allocated / partial aware).
    const { links } = readReimbLinks();
    const allocByExp = {};
    const paymentsByExp = {};
    for (const l of links) {
      if (!l.expense) continue;
      const eid = l.expense.id;
      const trusted = trustedLinkedCents(l);
      if (trusted <= 0) continue;
      const amt = fromCents(trusted);
      allocByExp[eid] = round2((allocByExp[eid] || 0) + amt);
      if (l.inflow) (paymentsByExp[eid] = paymentsByExp[eid] || []).push({
        id: String(l.inflow.id),
        date: l.inflow.date || null,
        payee: l.inflow.payee || 'Payment',
        amount: amt,
        allocationTrusted: true,
      });
    }

    const chargeStatus = (fronted, allocated, remaining) =>
      allocated <= 0.005 ? 'outstanding' : remaining <= 0.5 ? 'settled' : 'partial';

    // Build the selected month's charges, grouped by person.
    // Hybrid model: trip/Splitwise-governed charges are owned by the authoritative
    // snapshot (netted per person), so exclude them here to avoid double-showing a
    // gross lump. The ledger keeps only direct, per-month reimbursements (for
    // example a roommate's utility half) that Splitwise doesn't track.
    const swGovernedCharge = (c) => !!c.event || /splitwise/i.test(c.notes || '');
    const byPerson = {};
    for (const c of charges) {
      if (c.date < sel.start || c.date > selEnd) continue;
      if (swGovernedCharge(c)) continue;
      const person = c.person && !c.person.startsWith('(') ? c.person : '(unassigned)';
      const fronted = round2(-c.amount);
      const allocated = round2(Math.min(fronted, allocByExp[c.id] || 0));
      const remaining = round2(Math.max(0, fronted - allocated));
      const payments = (paymentsByExp[c.id] || []).slice().sort((a, b) => (a.date < b.date ? -1 : 1));
      const status = chargeStatus(fronted, allocated, remaining);
      const settledDate = status === 'settled' && payments.length ? payments[payments.length - 1].date : null;
      (byPerson[person] = byPerson[person] || []).push({
        id: c.id, date: c.date, payee: c.payee, notes: c.notes, event: c.event,
        accountId: c.accountId, account: c.account,
        fronted, allocated, remaining, status, settledDate, payments,
      });
    }

    const people = Object.keys(byPerson)
      .map((person) => {
        const items = byPerson[person].sort((a, b) => (a.date < b.date ? 1 : -1));
        const fronted = round2(items.reduce((s, i) => s + i.fronted, 0));
        const allocated = round2(items.reduce((s, i) => s + i.allocated, 0));
        const remaining = round2(items.reduce((s, i) => s + i.remaining, 0));
        const status = remaining <= 0.5 ? 'settled' : allocated > 0.005 ? 'partial' : 'outstanding';
        return { person, fronted, allocated, remaining, status, count: items.length, charges: items };
      })
      // Named people first (actionable); the group/trip bucket sinks to the
      // bottom. Within each, most still-owed first.
      .sort((a, b) => {
        const ba = a.person.startsWith('(') ? 1 : 0;
        const bb = b.person.startsWith('(') ? 1 : 0;
        if (ba !== bb) return ba - bb;
        return b.remaining - a.remaining || b.fronted - a.fronted || a.person.localeCompare(b.person);
      });

    const totals = {
      fronted: round2(people.reduce((s, p) => s + p.fronted, 0)),
      allocated: round2(people.reduce((s, p) => s + p.allocated, 0)),
      remaining: round2(people.reduce((s, p) => s + p.remaining, 0)),
      outstanding: round2(people.filter((p) => p.status === 'outstanding').reduce((s, p) => s + p.remaining, 0)),
      partial: round2(people.filter((p) => p.status === 'partial').reduce((s, p) => s + p.remaining, 0)),
      settledCount: people.filter((p) => p.status === 'settled').length,
      peopleCount: people.length,
    };

    const months = [];
    for (let k = 0; k < 12; k++) {
      const mk = monthRange(curY, curM - 11 + k).key;
      months.push({ month: mk, spend: round2(frontedByMonth[mk] || 0) });
    }

    return { month: selKey, range: { start: sel.start, end: selEnd }, totals, people, months };
  });
}

// ---------------------------------------------------------------------------
// Monthly reconciliation — opt-in month-end review. List a month's expenses,
// check each off, then close the month. State persists in reconciliation.json.
// ---------------------------------------------------------------------------
function readRecon() {
  const s = readJsonSafe(RECON_PATH, { enabled: false, months: {} });
  return {
    enabled: !!(s && s.enabled),
    months: s && s.months && typeof s.months === 'object' ? s.months : {},
  };
}
function reconMonthState(store, month) {
  const m = store.months[month];
  return {
    done: !!(m && m.done),
    doneAt: (m && m.doneAt) || null,
    items: m && m.items && typeof m.items === 'object' ? m.items : {},
  };
}
function setReconcileEnabled({ enabled } = {}) {
  const store = readRecon();
  store.enabled = !!enabled;
  writeJsonSafe(RECON_PATH, store);
  return { ok: true, enabled: store.enabled };
}

// A month's reviewable transactions: on-budget expenses + deposits, minus
// internal money movement (transfers / CC payments / investments). Splits are
// listed once as their parent total. Newest first.
async function reconItemsFor(api, month) {
  const [Y, M] = month.split('-').map(Number);
  const { start, end } = monthRange(Y, M - 1);
  const current = currentFinanceYearMonth();
  const isCurrent = Y === current.year && M - 1 === current.monthIndex;
  const to = isCurrent ? todayYMD() : end;
  const groups = await api.getCategoryGroups();
  const catInfo = buildCatInfo(groups);
  const payees = await api.getPayees();
  const pn = {};
  for (const p of payees) pn[p.id] = p.name || '';
  const accts = (await api.getAccounts()).filter((a) => !a.offbudget);
  const rows = [];
  for (const a of accts) {
    const tx = await api.getTransactions(a.id, start, to);
    for (const t of tx) rows.push({ transaction: t, accountId: a.id, account: a });
  }
  const transferIndex = buildTransferIndex(rows);
  const items = [];
  for (const row of rows) {
    const { transaction: t, accountId, account: a } = row;
    const isSplit = t.subtransactions && t.subtransactions.length;
    const classified = classifyTransactionLeaves(t, catInfo, { accountId, transferIndex });
    if (isSplit) {
      const incomplete = classified.filter((lf) => lf.kind === 'incomplete' && lf.provenance === PROVENANCE.TRANSFER_IDENTITY);
      if (incomplete.length) {
        const payee = displayPayeeName(pn[t.payee] || t.imported_payee, t.notes, 'Transaction');
        items.push({
          id: String(t.id),
          date: t.date,
          payee: payee.slice(0, 80),
          amount: d2(t.amount),
          category: 'Transfer (review)',
          account: a.name || '',
          accountId: a.id,
          transferIdentity: true,
          transferReason: incomplete[0].reason || TRANSFER_REASON.IDENTITY_MALFORMED,
          completeness: projectionCompletenessFromLeaves(incomplete),
        });
        continue;
      }
      const reviewable = classified.some((lf) => lf.countsAsSpending || (lf.kind === 'uncat' && lf.amount < 0) || (lf.kind === 'income' && lf.amount > 0));
      if (!reviewable) continue;
    } else {
      const [leaf] = classified;
      if (leaf && leaf.kind === 'incomplete' && leaf.provenance === PROVENANCE.TRANSFER_IDENTITY) {
        const payee = displayPayeeName(pn[t.payee] || t.imported_payee, t.notes, 'Transaction');
        items.push({
          id: String(t.id),
          date: t.date,
          payee: payee.slice(0, 80),
          amount: d2(t.amount),
          category: 'Transfer (review)',
          account: a.name || '',
          accountId: a.id,
          transferIdentity: true,
          transferReason: leaf.reason || TRANSFER_REASON.IDENTITY_MALFORMED,
          completeness: projectionCompletenessFromLeaves([leaf]),
        });
        continue;
      }
      if (!leaf || leaf.spendingExcluded) {
        if (!(leaf && leaf.kind === 'income' && leaf.amount > 0)) continue;
      }
      if (leaf.kind === 'transfer' || leaf.kind === 'incomplete') continue;
      if (leaf.kind === 'mm' || leaf.kind === 'reimb') continue;
    }
    const payee = displayPayeeName(pn[t.payee] || t.imported_payee, t.notes, 'Transaction');
    const info = t.category ? catInfo[t.category] : null;
    const cat = isSplit ? 'Split' : info ? info.name : t.amount > 0 ? 'Deposit' : 'Uncategorized';
    items.push({ id: String(t.id), date: t.date, payee: payee.slice(0, 80), amount: d2(t.amount), category: cat, account: a.name || '', accountId: a.id });
  }
  items.sort((a, b) => (a.date < b.date ? 1 : a.date > b.date ? -1 : 0));
  return items;
}

async function getReconciliation({ month } = {}) {
  return withApi(async (api) => {
    month = month || todayYMD().slice(0, 7);
    const store = readRecon();
    const state = reconMonthState(store, month);
    const rawItems = await reconItemsFor(api, month);
    const items = rawItems.map((it) => ({ ...it, reconciled: !!state.items[it.id] }));
    const reconciledCount = items.filter((it) => it.reconciled).length;
    return {
      enabled: store.enabled,
      month,
      done: state.done,
      doneAt: state.doneAt,
      total: items.length,
      reconciledCount,
      remaining: items.length - reconciledCount,
      items,
    };
  });
}

function setReconcileItem({ month, id, reconciled } = {}) {
  if (!month || !id) throw new Error('month and id required');
  assertTransactionMutationAvailable({ ids: [id] });
  const store = readRecon();
  const m = store.months[month] || (store.months[month] = { done: false, doneAt: null, items: {} });
  if (!m.items || typeof m.items !== 'object') m.items = {};
  if (reconciled) {
    m.items[String(id)] = new Date().toISOString();
  } else {
    delete m.items[String(id)];
    m.done = false; // un-checking an expense reopens a closed month
    m.doneAt = null;
  }
  writeJsonSafe(RECON_PATH, store);
  return { ok: true, month, id: String(id), reconciled: !!reconciled };
}

function setReconcileMonth({ month, done = true } = {}) {
  if (!month) throw new Error('month required');
  const store = readRecon();
  const m = store.months[month] || (store.months[month] = { done: false, doneAt: null, items: {} });
  m.done = !!done;
  m.doneAt = done ? new Date().toISOString() : null;
  writeJsonSafe(RECON_PATH, store);
  return { ok: true, month, done: m.done, doneAt: m.doneAt };
}

// What the app nags about: if enabled, the previous calendar month when it still
// has expenses and hasn't been explicitly closed. Older months stay reachable
// via the reconcile screen's month picker but don't nag.
async function getReconcilePending() {
  return withApi(async (api) => {
    const store = readRecon();
    if (!store.enabled) return { enabled: false, pending: null };
    const current = currentFinanceYearMonth();
    const key = monthRange(current.year, current.monthIndex - 1).key;
    const state = reconMonthState(store, key);
    if (state.done) return { enabled: true, pending: null };
    const items = await reconItemsFor(api, key);
    if (items.length === 0) return { enabled: true, pending: null };
    const reconciledCount = items.filter((it) => state.items[it.id]).length;
    return { enabled: true, pending: key, total: items.length, reconciledCount, remaining: items.length - reconciledCount };
  });
}

// ---------------------------------------------------------------------------
// Insights — largest charges, uncategorized, recurring/subs, MoM anomalies
// ---------------------------------------------------------------------------
async function getInsights({ month } = {}) {
  return withApi(async (api) => {
    const current = currentFinanceYearMonth();
    let year, mIdx;
    if (month) {
      const [Y, M] = month.split('-').map(Number);
      year = Y;
      mIdx = M - 1;
    } else {
      year = current.year;
      mIdx = current.monthIndex;
    }
    const target = monthRange(year, mIdx);
    const windowStart = monthRange(year, mIdx - 5).start; // 6-month window incl. target
    const isCurrent = year === current.year && mIdx === current.monthIndex;
    const targetEnd = isCurrent ? todayYMD() : target.end;

    const groups = await api.getCategoryGroups();
    const catInfo = buildCatInfo(groups);
    const payees = await api.getPayees();
    const pn = {};
    for (const p of payees) pn[p.id] = p.name || '';
    const accounts = (await api.getAccounts()).filter((a) => !a.closed && !a.offbudget);

    const insightRows = [];
    for (const a of accounts) {
      const txns = await api.getTransactions(a.id, windowStart, targetEnd);
      for (const t of txns) insightRows.push({ transaction: t, accountId: a.id });
    }
    const transferIndex = buildTransferIndex(insightRows);
    const payeeNameFor = (t) => pn[t.payee] || t.imported_payee || '';

    // Enriched real-spend leaves over the window {date, payee, month, amount(cents), category}
    const leaves = [];
    for (const row of insightRows) {
      const { transaction: t, accountId } = row;
      const payeeName = payeeNameFor(t);
      for (const lf of classifyTransactionLeaves(t, catInfo, {
        accountId,
        transferIndex,
      })) {
        leaves.push({
          date: t.date,
          month: t.date.slice(0, 7),
          payee: payeeName,
          amount: lf.amount,
          kind: lf.kind,
          category: lf.kind === 'transfer'
            ? 'Transfer'
            : lf.kind === 'incomplete'
              ? 'Transfer (review)'
              : catInfo[lf.catId]
                ? catInfo[lf.catId].name
                : lf.kind === 'mm'
                  ? 'Transfer'
                  : 'Uncategorized',
          id: lf.id,
          account: accounts.find((a) => a.id === accountId)?.name,
          accountId,
          categoryId: lf.catId || null,
          notes: lf.notes || t.notes || '',
          isLeg: !!lf.isLeg,
          parentId: lf.parentId || null,
          cleared: t.cleared,
          needsReview: !!lf.needsReview,
          provenance: lf.provenance,
          transferIdentity: lf.transferIdentity,
        });
      }
    }

    const inMonth = (e) => e.date >= target.start && e.date <= targetEnd;
    const real = (e) => e.kind === 'spend' || (e.kind === 'uncat' && e.amount < 0);

    // Largest charges (target month)
    const largestCharges = leaves
      .filter((e) => inMonth(e) && real(e) && e.amount < 0)
      .sort((a, b) => a.amount - b.amount)
      .slice(0, 8)
      .map((e) => ({
        id: e.id,
        date: e.date,
        payee: e.payee || '(no payee)',
        amount: d2(e.amount),
        category: e.category,
        account: e.account,
        accountId: e.accountId,
        categoryId: e.categoryId,
        notes: e.notes,
        isLeg: e.isLeg,
        parentId: e.parentId,
        cleared: e.cleared,
      }));

    // Top merchants (target month) from REAL spend only — this naturally excludes
    // transfers, investments, credit-card payments and reimbursements, so savings
    // moves / brokerage buys / CC payoffs never masquerade as "merchants".
    const merchMap = new Map();
    for (const e of leaves) {
      if (!inMonth(e) || !real(e) || e.amount >= 0) continue;
      const payee = e.payee || '(no payee)';
      const m = merchMap.get(payee) || { payee, total: 0, count: 0, category: e.category };
      m.total += -e.amount;
      m.count += 1;
      merchMap.set(payee, m);
    }
    const topMerchants = [...merchMap.values()]
      .map((m) => ({ payee: m.payee, total: d2(m.total), count: m.count, category: m.category }))
      .sort((a, b) => b.total - a.total)
      .slice(0, 6);

    // Uncategorized (target month)
    const uncategorized = leaves
      .filter((e) => inMonth(e) && e.kind === 'uncat')
      .sort((a, b) => a.amount - b.amount)
      .map((e) => ({ date: e.date, payee: e.payee || '(no payee)', amount: d2(e.amount) }));

    // Recurring / subscriptions: same payee with negative spend in >= 3 distinct months
    const byPayee = {};
    for (const e of leaves) {
      if (!real(e) || e.amount >= 0 || !e.payee) continue;
      const key = e.payee.toLowerCase();
      const rec = (byPayee[key] = byPayee[key] || { payee: e.payee, months: {}, category: e.category });
      rec.months[e.month] = (rec.months[e.month] || 0) + -e.amount; // positive cents per month
    }
    const recurring = Object.values(byPayee)
      .map((r) => {
        const vals = Object.values(r.months).sort((a, b) => a - b);
        const n = vals.length;
        const median = n % 2 ? vals[(n - 1) / 2] : (vals[n / 2 - 1] + vals[n / 2]) / 2;
        return { payee: r.payee, category: r.category, monthsSeen: n, estimated: d2(median) };
      })
      .filter((r) => r.monthsSeen >= 3)
      .sort((a, b) => b.estimated - a.estimated)
      .slice(0, 12);

    // MoM anomalies: target-month per-category spend vs avg of previous 3 full months
    const prevKeys = [1, 2, 3].map((i) => monthRange(year, mIdx - i).key);
    const curByCat = {};
    const prevByCat = {}; // sum over 3 months
    for (const e of leaves) {
      if (!real(e) || e.amount >= 0) continue;
      const amt = -e.amount;
      if (inMonth(e)) curByCat[e.category] = (curByCat[e.category] || 0) + amt;
      else if (prevKeys.includes(e.month)) prevByCat[e.category] = (prevByCat[e.category] || 0) + amt;
    }
    const anomalies = Object.keys(curByCat)
      .map((cat) => {
        const cur = curByCat[cat];
        const avg = (prevByCat[cat] || 0) / 3;
        return { category: cat, current: d2(cur), avg: d2(avg), deltaPct: avg > 0 ? Math.round(((cur - avg) / avg) * 100) : null };
      })
      .filter((a) => a.avg > 0 && a.current > a.avg * 1.5 && a.current - a.avg > 5000)
      .sort((a, b) => b.current - a.current)
      .slice(0, 6);

    const targetMonthLeaves = leaves.filter((e) => inMonth(e));
    const completeness = projectionCompletenessFromLeaves(
      targetMonthLeaves.filter((e) => e.kind === 'incomplete' && e.provenance === PROVENANCE.TRANSFER_IDENTITY),
    );

    return {
      month: target.key,
      largestCharges,
      topMerchants,
      uncategorized,
      recurring,
      anomalies,
      completeness,
    };
  });
}

// Per-merchant spending history for the "See History" view: a contiguous monthly
// series (zero-filled) of real spend for one payee, each bucket carrying its own
// drill-down items. Matches the same real-spend definition as insights so transfers
// / CC payments / investments never show up.
async function getMerchantHistory({ payee, months = 12 } = {}) {
  return withApi(async (api) => {
    const target = (payee || '').trim().toLowerCase();
    const wantNoPayee = !target || target === '(no payee)';
    const current = currentFinanceYearMonth();
    const year = current.year;
    const mIdx = current.monthIndex;
    const span = Math.max(1, Math.min(60, Number(months) || 12));
    const windowStart = monthRange(year, mIdx - (span - 1)).start;
    const end = todayYMD();

    const groups = await api.getCategoryGroups();
    const catInfo = buildCatInfo(groups);
    const payees = await api.getPayees();
    const pn = {};
    for (const p of payees) pn[p.id] = p.name || '';
    const accounts = (await api.getAccounts()).filter((a) => !a.closed && !a.offbudget);

    const merchantRows = [];
    for (const a of accounts) {
      const txns = await api.getTransactions(a.id, windowStart, end);
      for (const t of txns) merchantRows.push({ transaction: t, accountId: a.id });
    }
    const transferIndex = buildTransferIndex(merchantRows);

    // Zero-filled contiguous month buckets across the window.
    const buckets = new Map();
    const order = [];
    for (let i = span - 1; i >= 0; i--) {
      const k = monthRange(year, mIdx - i).key;
      buckets.set(k, { month: k, total: 0, count: 0, items: [] });
      order.push(k);
    }

    let total = 0;
    let count = 0;
    for (const row of merchantRows) {
      const { transaction: t, accountId } = row;
      const payeeName = pn[t.payee] || t.imported_payee || '';
      const matches = wantNoPayee ? !payeeName : payeeName.trim().toLowerCase() === target;
      if (!matches) continue;
      const account = accounts.find((a) => a.id === accountId);
      for (const lf of classifyTransactionLeaves(t, catInfo, { accountId, transferIndex })) {
        if (!leafCountsAsRealSpend(lf)) continue;
        const key = t.date.slice(0, 7);
        const b = buckets.get(key);
        if (!b) continue;
        const dollars = -lf.amount;
        b.total += dollars;
        b.count += 1;
        b.items.push({
          id: lf.id,
          date: t.date,
          payee: payeeName || '(no payee)',
          amount: d2(lf.amount),
          category: catInfo[lf.catId] ? catInfo[lf.catId].name : 'Uncategorized',
          categoryId: lf.catId || null,
          account: account?.name,
          accountId,
          isLeg: !!lf.isLeg,
          parentId: lf.parentId || null,
          cleared: t.cleared,
          notes: lf.notes || t.notes || '',
        });
        total += dollars;
        count += 1;
      }
    }

    const monthsOut = order.map((k) => {
      const b = buckets.get(k);
      b.items.sort((x, y) => (x.date < y.date ? 1 : -1));
      return { month: b.month, total: d2(b.total), count: b.count, items: b.items };
    });
    const monthsSeen = monthsOut.filter((m) => m.count > 0).length;
    return {
      payee: wantNoPayee ? '(no payee)' : payee,
      count,
      total: d2(total),
      avg: count ? d2(total / count) : 0,
      monthsSeen,
      months: monthsOut,
    };
  });
}

// ---------------------------------------------------------------------------
// Write: safe split-aware category change
// ---------------------------------------------------------------------------
async function setTransactionCategory({ id, categoryId, isLeg, parentId, accountId, date }) {
  assertTransactionMutationAvailable({
    ids: isLeg ? [parentId, id] : [id],
  });
  return withApi(async (api) => {
    if (!isLeg) {
      // Simple, safe path for non-split transactions.
      await api.updateTransaction(id, { category: categoryId || null });
      return { ok: true, mode: 'update' };
    }
    // Split leg: rebuild the parent, preserve every field, then migrate all IDs.
    if (!parentId || !accountId || !date) throw new Error('parentId, accountId and date required for split legs');
    const txns = await api.getTransactions(accountId, date, date);
    const parent = txns.find((t) => t.id === parentId);
    if (!parent || !Array.isArray(parent.subtransactions)) throw new Error('parent split not found');
    const subs = parent.subtransactions.map((s) => ({
      amount: s.amount,
      category: s.id === id ? categoryId || null : s.category || null,
      notes: s.notes || undefined,
      payee: s.payee || undefined,
    }));
    const replacement = addableTransaction(parent, { category: undefined, subtransactions: subs });
    const added = await replaceActualTransaction(api, {
      accountId,
      original: parent,
      replacement,
      requestedLegs: retainedReplacementLegs(parent),
    });
    const { idMap, references } = replacementSagaResult(added);
    return {
      ok: true,
      mode: 'rebuild-split',
      id: idMap[String(id)] || String(added.id),
      parentId: String(added.id),
      previousId: String(id),
      references,
    };
  }, { mode: 'write' });
}

// ---------------------------------------------------------------------------
// Review inbox — one prioritized daily queue for the app home screen.
// ---------------------------------------------------------------------------
function readReviewState() {
  return readRuntimeStateByPath(REVIEW_STATE_PATH).value;
}

function setReviewDisposition({ id, disposition, until, note } = {}) {
  if (!id) throw new Error('review task id required');
  const state = readReviewState();
  if (disposition === 'clear') {
    delete state.dispositions[id];
  } else {
    state.dispositions[id] = {
      disposition,
      at: new Date().toISOString(),
      ...(until ? { until } : {}),
      ...(note ? { note } : {}),
    };
  }
  writeJsonSafe(REVIEW_STATE_PATH, state);
  return { ok: true, id, disposition };
}

async function getReview({ month, classifiedLeaves: preclassifiedLeaves } = {}) {
  // When `classifiedLeaves` is supplied (e.g. from getToday spending), skip a second
  // on-budget leaf fetch/classification pass for the same month window.
  const m = month || todayYMD().slice(0, 7);
  const start = `${m}-01`;
  const [year, monthNum] = m.split('-').map(Number);
  const end = m === todayYMD().slice(0, 7) ? todayYMD() : monthRange(year, monthNum - 1).end;
  const classifiedLeavesPromise = preclassifiedLeaves
    ? Promise.resolve(preclassifiedLeaves)
    : withApi(async (api) => {
      const groups = await api.getCategoryGroups();
      return classifiedOnBudgetLeaves(api, start, end, buildCatInfo(groups));
    });
  const [txns, insights, recurring, repayments, recon, receipts, classifiedLeaves] = await Promise.all([
    getTransactions({ start, end, collapse: true }),
    getInsights({ month: m }),
    getRecurring({}),
    suggestRepayments({}),
    getReconcilePending(),
    Promise.resolve(getReceipts()),
    classifiedLeavesPromise,
  ]);

  const tasks = [];
  const seen = new Set();
  const addTxn = (kind, priority, title, subtitle, txn, action = 'open_transaction') => {
    if (!txn || !txn.id || seen.has(`${kind}:${txn.id}`)) return;
    seen.add(`${kind}:${txn.id}`);
    tasks.push({
      id: `${kind}:${txn.id}`,
      kind,
      priority,
      title,
      subtitle,
      action,
      amount: round2(Math.abs(Number(txn.amount) || 0)),
      date: txn.date || null,
      transaction: {
        id: txn.id,
        parentId: txn.parentId || null,
        isLeg: !!txn.isLeg,
        accountId: txn.accountId || '',
        account: txn.account || '',
        payee: txn.payee || '',
        amount: round2(Number(txn.amount) || 0),
        date: txn.date || '',
        category: txn.category || null,
        categoryId: txn.categoryId || null,
        notes: txn.notes || '',
        cleared: txn.cleared !== false,
        imported: !!txn.imported,
      },
    });
  };

  const incompleteTransferIds = new Set();
  for (const leaf of classifiedLeaves) {
    if (leaf.kind !== 'incomplete' || leaf.provenance !== PROVENANCE.TRANSFER_IDENTITY) continue;
    incompleteTransferIds.add(String(leaf.parentId || leaf.id));
  }
  const txnById = new Map(txns.map((t) => [String(t.id), t]));
  for (const leaf of classifiedLeaves) {
    if (leaf.kind !== 'incomplete' || leaf.provenance !== PROVENANCE.TRANSFER_IDENTITY) continue;
    const txnId = String(leaf.parentId || leaf.id);
    const txn = txnById.get(txnId);
    if (!txn) continue;
    const fingerprint = leaf.reviewFingerprint || incompleteTransferReviewFingerprint(leaf, leaf);
    if (seen.has(fingerprint)) continue;
    seen.add(fingerprint);
    tasks.push({
      id: fingerprint,
      kind: 'transfer_identity',
      priority: 93,
      title: 'Review transfer identity',
      subtitle: leaf.reason || TRANSFER_REASON.IDENTITY_MALFORMED,
      action: 'open_transaction',
      amount: round2(Math.abs(Number(txn.amount) || 0)),
      date: txn.date || null,
      transferReason: leaf.reason || TRANSFER_REASON.IDENTITY_MALFORMED,
      transaction: {
        id: txn.id,
        parentId: txn.parentId || null,
        isLeg: !!txn.isLeg,
        accountId: txn.accountId || '',
        account: txn.account || '',
        payee: txn.payee || '',
        amount: round2(Number(txn.amount) || 0),
        date: txn.date || '',
        category: txn.category || null,
        categoryId: txn.categoryId || null,
        notes: txn.notes || '',
        cleared: txn.cleared !== false,
        imported: !!txn.imported,
      },
    });
  }

  const largeThreshold = Number(process.env.REVIEW_LARGE_CHARGE_THRESHOLD || 200);
  const receiptThreshold = Number(process.env.REVIEW_RECEIPT_THRESHOLD || 75);
  const receiptTxnIds = new Set((receipts.receipts || []).map((r) => String(r.txnId)));
  for (const t of txns) {
    const catName = String(t.category || '');
    const isSplitParent = t.isSplit || t.splitCount || /^split$/i.test(catName);
    const isTransfer = !!t.transfer;
    const hasIncompleteTransfer = incompleteTransferIds.has(String(t.id));
    const reviewableCharge = !isSplitParent && !isTransfer && !hasIncompleteTransfer && !REIMB_CAT.test(catName) && !MM_CAT.test(catName);
    if (!isSplitParent && !isTransfer && !hasIncompleteTransfer && (!t.category || !catName.trim())) addTxn('uncategorized', 95, 'Categorize transaction', t.payee || 'Uncategorized', t, 'categorize');
    if (reviewableCharge && t.amount < 0 && Math.abs(t.amount) >= largeThreshold) addTxn('large_charge', 70, 'Review large charge', t.payee || 'Large charge', t);
    if (reviewableCharge && t.amount < 0 && Math.abs(t.amount) >= receiptThreshold && !receiptTxnIds.has(String(t.id))) addTxn('missing_receipt', 60, 'Attach receipt', t.payee || 'Missing receipt', t, 'open_transaction');
    if (t.cleared === false && !isTransfer && !hasIncompleteTransfer) addTxn('pending', 35, 'Pending transaction', t.payee || 'Pending', t);
  }

  for (const c of insights.uncategorized || []) {
    if (incompleteTransferIds.has(String(c.id))) continue;
    addTxn('uncategorized', 95, 'Categorize transaction', c.payee || 'Uncategorized', c, 'categorize');
  }

  for (const s of repayments.suggestions || []) {
    const inflow = s.inflow || {};
    if (!inflow.id || seen.has(`repayment:${inflow.id}`)) continue;
    seen.add(`repayment:${inflow.id}`);
    tasks.push({
      id: `repayment:${s.id}`,
      kind: 'repayment',
      priority: 90,
      title: 'Confirm repayment',
      subtitle: `${s.person} · ${s.reason}`,
      action: 'open_reimbursement',
      amount: round2(inflow.amount || 0),
      date: inflow.date || null,
      person: s.person,
    });
  }

  for (const item of recurring.items || []) {
    if (item.priceChange && item.status === 'active') {
      tasks.push({
        id: `price:${item.key}`,
        kind: 'price_change',
        priority: item.priceChange.pct > 0 ? 80 : 45,
        title: item.priceChange.pct > 0 ? 'Subscription price increased' : 'Subscription price dropped',
        subtitle: `${item.payee} · ${item.priceChange.pct > 0 ? '+' : ''}${item.priceChange.pct}%`,
        action: 'open_recurring',
        amount: round2(item.amount),
        date: item.lastCharged || null,
        key: item.key,
      });
    }
  }

  if (recon && recon.pending) {
    tasks.push({
      id: `reconcile:${recon.pending}`,
      kind: 'reconciliation',
      priority: 85,
      title: `Reconcile ${recon.pending}`,
      subtitle: recon.remaining > 0 ? `${recon.remaining} of ${recon.total || 0} expenses left` : 'Ready to close',
      action: 'open_reconcile',
      amount: recon.remaining || 0,
      date: null,
      month: recon.pending,
    });
  }

  tasks.sort((a, b) => b.priority - a.priority || String(b.date || '').localeCompare(String(a.date || '')));
  const state = readReviewState();
  const now = Date.now();
  const visibleTasks = tasks.filter((task) => {
    const saved = state.dispositions[task.id];
    if (!saved) return true;
    if (saved.disposition === 'snooze') {
      const until = Date.parse(saved.until || '');
      if (Number.isFinite(until) && until > now) return false;
      delete state.dispositions[task.id];
      return true;
    }
    return !['acknowledge', 'dismiss', 'resolved'].includes(saved.disposition);
  });
  const counts = {};
  for (const t of visibleTasks) counts[t.kind] = (counts[t.kind] || 0) + 1;
  return {
    generatedAt: new Date().toISOString(),
    month: m,
    count: visibleTasks.length,
    hiddenCount: tasks.length - visibleTasks.length,
    counts,
    tasks: visibleTasks.slice(0, 50),
  };
}

// List of categories for the inline categorize dropdown.
async function getCategories() {
  return withApi(async (api) => {
    const groups = await api.getCategoryGroups();
    const out = [];
    for (const g of groups) {
      if (g.is_income) continue;
      for (const c of g.categories || []) out.push({ id: c.id, name: c.name, group: g.name });
    }
    return out;
  });
}

// ---------------------------------------------------------------------------
// Recurring & subscriptions engine (cadence, next renewal, price hikes, status)
// ---------------------------------------------------------------------------
async function getRecurring({ window = 18, debug = false, minDates = 3 } = {}) {
  return withApi(async (api) => {
    const current = currentFinanceYearMonth();
    const startKey = monthRange(current.year, current.monthIndex - (window - 1)).start;
    const today = todayYMD();

    const groups = await api.getCategoryGroups();
    const catInfo = buildCatInfo(groups);
    const payees = await api.getPayees();
    const pn = {};
    for (const p of payees) pn[p.id] = p.name || '';
    const accounts = (await api.getAccounts()).filter((a) => !a.closed && !a.offbudget);

    const recurringRows = [];
    for (const a of accounts) {
      const txns = await api.getTransactions(a.id, startKey, today);
      for (const t of txns) recurringRows.push({ transaction: t, accountId: a.id });
    }
    const transferIndex = buildTransferIndex(recurringRows);

    // Gather negative real-spend leaves grouped by normalized payee.
    const byKey = {};
    for (const row of recurringRows) {
      const { transaction: t, accountId } = row;
      const payeeName = pn[t.payee] || t.imported_payee || '';
      if (!payeeName) continue;
      for (const lf of classifyTransactionLeaves(t, catInfo, { accountId, transferIndex })) {
        if (!leafCountsAsRealSpend(lf)) continue;
        const key = recurringKey(payeeName);
        if (!key) continue;
        const rec = (byKey[key] = byKey[key] || {
          key,
          payee: payeeName,
          category: (catInfo[lf.catId] && catInfo[lf.catId].name) || 'Uncategorized',
          charges: [],
        });
        rec.charges.push({ date: t.date, amt: -lf.amount / 100 });
      }
    }

    const overrides = readJsonSafe(OVERRIDES_PATH, {});
    const items = [];
    const candidates = []; // populated only in debug mode
    for (const rec of Object.values(byKey)) {
      const ov = overrides[rec.key] || null;
      // Collapse same-day charges, then require >= 3 distinct dates (>= 2 when the
      // user force-marked this payee as recurring).
      const perDay = {};
      for (const c of rec.charges) perDay[c.date] = (perDay[c.date] || 0) + c.amt;
      const dates = Object.keys(perDay).sort();
      const minReq = ov && ov.forced ? 2 : (debug ? minDates : 3);
      if (dates.length < minReq) continue;
      const amounts = dates.map((d) => perDay[d]);

      const gaps = [];
      for (let i = 1; i < dates.length; i++) gaps.push(daysBetween(dates[i - 1], dates[i]));
      const medianGap = gaps.length ? median(gaps) : 0;
      const meanGap = gaps.length ? gaps.reduce((s, x) => s + x, 0) / gaps.length : 0;
      const cadence = classifyCadence(medianGap);
      const meanAmt = amounts.reduce((s, x) => s + x, 0) / amounts.length;
      const cv = stddev(amounts) / (meanAmt || 1);

      const cat = rec.category || '';
      const blocked = BLOCK_CAT.test(cat);
      const isBillCat = BILL_CAT.test(cat) && !blocked; // broad: amount-variance tolerance only
      const isBill = BILL_DUE_CAT.test(cat) && !blocked; // strict must-pay bill (drives Bills vs Subscriptions split)
      // Real consumer subscriptions/bills are monthly or longer; weekly/biweekly
      // "cadence" almost always means a frequently-visited merchant (coffee, lunch).
      const cadenceOk = !!cadence && CADENCE_DAYS[cadence] >= 25;
      const period = cadence ? CADENCE_DAYS[cadence] : 0;
      // Guard against bursty merchants whose median happens to look monthly but
      // who are really charged far more often than the cadence implies.
      const freqOk = cadenceOk && meanGap >= period * 0.6;
      // Bills (utilities) may swing a lot; discretionary look-alikes must be tight.
      const varOk = isBillCat ? cv <= 0.85 : cv <= 0.4;

      const reasons = [];
      if (blocked) reasons.push('blocked-category');
      if (!cadence) reasons.push('irregular');
      else if (!cadenceOk) reasons.push(`too-frequent(${cadence})`);
      if (cadenceOk && !freqOk) reasons.push('bursty');
      if (!varOk) reasons.push(`amount-variance(${cv.toFixed(2)})`);
      const ok = !blocked && cadenceOk && freqOk && varOk;

      if (debug) {
        candidates.push({
          key: rec.key, payee: rec.payee, category: cat, occurrences: dates.length,
          medianGap: round2(medianGap), meanGap: round2(meanGap), cadence, cv: round2(cv),
          amount: round2(median(amounts)), isBill, blocked, ok, reasons,
          firstCharged: dates[0], lastCharged: dates[dates.length - 1],
          amounts: amounts.map(round2),
        });
      }
      const forced = !!(ov && ov.forced);
      if (!ok && !forced) continue;

      // Forced items may be irregular; fall back to a monthly cadence so we can
      // still project a renewal + monthly-equivalent.
      const effCadence = cadence || (forced ? 'monthly' : cadence);
      const effPeriod = period || (forced ? CADENCE_DAYS.monthly : period);
      const amount = median(amounts);
      const lastCharged = dates[dates.length - 1];
      const schedule = inferRecurrenceSchedule({ dates, cadence: effCadence, forced });
      const projectionUncertain = !!schedule.uncertain;
      const nextRenewal = projectionUncertain ? null : nextOccurrenceAfter(lastCharged, schedule);
      const monthlyEquivalent = monthlyEquivalentAmount(amount, effCadence);
      const confidence = Math.max(
        35,
        Math.min(
          99,
          Math.round(
            100 - cv * 45 + Math.min(10, dates.length) * 2 + (forced ? -15 : 0) - projectionConfidencePenalty(schedule),
          ),
        ),
      );

      const lastAmt = amounts[amounts.length - 1];
      const prevAmt = amounts[amounts.length - 2];
      let priceChange = null;
      if (prevAmt && Math.abs(lastAmt - prevAmt) / prevAmt > 0.05)
        priceChange = { from: round2(prevAmt), to: round2(lastAmt), pct: Math.round(((lastAmt - prevAmt) / prevAmt) * 100) };

      let status = daysBetween(lastCharged, today) <= inactiveGapDays(effCadence) ? 'active' : 'inactive';
      if (ov && ov.status) status = ov.status; // user override (e.g. cancelled)
      const finalIsBill = ov && typeof ov.isBill === 'boolean' ? ov.isBill : isBill;

      items.push({
        key: rec.key,
        payee: rec.payee,
        category: rec.category,
        cadence: effCadence,
        amount: round2(amount),
        monthlyEquivalent: round2(monthlyEquivalent),
        isBill: finalIsBill, // true bill (utilities/rent/loan/insurance) vs discretionary subscription
        occurrences: dates.length,
        firstCharged: dates[0],
        lastCharged,
        nextRenewal,
        renewalWindow: renewalWindow(nextRenewal),
        projectionUncertain: projectionUncertain || undefined,
        priceChange,
        confidence,
        firstSeen: dates[0],
        lastAmount: round2(lastAmt || amount),
        previousAmount: prevAmt ? round2(prevAmt) : null,
        providerUrl: `https://www.google.com/search?q=${encodeURIComponent(`${rec.payee} cancel subscription`)}`,
        cancellation: (ov && ov.cancellation) || null,
        status,
        hidden: !!(ov && ov.hidden),
        forced: !!(ov && ov.forced), // user manually marked this recurring
        history: dates.map((d) => ({ date: d, amount: round2(perDay[d]) })),
      });
    }

    if (debug) {
      candidates.sort((a, b) => Number(b.ok) - Number(a.ok) || b.amount - a.amount);
      return { candidates, accepted: candidates.filter((c) => c.ok).length, total: candidates.length };
    }

    items.sort((a, b) => b.monthlyEquivalent - a.monthlyEquivalent);
    const visible = items.filter((i) => !i.hidden);
    const hiddenItems = items.filter((i) => i.hidden);
    const active = visible.filter((i) => i.status === 'active');
    const monthlyTotal = round2(active.reduce((s, i) => s + i.monthlyEquivalent, 0));
    // Split totals so the home Subscriptions card and the Upcoming Bills section
    // don't double-count the same items (bills are projected into getBills).
    const subsActive = active.filter((i) => !i.isBill);
    const billsActive = active.filter((i) => i.isBill);
    const subMonthlyTotal = round2(subsActive.reduce((s, i) => s + i.monthlyEquivalent, 0));
    const billMonthlyTotal = round2(billsActive.reduce((s, i) => s + i.monthlyEquivalent, 0));
    return {
      items: visible,
      hiddenItems,
      hiddenCount: hiddenItems.length,
      monthlyTotal,
      annualTotal: round2(monthlyTotal * 12),
      activeCount: active.length,
      count: visible.length,
      subMonthlyTotal,
      subActiveCount: subsActive.length,
      billMonthlyTotal,
      billActiveCount: billsActive.length,
    };
  });
}

function setRecurringOverride({ key, status, hidden, forced, isBill, cancellation } = {}) {
  if (!key) throw new Error('key required');
  const overrides = readJsonSafe(OVERRIDES_PATH, {});
  const cur = overrides[key] || {};
  if (forced !== undefined) {
    if (forced) cur.forced = true;
    else delete cur.forced;
  }
  if (isBill !== undefined) {
    if (isBill === null) delete cur.isBill; // clear to fall back to auto-detected type
    else cur.isBill = !!isBill;
  }
  if (status !== undefined) {
    if (!status || status === 'active') delete cur.status;
    else cur.status = status; // 'cancelled'
  }
  if (hidden !== undefined) {
    if (hidden) cur.hidden = true;
    else delete cur.hidden;
  }
  if (cancellation !== undefined) {
    const prev = cur.cancellation || {};
    const next = { ...prev, ...cancellation };
    for (const k of Object.keys(next)) {
      if (next[k] === null || next[k] === undefined || next[k] === '') delete next[k];
    }
    if (Object.keys(next).length) cur.cancellation = next;
    else delete cur.cancellation;
  }
  if (Object.keys(cur).length) overrides[key] = cur;
  else delete overrides[key];
  writeJsonSafe(OVERRIDES_PATH, overrides);
  return { ok: true, key, override: overrides[key] || null };
}

// ---------------------------------------------------------------------------
// Recurring income — paycheck/deposit streams + next payday projection.
// Mirrors getRecurring but for income-category inflows.
// ---------------------------------------------------------------------------
async function getIncome({ window = 12 } = {}) {
  return withApi(async (api) => {
    const current = currentFinanceYearMonth();
    const startKey = monthRange(current.year, current.monthIndex - (window - 1)).start;
    const today = todayYMD();

    const groups = await api.getCategoryGroups();
    const catInfo = buildCatInfo(groups);
    const payees = await api.getPayees();
    const pn = {};
    for (const p of payees) pn[p.id] = p.name || '';
    const accounts = (await api.getAccounts()).filter((a) => !a.closed && !a.offbudget);

    const incomeRows = [];
    for (const a of accounts) {
      const txns = await api.getTransactions(a.id, startKey, today);
      for (const t of txns) incomeRows.push({ transaction: t, accountId: a.id });
    }
    const transferIndex = buildTransferIndex(incomeRows);

    const byKey = {};
    for (const row of incomeRows) {
      const { transaction: t, accountId } = row;
      const payeeName = pn[t.payee] || t.imported_payee || '';
      if (!payeeName) continue;
      for (const lf of classifyTransactionLeaves(t, catInfo, { accountId, transferIndex })) {
        if (lf.kind === 'transfer' || lf.kind === 'incomplete') continue;
        if (!leafCountsAsRealIncome(lf)) continue;
        const key = incomeKey(payeeName, `${t.notes || ''} ${t.imported_payee || ''}`);
        if (!key) continue;
        const rec = (byKey[key] = byKey[key] || {
          key, payee: key === 'interest' ? 'Interest' : payeeName,
          category: (catInfo[lf.catId] && catInfo[lf.catId].name) || 'Income',
          charges: [], names: [],
        });
        rec.names.push(payeeName);
        rec.charges.push({ date: t.date, amt: lf.amount / 100 });
      }
    }

    const streams = [];
    for (const rec of Object.values(byKey)) {
      const perDay = {};
      for (const c of rec.charges) perDay[c.date] = (perDay[c.date] || 0) + c.amt;
      const dates = Object.keys(perDay).sort();
      if (dates.length < 2) continue; // need >=2 deposits to infer a cadence
      const amounts = dates.map((d) => perDay[d]);
      const gaps = [];
      for (let i = 1; i < dates.length; i++) gaps.push(daysBetween(dates[i - 1], dates[i]));
      const cadence = classifyCadence(median(gaps));
      if (!cadence) continue; // irregular deposits aren't a paycheck
      const amount = median(amounts);
      const lastPaid = dates[dates.length - 1];
      const schedule = inferRecurrenceSchedule({ dates, cadence });
      if (schedule.uncertain) continue;
      const nextPay = rollToOnOrAfter(today, schedule) || nextOccurrenceAfter(lastPaid, schedule);
      if (!nextPay) continue;
      const displayPayee = rec.key === 'interest' ? 'Interest' : bestPayeeLabel(rec.names);
      streams.push({
        key: rec.key, payee: displayPayee, category: rec.category, cadence,
        amount: round2(amount),
        monthlyEquivalent: round2(monthlyEquivalentAmount(amount, cadence)),
        occurrences: dates.length,
        lastPaid, nextPay,
        active: daysBetween(lastPaid, today) <= inactiveGapDays(cadence),
        history: dates.slice(-6).map((d) => ({ date: d, amount: round2(perDay[d]) })),
      });
    }
    streams.sort((a, b) => b.monthlyEquivalent - a.monthlyEquivalent);
    const active = streams.filter((s) => s.active);
    const monthlyTotal = round2(active.reduce((s, x) => s + x.monthlyEquivalent, 0));
    const nextPayday = active.map((s) => s.nextPay).sort()[0] || null;
    const nextStream = nextPayday ? active.find((s) => s.nextPay === nextPayday) : null;
    // `primary` = the dominant paycheck (largest by monthly value). streams is
    // already sorted desc, so active[0] is it. Drives the home headline so it
    // surfaces the real paycheck instead of, say, a tiny interest deposit.
    const primary = active[0] || null;
    return {
      streams,
      activeCount: active.length,
      count: streams.length,
      monthlyTotal,
      annualTotal: round2(monthlyTotal * 12),
      nextPayday,
      nextPaydayAmount: nextStream ? nextStream.amount : null,
      nextPaydayPayee: nextStream ? nextStream.payee : null,
      primaryPayee: primary ? primary.payee : null,
      primaryAmount: primary ? primary.amount : null,
      primaryMonthly: primary ? primary.monthlyEquivalent : null,
      primaryCadence: primary ? primary.cadence : null,
      primaryNextPay: primary ? primary.nextPay : null,
    };
  });
}

// ---------------------------------------------------------------------------
// Upcoming bills — projected from active recurring items (paid-state aware)
// ---------------------------------------------------------------------------
async function getBills({ days = 45, recurring } = {}) {
  const { items } = recurring || await getRecurring({});
  const today = todayYMD();
  const horizon = addDays(today, days);
  const paid = readJsonSafe(BILLS_PAID_PATH, {});
  const bills = [];
  for (const it of items) {
    if (it.status !== 'active') continue;
    if (!it.isBill) continue; // bills view = true bills only; subscriptions live in their own screen
    if (it.projectionUncertain) continue;
    const hist = it.history || [];
    const schedule = inferRecurrenceSchedule({
      dates: hist.map((h) => h.date),
      cadence: it.cadence,
      forced: !!it.forced,
    });
    if (schedule.uncertain) continue;
    const amtTol = Math.max(2, Math.abs(it.amount) * 0.35); // utilities swing; allow ±35% (min $2)
    const dueDates = projectOccurrences({ schedule, windowStart: today, windowEnd: horizon });
    for (const due of dueDates) {
      const id = `${it.key}|${due}`;
      const { lo, hi } = paidMatchWindow(due, schedule);
      const match = hist.find((h) => h.date >= lo && h.date <= hi && Math.abs(Math.abs(h.amount) - Math.abs(it.amount)) <= amtTol);
      const manual = paid[id];
      bills.push({
        id, key: it.key, payee: it.payee, amount: it.amount, dueDate: due,
        category: it.category, cadence: it.cadence,
        paid: !!match || !!manual,
        paidDate: match ? match.date : (manual ? manual.paidDate : null),
        // Present only when linked to a real transaction (vs a manual flag).
        matched: match ? { date: match.date, amount: match.amount } : null,
        variance: match ? round2(Math.abs(match.amount) - Math.abs(it.amount)) : null,
      });
    }
  }
  bills.sort((a, b) => a.dueDate.localeCompare(b.dueDate));
  const unpaid = bills.filter((b) => !b.paid);
  return {
    bills,
    total: round2(unpaid.reduce((s, b) => s + b.amount, 0)),
    count: bills.length,
    unpaidCount: unpaid.length,
    horizonDays: days,
  };
}

// ---------------------------------------------------------------------------
// Forecast — forward cash balance from known inflows/outflows.
// ---------------------------------------------------------------------------
async function getForecast({ days = 90 } = {}) {
  const horizonDays = Math.min(180, Math.max(30, Number(days) || 90));
  const today = todayYMD();
  const horizon = addDays(today, horizonDays);
  const [accounts, income, bills, budgets, reimb] = await Promise.all([
    getAccounts(),
    getIncome({}),
    getBills({ days: horizonDays }),
    getBudgets({}),
    getReimbursement({}),
  ]);
  const liquidAccounts = accountsForMetric(accounts.filter((account) => !account.hidden), 'operating_cash');
  const startBalanceCents = sumOperatingCashBalanceCents(liquidAccounts);
  const eventRows = [];
  const pushEventCents = (date, label, amountCents, kind, provenance, sourceId = null) => {
    if (!date || date < today || date > horizon) return;
    if (!Number.isSafeInteger(amountCents) || amountCents === 0) return;
    eventRows.push({ date, label, amountCents, kind, provenance, sourceId });
  };

  for (const s of income.streams || []) {
    if (!s.active) continue;
    const schedule = inferRecurrenceSchedule({
      dates: [...new Set([...(s.history || []).map((h) => h.date), s.lastPaid].filter(Boolean))].sort(),
      cadence: s.cadence,
    });
    if (schedule.uncertain) continue;
    const payDates = projectOccurrences({
      schedule,
      windowStart: today,
      windowEnd: horizon,
    });
    for (const due of payDates) {
      pushEventCents(
        due,
        s.payee || 'Income',
        forecastIncomeEventCents(s.amount),
        'income',
        'inferred',
        s.key,
      );
    }
  }
  for (const b of bills.bills || []) {
    if (!b.paid) {
      pushEventCents(
        b.dueDate,
        b.payee || 'Bill',
        forecastBillEventCents(b.amount),
        'bill',
        b.matched ? 'known' : 'inferred',
        b.id,
      );
    }
  }

  const genericCategories = (budgets.groups || []).flatMap((group) =>
    (group.categories || [])
      .filter((category) => !BILL_CAT.test(`${group.name || ''} ${category.name || ''}`))
      .map((category) => category)
  );
  const genericBudget = buildForecastGenericBudgetContext(genericCategories);
  const forecastWarnings = [...genericBudget.warnings];
  if (genericBudget.complete) {
    const budgetEntries = buildForecastBudgetDailyCents({
      today,
      horizonDays,
      currentMonthRemainingCents: genericBudget.remainingSum.cents,
      fullMonthTargetCents: genericBudget.targetSum.cents,
      addDays,
      daysInMonth,
    });
    for (const entry of budgetEntries) {
      pushEventCents(entry.date, 'Planned non-bill spending', -entry.centsCents, 'budget', 'planned');
    }
  }
  const possibleReimbursement = reimb.totalOwed > 0.5
    ? { date: addDays(today, 14), amount: round2(reimb.totalOwed), includedInBalance: false }
    : null;

  const events = eventRows
    .map((row) => ({ ...row, amount: fromCents(row.amountCents) }))
    .sort((a, b) => a.date.localeCompare(b.date) || b.amount - a.amount);
  const byDate = new Map();
  for (const e of eventRows) {
    const cur = byDate.get(e.date) || { date: e.date, inflowCents: 0, outflowCents: 0, events: [] };
    if (e.amountCents >= 0) cur.inflowCents = sumCents([cur.inflowCents, e.amountCents]);
    else cur.outflowCents = sumCents([cur.outflowCents, -e.amountCents]);
    cur.events.push(e);
    byDate.set(e.date, cur);
  }
  const points = [];
  let balanceCents = startBalanceCents;
  let lowest = { date: today, balance: fromCents(startBalanceCents) };
  for (let i = 0; i <= horizonDays; i++) {
    const date = addDays(today, i);
    const day = byDate.get(date);
    if (day) balanceCents = sumCents([balanceCents, day.inflowCents, -day.outflowCents]);
    const balance = fromCents(balanceCents);
    const p = {
      date,
      balance,
      inflow: day ? fromCents(day.inflowCents) : 0,
      outflow: day ? fromCents(day.outflowCents) : 0,
    };
    points.push(p);
    if (p.balance < lowest.balance) lowest = { date, balance };
  }
  const totalInflowCents = sumCents(eventRows.filter((e) => e.amountCents > 0).map((e) => e.amountCents));
  const totalOutflowCents = sumCents(eventRows.filter((e) => e.amountCents < 0).map((e) => -e.amountCents));
  return {
    generatedAt: new Date().toISOString(),
    range: { start: today, end: horizon, days: horizonDays },
    startBalance: fromCents(startBalanceCents),
    endingBalance: points[points.length - 1].balance,
    lowest,
    totals: {
      inflow: fromCents(totalInflowCents),
      outflow: fromCents(totalOutflowCents),
    },
    points,
    events: events.slice(0, 200),
    assumptions: {
      liquidAccounts: liquidAccounts.map((account) => ({ id: account.id, name: account.name })),
      genericBudgetTarget: genericBudget.assumptions.genericBudgetTarget,
      genericBudget: {
        target: genericBudget.assumptions.target,
        remaining: genericBudget.assumptions.remaining,
        complete: genericBudget.assumptions.complete,
        incompleteReasons: genericBudget.assumptions.incompleteReasons,
      },
      billsExcludedFromGenericBudget: true,
      reimbursementsIncluded: false,
    },
    possibleReimbursement,
    warnings: [
      ...(lowest.balance < 0 ? [`Projected cash drops below $0 on ${lowest.date}`] : []),
      ...(possibleReimbursement ? ['Possible reimbursements are shown separately and are not counted as guaranteed cash.'] : []),
      ...forecastWarnings,
    ],
  };
}

async function getToday() {
  const financeDate = todayYMD();
  const month = financeDate.slice(0, 7);
  const monthEndDate = monthRange(Number(month.slice(0, 4)), Number(month.slice(5, 7)) - 1).end;
  const asOf = new Date().toISOString();
  const spendingBundle = await withApi(async (api) => {
    const financeToday = todayYMD();
    const [financeYear, financeMonth] = financeToday.slice(0, 7).split('-').map(Number);
    const cur = monthRange(financeYear, financeMonth - 1);
    const prev = monthRange(financeYear, financeMonth - 2);
    const curEnd = financeToday;
    const groups = await api.getCategoryGroups();
    const catInfo = buildCatInfo(groups);
    const [currentLeaves, previousLeaves] = await classifiedOnBudgetLeavesForWindows(api, [
      { start: cur.start, end: curEnd },
      { start: prev.start, end: prev.end },
    ], catInfo);
    const current = summarize(currentLeaves);
    const previous = summarize(previousLeaves);
    return {
      spending: {
        current,
        prev: previous,
        month,
        completeness: mergeProjectionCompleteness([current.completeness, previous.completeness]),
      },
      classifiedLeaves: currentLeaves,
    };
  });
  const spending = spendingBundle.spending;
  const [accounts, budgets, recurring, goals, income, review, recent] = await Promise.all([
    getAccounts(),
    getBudgets({ month }),
    getRecurring({}),
    getGoals(),
    getIncome({}),
    getReview({ month, classifiedLeaves: spendingBundle.classifiedLeaves }),
    getTransactions({ start: addDays(financeDate, -14), end: financeDate, collapse: true }),
  ]);
  const bills = await getBills({ days: 45, recurring });

  const visibleAccounts = accounts.filter((account) => !account.hidden);
  const operatingAccounts = accountsForMetric(visibleAccounts, 'operating_cash');
  const cashCents = Math.round(operatingAccounts.reduce((sum, account) => sum + account.balance, 0) * 100);
  const billCents = Math.round((bills.bills || [])
    .filter((bill) => !bill.paid && bill.dueDate >= financeDate && bill.dueDate <= monthEndDate)
    .reduce((sum, bill) => sum + bill.amount, 0) * 100);
  const budgetCents = Math.round((budgets.groups || []).reduce(
    (total, group) => total + (group.categories || [])
      .filter((category) => !BILL_CAT.test(`${group.name || ''} ${category.name || ''}`))
      .reduce((sum, category) => sum + Math.max(0, Number(category.remaining) || 0), 0),
    0
  ) * 100);
  const safeCents = cashCents - billCents - budgetCents;
  const incompleteReasons = safeToSpendIncompleteReasons({
    accounts,
    visibleAccounts,
    operatingAccounts,
    budgets,
    recurring,
    goals,
    spendingCompleteness: spending.current?.completeness,
  });
  const safeToSpend = metricValue({
    metric: 'safe_to_spend',
    value: fromCents(safeCents),
    valueCents: safeCents,
    complete: incompleteReasons.length === 0,
    asOf,
    financeDate,
    sources: operatingAccounts.map((account) => ({ type: 'actual-account', id: account.id, role: account.role })),
    method: 'operating cash minus unpaid bills due this month minus remaining non-bill budget',
    excludes: ['protected savings', 'investments', 'credit availability', 'possible reimbursements', 'unfunded goals'],
    incompleteReasons,
  });
  const revision = crypto.createHash('sha256')
    .update(`${apiHealth.lastSyncAt || apiHealth.initializedAt || ''}\0${financeDate}`)
    .digest('hex')
    .slice(0, 16);

  return {
    asOf,
    financeDate,
    revision,
    complete: safeToSpend.complete && spending.current?.completeness?.complete !== false,
    incompleteReasons: [...new Set([...safeToSpend.incompleteReasons, ...(spending.current?.completeness?.complete === false ? spending.current.completeness.incompleteReasons : [])])],
    health: getHealth(),
    accounts,
    spending,
    liquidity: { safeToSpend },
    obligations: {
      bills: (bills.bills || []).filter((bill) => !bill.paid).slice(0, 5),
      nextIncome: (income.streams || []).filter((stream) => stream.active).sort((a, b) => String(a.nextPay).localeCompare(String(b.nextPay)))[0] || null,
      source: 'inferred',
    },
    review,
    activity: { recent: recent.slice(0, 8) },
  };
}

// Toggle a bill occurrence's paid state. Identified by `${recurringKey}|${dueDate}`.
function setBillPaid({ id, key, dueDate, paid } = {}) {
  const billId = id || (key && dueDate ? `${key}|${dueDate}` : null);
  if (!billId) throw new Error('id (or key + dueDate) required');
  const store = readJsonSafe(BILLS_PAID_PATH, {});
  if (paid === false) delete store[billId];
  else store[billId] = { paidDate: todayYMD() };
  writeJsonSafe(BILLS_PAID_PATH, store);
  return { ok: true, id: billId, paid: paid !== false };
}

// Resolve a free-text payee name to an id (find-or-create). Empty => null.
async function resolvePayeeId(api, name) {
  const n = (name || '').trim();
  if (!n) return null;
  const payees = await api.getPayees();
  const found = payees.find((p) => (p.name || '').toLowerCase() === n.toLowerCase());
  return found ? found.id : await api.createPayee({ name: n });
}

let transactionSagaManager = null;
let transactionDeletionSagaManager = null;
let repaymentConfirmationSagaManager = null;
let reimbursementLinkSagaManager = null;
let bulkOperationSagaManager = null;
const replacementSagaResults = new WeakMap();

function reimbLinkBlocksTransactionRecovery(saga) {
  const blocked = getReimbursementLinkSagaManager().activeOwnedIds();
  if (!blocked.size) return false;
  const owned = new Set([
    saga.original?.id,
    saga.replacementId,
    saga.replacementIds?.parentId,
    saga.restoredIds?.parentId,
    ...(saga.original?.subtransactions || []).map((leg) => leg.id),
    ...(saga.replacementIds?.legIds || []),
    ...(saga.restoredIds?.legIds || []),
  ].filter(Boolean).map(String));
  return [...owned].some((id) => blocked.has(id));
}

function getTransactionSagaManager() {
  if (!transactionSagaManager) {
    transactionSagaManager = createTransactionReplacementSaga({
      sagaPath: TRANSACTION_SAGAS_PATH,
      preflightReferences: readTransactionReferenceStores,
      planReferences: planTransactionReferenceMigration,
      applyReferenceStep: applyTransactionReferenceStep,
      referencesConverged: transactionReferencesConverged,
      referenceSteps: TRANSACTION_REFERENCE_STEPS,
      recoveryOwnershipGuard: reimbLinkBlocksTransactionRecovery,
      assertExternalAvailable: ({ accountId, original }) => {
        getTransactionDeletionSagaManager().assertAvailable({ accountId, transaction: original });
        getRepaymentConfirmationSagaManager().assertAvailable({
          accountId,
          ids: original ? [original.id, ...(original.subtransactions || []).map((leg) => leg.id)] : [],
        });
        getBulkOperationSagaManager().assertAvailable({
          accountId,
          ids: original ? [original.id, ...(original.subtransactions || []).map((leg) => leg.id)] : [],
        });
        getReimbursementLinkSagaManager().assertAvailable({
          accountId,
          ids: original ? [original.id, ...(original.subtransactions || []).map((leg) => leg.id)] : [],
        });
      },
    });
  }
  return transactionSagaManager;
}

function getTransactionDeletionSagaManager() {
  if (!transactionDeletionSagaManager) {
    transactionDeletionSagaManager = createTransactionDeletionSaga({
      sagaPath: TRANSACTION_DELETION_SAGAS_PATH,
      planReferences: planTransactionReferenceDeletion,
      applyReferenceStep: applyTransactionDeletionReferenceStep,
      referencesConverged: transactionDeletionReferencesConverged,
      referenceSteps: TRANSACTION_DELETION_REFERENCE_STEPS,
      receiptFileState: transactionDeletionReceiptFileState,
      unlinkReceiptFile: unlinkTransactionDeletionReceiptFile,
      assertExternalAvailable: ({ accountId, original, bulkDelegation }) => {
        getTransactionSagaManager().assertAvailable({ accountId, original });
        getRepaymentConfirmationSagaManager().assertAvailable({
          accountId,
          ids: original ? [original.id, ...(original.subtransactions || []).map((leg) => leg.id)] : [],
        });
        getBulkOperationSagaManager().assertAvailable({
          accountId,
          ids: original ? [original.id, ...(original.subtransactions || []).map((leg) => leg.id)] : [],
          allowDeletionDelegation: bulkDelegation,
        });
        getReimbursementLinkSagaManager().assertAvailable({
          accountId,
          ids: original ? [original.id, ...(original.subtransactions || []).map((leg) => leg.id)] : [],
        });
      },
    });
  }
  return transactionDeletionSagaManager;
}

function getRepaymentConfirmationSagaManager() {
  if (!repaymentConfirmationSagaManager) {
    repaymentConfirmationSagaManager = createRepaymentConfirmationSaga({
      sagaPath: REPAYMENT_CONFIRMATION_SAGAS_PATH,
      readLinks: readReimbLinks,
      writeLinks: writeReimbLinks,
      readSuggestions: readReimbSuggest,
      writeSuggestions: writeReimbSuggest,
      assertExternalAvailable: ({ accountId, ids }) => {
        getTransactionSagaManager().assertAvailable({ accountId, ids });
        getTransactionDeletionSagaManager().assertAvailable({ accountId, ids });
        getBulkOperationSagaManager().assertAvailable({ accountId, ids });
        getReimbursementLinkSagaManager().assertAvailable({ accountId, ids });
      },
    });
  }
  return repaymentConfirmationSagaManager;
}

function getReimbursementLinkSagaManager() {
  if (!reimbursementLinkSagaManager) {
    reimbursementLinkSagaManager = createReimbursementLinkSaga({
      sagaPath: REIMBURSEMENT_LINK_SAGAS_PATH,
      readLinks: readReimbLinks,
      writeLinks: writeReimbLinks,
      revalidateLinkApply,
      revalidateUnlinkApply,
      resolveReimbCategoryId: async (actualApi) => {
        const groups = await actualApi.getCategoryGroups();
        return reimbCategoryId(groups);
      },
      resolvePayeeNames: async (actualApi) => {
        const payees = await actualApi.getPayees();
        return Object.fromEntries(payees.map((p) => [p.id, p.name || '']));
      },
      assertExternalAvailable: ({ accountId, ids }) => {
        getTransactionSagaManager().assertAvailable({ accountId, ids });
        getTransactionDeletionSagaManager().assertAvailable({ accountId, ids });
        getRepaymentConfirmationSagaManager().assertAvailable({ accountId, ids });
        getBulkOperationSagaManager().assertAvailable({ accountId, ids });
      },
    });
  }
  return reimbursementLinkSagaManager;
}

function readSplitwiseMirrorResolutions() {
  const raw = readJsonSafe(SPLITWISE_MIRROR_RESOLUTIONS_PATH, null);
  return loadSplitwiseMirrorResolutions(raw);
}

function getBulkOperationSagaManager() {
  if (!bulkOperationSagaManager) {
    bulkOperationSagaManager = createBulkOperationSaga({
      sagaPath: BULK_OPERATION_SAGAS_PATH,
      readRules: () => {
        const store = readJsonSafe(RULES_PATH, { rules: [] });
        return { ...store, rules: Array.isArray(store.rules) ? store.rules : [] };
      },
      writeRules: (patch) => {
        const current = readJsonSafe(RULES_PATH, { rules: [] });
        writeJsonSafe(RULES_PATH, { ...current, ...patch });
      },
      readPhantomSeen,
      writePhantomSeen: (store) => writeJsonSafe(PHANTOM_SEEN_PATH, store),
      readPhantomLog,
      writePhantomLog: (store) => writeJsonSafe(PHANTOM_LOG_PATH, store),
      readSplitwiseMirrorResolutions,
      readSplitwiseTruth: () => readJsonSafe(OWES_TRUTH_PATH, null),
      validateSplitwiseMirrorSnapshot,
      ensureSplitwiseAccount,
      ensureSplitwiseCategory,
      pickSplitwiseCategory,
      swAccountName: SW_ACCOUNT_NAME,
      swCategoryName: SW_CATEGORY_NAME,
      deleteTransaction,
      inspectDeletionState: () => getTransactionDeletionSagaManager().inspectState(),
      recoverDeletionSagas: recoverTransactionDeletionSagas,
      merchantCatalog: MERCHANT_CATALOG,
      catalogTypeMatch: CATALOG_TYPE_MATCH,
      resolveCatalogCategory,
      buildCatInfo,
      settleUpPayee: SETTLE_UP_PAYEE,
      reimbCat: REIMB_CAT,
      incomeGroup: INCOME_GROUP,
      moneyMovementGroup: MONEY_MOVEMENT_GROUP,
      todayYMD,
      addDays,
      assertExternalAvailable: ({ accountId, ids, bulkDelegation }) => {
        getTransactionSagaManager().assertAvailable({ accountId, ids });
        if (!bulkDelegation) {
          getTransactionDeletionSagaManager().assertAvailable({ accountId, ids });
        }
        getRepaymentConfirmationSagaManager().assertAvailable({ accountId, ids });
        getReimbursementLinkSagaManager().assertAvailable({ accountId, ids });
      },
    });
  }
  return bulkOperationSagaManager;
}

async function recoverBulkOperationSagas(actualApi, options) {
  return getBulkOperationSagaManager().recover(actualApi, options);
}

function getBulkOperationResult(operationKey) {
  if (!operationKey) return null;
  return getBulkOperationSagaManager().resultForOperationKey(operationKey);
}

function proveBulkOperationJournalCompletion(operationKey, journalOperation) {
  if (!operationKey || !journalOperation) return null;
  return getBulkOperationSagaManager().proveTerminalJournalCompletion(operationKey, journalOperation);
}

function assertBulkOperationJournalAdmission({ operationKey, journalBinding, kind }) {
  if (!operationKey || !journalBinding?.fingerprint) return;
  getBulkOperationSagaManager().assertJournalAdmission({ operationKey, journalBinding, kind });
}

async function recoverTransactionSagas(actualApi, options) {
  return getTransactionSagaManager().recover(actualApi, options);
}

async function recoverTransactionDeletionSagas(actualApi, options) {
  return getTransactionDeletionSagaManager().recover(actualApi, options);
}

async function recoverRepaymentConfirmationSagas(actualApi, options) {
  return getRepaymentConfirmationSagaManager().recover(actualApi, options);
}

async function recoverReimbursementLinkSagas(actualApi, options) {
  return getReimbursementLinkSagaManager().recover(actualApi, options);
}

async function markTransactionSagasSynced(actualApi) {
  let firstError = null;
  for (const manager of [
    getTransactionSagaManager(),
    getTransactionDeletionSagaManager(),
    getRepaymentConfirmationSagaManager(),
    getReimbursementLinkSagaManager(),
    getBulkOperationSagaManager(),
  ]) {
    try {
      await manager.markSynced(actualApi);
    } catch (error) {
      firstError ||= error;
    }
  }
  if (firstError) throw firstError;
}

async function driveTransactionSagasForSync(actualApi) {
  const recovery = await driveOperationalSagaRecovery(actualApi, { deferSync: true });
  return {
    needsSync: recovery.needsSync,
    errors: recovery.errors.map((entry) => ({ sagaId: entry.sagaId, error: new Error(entry.message), store: entry.store })),
  };
}

async function syncTransactionSagas(actualApi) {
  const recovery = await driveTransactionSagasForSync(actualApi);
  await actualApi.sync();

  let terminalError = null;
  try {
    await markTransactionSagasSynced(actualApi);
  } catch (error) {
    terminalError = error;
  }
  if (terminalError) throw terminalError;
  if (recovery.errors.length) throw recovery.errors[0].error;
  return recovery;
}

function assertTransactionMutationAvailable({ accountId, ids, transaction, bulkDelegation } = {}) {
  getTransactionSagaManager().assertAvailable({ accountId, ids, original: transaction });
  getTransactionDeletionSagaManager().assertAvailable({ accountId, ids, transaction });
  getRepaymentConfirmationSagaManager().assertAvailable({ accountId, ids });
  getReimbursementLinkSagaManager().assertAvailable({ accountId, ids });
  getBulkOperationSagaManager().assertAvailable({
    accountId,
    ids,
    allowDeletionDelegation: bulkDelegation,
  });
}

function assertTransactionReplacementAvailable(options) {
  assertTransactionMutationAvailable(options);
}

function assertTransactionDeletionAvailable(options) {
  assertTransactionMutationAvailable(options);
}

async function assertTransactionImportedIdentityAvailable(api, { accountId, original }) {
  await getTransactionSagaManager().assertImportedIdentityAvailable(api, { accountId, original });
}

function retainedReplacementLegs(transaction) {
  return (transaction?.subtransactions || []).map((leg) => ({ id: String(leg.id) }));
}

async function replaceActualTransaction(api, args) {
  const result = await getTransactionSagaManager().replace(api, args);
  if (result.transaction && typeof result.transaction === 'object') {
    replacementSagaResults.set(result.transaction, result);
  }
  return result.transaction;
}

function replacementSagaResult(transaction) {
  const result = replacementSagaResults.get(transaction);
  if (!result) throw new Error('replacement saga result is unavailable');
  return result;
}

// Fetch one transaction (parent or simple) with its legs. Account id is preferred,
// but older reimbursement-link snapshots may only have id + date, so scan that
// single day across accounts as a safe compatibility fallback.
async function getTransactionById({ id, accountId, date } = {}) {
  if (!id || !date) throw new Error('id and date required');
  return withApi(async (api) => {
    const [cats, payees, accts] = await Promise.all([
      api.getCategories(),
      api.getPayees(),
      api.getAccounts(),
    ]);
    const candidates = accountId
      ? accts.filter((account) => account.id === accountId)
      : accts.filter((account) => !account.closed);
    if (!candidates.length) {
      if (accountId) throw new AccountNotFoundError();
      throw new Error('account not found');
    }
    const transactionSets = await Promise.all(candidates.map(async (account) => ({
      account,
      transactions: await api.getTransactions(account.id, date, date),
    })));
    let account = null;
    let txns = [];
    for (const candidate of transactionSets) {
      if (candidate.transactions.some((transaction) =>
        String(transaction.id) === String(id) ||
        String(transaction.parent_id || '') === String(id) ||
        (transaction.subtransactions || []).some((leg) => String(leg.id) === String(id))
      )) {
        account = candidate.account;
        txns = candidate.transactions;
        break;
      }
    }
    if (!account) throw new TransactionNotFoundError();
    const catMap = Object.fromEntries(cats.map((c) => [c.id, c.name]));
    const pn = Object.fromEntries(payees.map((p) => [p.id, p.name]));
    const acctName = account.name || account.id;
    let requested = txns.find((transaction) => String(transaction.id) === String(id));
    let parent = requested;
    let requestedLeg = null;
    if (!requested) {
      parent = txns.find((transaction) =>
        (transaction.subtransactions || []).some((leg) => String(leg.id) === String(id))
      );
      requestedLeg = parent?.subtransactions?.find((leg) => String(leg.id) === String(id)) || null;
    } else if (requested.parent_id) {
      parent = txns.find((transaction) => transaction.id === requested.parent_id) || requested;
      requestedLeg = requested;
    }
    if (!parent) throw new TransactionNotFoundError();
    const subs = Array.isArray(parent.subtransactions) ? parent.subtransactions : [];
    const display = requestedLeg || parent;
    return {
      id: display.id,
      parentId: requestedLeg ? parent.id : null,
      isLeg: !!requestedLeg,
      accountId: account.id,
      account: acctName,
      date: parent.date,
      payee: pn[display.payee] || pn[parent.payee] || parent.imported_payee || '',
      amount: display.amount / 100,
      category: catMap[display.category] || null,
      categoryId: display.category || null,
      notes: display.notes || '',
      cleared: parent.cleared,
      imported: !!parent.imported_id,
      isSplit: !requestedLeg && !!(parent.is_parent && subs.length),
      legs: requestedLeg ? [] : subs.map((s) => ({
        id: s.id,
        amount: s.amount / 100,
        categoryId: s.category || null,
        category: catMap[s.category] || null,
        name: (s.payee && pn[s.payee]) || '',
        notes: s.notes || '',
      })),
    };
  });
}

// Create OR edit a split. Actual split subtransactions are never edited directly:
// the canonical safe path is delete-parent + re-add while preserving imported_id
// and every parent/leg field. The replacement receives new IDs, so all sidecar
// references are migrated before the operation reports success.
async function splitTransaction({ id, accountId, date, legs } = {}) {
  if (!accountId || !date) throw new Error('accountId and date required');
  if (!Array.isArray(legs) || legs.length < 2) throw new Error('at least 2 legs required');
  const norm = legs.map((l) => {
    const cents = toCents(l.amount);
    if (cents === 0) throw new Error('each leg needs a non-zero amount');
    return { id: l.id || null, cents, categoryId: l.categoryId || null, name: (l.name || '').trim(), notes: (l.notes || '').trim() };
  });
  assertTransactionMutationAvailable({ ids: [id, ...norm.map((leg) => leg.id)] });
  return withApi(async (api) => {
    const txns = await api.getTransactions(accountId, date, date);
    const target = txns.find((t) => t.id === id);
    if (!target) throw new Error('transaction not found');
    if (target.parent_id) throw new Error('edit the whole split, not a single leg');
    assertReconstructableTransaction(target);
    await assertTransactionImportedIdentityAvailable(api, { accountId, original: target });
    const total = target.amount; // integer cents (sign preserved)

    const sum = norm.reduce((s, x) => s + x.cents, 0);
    if (sum !== total) throw new Error(`legs must sum to ${(total / 100).toFixed(2)} (got ${(sum / 100).toFixed(2)})`);
    for (const l of norm) l.payeeId = l.name ? await resolvePayeeId(api, l.name) : null;
    const replacement = addableTransaction(target, {
      category: undefined,
      subtransactions: norm.map((leg) => ({
        amount: leg.cents,
        category: leg.categoryId || null,
        notes: leg.notes || undefined,
        payee: leg.payeeId || undefined,
      })),
    });
    const added = await replaceActualTransaction(api, { accountId, original: target, replacement, requestedLegs: target.is_parent ? norm : undefined });
    const { references } = replacementSagaResult(added);
    return {
      ok: true,
      mode: target.is_parent ? 'edit' : 'create',
      id: String(added.id),
      previousId: String(target.id),
      legs: (added.subtransactions || []).length,
      legIds: (added.subtransactions || []).map((leg) => String(leg.id)),
      references,
    };
  }, { mode: 'write' });
}

// A pending split can post at a different amount. Discovery is read-only by
// default: silently absorbing the delta into one leg destroys allocation intent.
async function reconcileSplitDeltas(api, { months = 3, apply = false } = {}) {
  const today = todayYMD();
  const start = addDays(today, -Math.round(30.44 * months));
  const accounts = (await api.getAccounts()).filter((a) => !a.closed);
  let fixed = 0;
  const failures = [];
  const pending = [];
  for (const a of accounts) {
    const txns = await api.getTransactions(a.id, start, today);
    for (const t of txns) {
      if (!t.is_parent || !Array.isArray(t.subtransactions) || t.subtransactions.length < 2) continue;
      const subSum = t.subtransactions.reduce((s, x) => s + (x.amount || 0), 0);
      const delta = t.amount - subSum; // integer cents the master must absorb
      if (delta === 0) continue;
      const master = t.subtransactions[0];
      const newMaster = (master.amount || 0) + delta;
      pending.push({
        id: String(t.id),
        accountId: String(a.id),
        date: t.date,
        delta: fromCents(delta),
        currentTotal: fromCents(t.amount),
        proposedFirstLeg: fromCents(newMaster),
      });
      if (!apply) continue;
      // A 0-amount leg is invalid in Actual, and flipping the master's sign would
      // mean the posted total no longer resembles the original split — skip & log.
      if (newMaster === 0 || Math.sign(newMaster) !== Math.sign(t.amount)) {
        console.error(`[split-delta] ${t.id} needs manual re-split (Δ ${(delta / 100).toFixed(2)})`);
        continue;
      }
      const subs = t.subtransactions.map((s, i) => ({
        amount: i === 0 ? newMaster : s.amount,
        category: s.category || null,
        notes: s.notes || undefined,
        payee: s.payee || undefined,
      }));
      try {
        assertTransactionMutationAvailable({
          accountId: a.id,
          ids: [t.id, ...t.subtransactions.map((leg) => leg.id)],
        });
        const replacement = addableTransaction(t, { category: undefined, subtransactions: subs });
        await replaceActualTransaction(api, {
          accountId: a.id,
          original: t,
          replacement,
          requestedLegs: retainedReplacementLegs(t),
        });
        fixed++;
      } catch (e) {
        console.error(`[split-delta] ${t.id} update failed: ${e.message}`);
        failures.push({ id: String(t.id), error: e.message });
      }
    }
  }
  return { fixed, failures, pending };
}
// Self-contained wrapper for refresh (preview) and explicit confirmation (apply).
async function reconcileSplits({ apply = false } = {}) {
  const result = await withApi((api) => reconcileSplitDeltas(api, { apply }), { mode: apply ? 'write' : 'read' });
  if (result.fixed) await syncNow();
  if (result.failures.length) {
    throw new Error(`failed to reconcile ${result.failures.length} split transaction(s)`);
  }
  return { ok: true, fixed: result.fixed, pending: result.pending };
}

// Auto-file expenses that someone else actually pays (tagged #<person>) into
// the Reimbursement category, so they drop out of
// personal spending and surface as "owed" in Who-Owes-Me. Idempotent — safe to run
// on every sync. Only negative (real expense) spend/uncat leaves carrying a target
// tag are touched; already-reimbursed / income / transfer leaves are left alone.
async function sweepReimbursementTags({ tags, from, to } = {}) {
  return withApi(async (api) => {
    const cfg = loadOwesConfig();
    const targetTags = (tags && tags.length ? tags : cfg.autoReimbTags || []).map((s) => String(s).toLowerCase());
    const tagSet = new Set(targetTags);
    if (!tagSet.size) return { ok: true, moved: 0, tags: [], items: [] };

    const groups = await api.getCategoryGroups();
    const catInfo = buildCatInfo(groups);
    let reimbId = null;
    for (const g of groups) for (const c of g.categories || []) if (REIMB_CAT.test(c.name || '')) reimbId = c.id;
    if (!reimbId) throw new Error('Reimbursement category not found');

    const start = from || `${todayYMD().slice(0, 4)}-01-01`;
    const end = to || todayYMD();
    const accts = (await api.getAccounts()).filter((a) => !a.closed && !a.offbudget);

    const hasTargetTag = (note) =>
      (String(note || '').match(/#[a-z0-9_-]+/gi) || []).some((s) => tagSet.has(s.slice(1).toLowerCase()));
    const isSpendKind = (catId) => {
      const k = catInfo[catId] ? catInfo[catId].kind : 'uncat';
      return k === 'spend' || k === 'uncat';
    };

    const moved = [];
    for (const a of accts) {
      const txns = await api.getTransactions(a.id, start, end);
      for (const t of txns) {
        const isSplit = t.is_parent && Array.isArray(t.subtransactions) && t.subtransactions.length;
        if (isSplit) {
          let changed = false;
          const subs = t.subtransactions.map((s) => {
            const hit = s.amount < 0 && isSpendKind(s.category) && hasTargetTag(s.notes || t.notes);
            if (hit) { changed = true; moved.push({ id: s.id, amount: d2(s.amount), leg: true }); }
            return {
              amount: s.amount,
              category: hit ? reimbId : s.category || null,
              notes: s.notes || undefined,
              payee: s.payee || undefined,
            };
          });
          if (changed) {
            assertTransactionMutationAvailable({
              accountId: a.id,
              ids: [t.id, ...t.subtransactions.map((leg) => leg.id)],
            });
            const replacement = addableTransaction(t, { category: undefined, subtransactions: subs });
            await replaceActualTransaction(api, {
              accountId: a.id,
              original: t,
              replacement,
              requestedLegs: retainedReplacementLegs(t),
            });
          }
        } else if (!t.is_parent) {
          if (t.amount < 0 && isSpendKind(t.category) && hasTargetTag(t.notes)) {
            assertTransactionMutationAvailable({ accountId: a.id, ids: [t.id] });
            await api.updateTransaction(t.id, { category: reimbId });
            moved.push({ id: t.id, amount: d2(t.amount), leg: false });
          }
        }
      }
    }
    return { ok: true, moved: moved.length, tags: targetTags, items: moved };
  }, { mode: 'write' });
}

// ---------------------------------------------------------------------------
// Phantom pending cleanup — remove pending bank-imported charges that fell off
// the card (dropped auth holds, or holds that posted as a separate cleared row).
// Deliberately conservative; see the rules below. Never touches manual rows,
// cleared rows, splits, or anything marked #keep. Notes normally protect a row,
// except notes that explicitly identify it as an auth hold expected to drop off.
// ---------------------------------------------------------------------------
function readPhantomSeen() {
  const s = readJsonSafe(PHANTOM_SEEN_PATH, { seen: {} });
  return s && s.seen && typeof s.seen === 'object' ? s : { seen: {} };
}
function readPhantomLog() {
  const s = readJsonSafe(PHANTOM_LOG_PATH, { deleted: [] });
  return s && Array.isArray(s.deleted) ? s : { deleted: [] };
}
// Loose merchant match: normalize to lowercase alphanumerics and require one to
// contain the other (handles "KEKES #12 ANN ARBOR" vs "Kekes").
function payeeAlike(a, b) {
  const norm = (x) => String(x || '').toLowerCase().replace(/[^a-z0-9]+/g, '');
  const x = norm(a), y = norm(b);
  if (!x || !y) return false;
  const short = x.length <= y.length ? x : y;
  const long = x.length <= y.length ? y : x;
  return short.length >= 3 && long.includes(short);
}

async function cleanupPhantoms({
  window = 60,
  agedDays = 14,
  observeDays = 10,
  holdAgedDays = 5,
  holdObserveDays = 0,
  dryRun = false,
  operationKey = null,
  journalBinding = null,
  faultInjector = null,
} = {}) {
  if (!dryRun) {
    const result = await withApi((api) => getBulkOperationSagaManager().run(api, {
      kind: 'phantom_cleanup',
      operationKey,
      journalBinding,
      params: { window, agedDays, observeDays, holdAgedDays, holdObserveDays },
      faultInjector,
      deferSync: true,
    }), { mode: 'write' });
    if (result.status === 'unresolved') {
      throw new Error(`phantom cleanup outcome unresolved (${result.auditOutcome?.failed || 0} failed item(s))`);
    }
    return result;
  }
  return withApi(async (api) => {
    const today = todayYMD();
    const start = addDays(today, -Math.abs(window));
    const payees = await api.getPayees();
    const pn = {};
    for (const p of payees) pn[p.id] = p.name || '';
    const accts = (await api.getAccounts()).filter((a) => !a.closed);

    const store = readPhantomSeen();
    const log = readPhantomLog();
    const nowIso = new Date().toISOString();
    const liveIds = new Set();
    const deleted = [];
    const flaggedAged = [];

    const nameOf = (t) => pn[t.payee] || t.imported_payee || '';
    const noteText = (t) => String(t.notes || '');
    const hasNote = (t) => noteText(t).trim().length > 0;
    const hasKeepNote = (t) => /(^|\s)#keep\b|\[keep\]/i.test(noteText(t));
    const isDropOffHoldNote = (t) => {
      const n = noteText(t);
      return /\b(auth|authorization|hold|pending)\b/i.test(n) && /\b(drop|drops|dropped|fall|falls|fell|release|released|temporary)\b/i.test(n);
    };
    const daysOld = (d) => daysBetween(String(d).slice(0, 10), today);

    for (const acct of accts) {
      const txns = await api.getTransactions(acct.id, start, today);
      const pendings = txns.filter((t) => t.imported_id && t.cleared === false && !t.is_parent && !t.parent_id);
      const cleared = txns.filter((t) => t.cleared === true && !t.is_parent);

      for (const p of pendings) {
        const id = String(p.id);
        if (!dryRun) assertTransactionMutationAvailable({ accountId: acct.id, ids: [id] });
        liveIds.add(id);
        const amt = d2(p.amount);
        const payee = nameOf(p);
        // Strike ledger: remember when we first saw it pending.
        const prev = store.seen[id];
        store.seen[id] = { firstSeen: (prev && prev.firstSeen) || nowIso, lastSeen: nowIso, amount: amt, date: p.date, payee };
        const firstSeenDays = daysBetween(String(store.seen[id].firstSeen).slice(0, 10), today);

        // Rule A — superseded: a cleared charge for the same merchant, similar
        // amount, dated on/after the hold => the auth actually posted.
        const magP = Math.abs(amt);
        const superseder = cleared.find((q) => {
          if (q.id === p.id) return false;
          const magQ = Math.abs(d2(q.amount));
          const near = Math.abs(magQ - magP) <= Math.max(2, magP * 0.30);
          return near && q.date >= addDays(p.date, -1) && payeeAlike(payee, nameOf(q));
        });

        let reason = null;
        const dropOffHold = isDropOffHoldNote(p);
        const noteProtected = hasKeepNote(p) || (hasNote(p) && !dropOffHold);
        if (superseder && !hasKeepNote(p)) reason = `superseded by cleared ${nameOf(superseder)} ${d2(superseder.amount)} on ${superseder.date}`;
        else if (!noteProtected && dropOffHold && daysOld(p.date) >= holdAgedDays && firstSeenDays >= holdObserveDays)
          reason = `dropped auth hold: hold/drop-off note, age ${daysOld(p.date)}d, watched ${firstSeenDays}d`;
        else if (!noteProtected && daysOld(p.date) >= agedDays && firstSeenDays >= observeDays)
          reason = `dropped hold: pending ${agedDays}d+ (age ${daysOld(p.date)}d, watched ${firstSeenDays}d), no matching posted charge`;

        if (!reason) {
          if (!noteProtected && daysOld(p.date) >= agedDays && firstSeenDays < observeDays)
            flaggedAged.push({ id, payee, amount: amt, date: p.date, watchedDays: firstSeenDays, needDays: observeDays });
          continue;
        }

        const rec = { id, account: acct.name, payee, amount: amt, date: p.date, reason, at: nowIso, dryRun: !!dryRun };
        if (!dryRun) {
          await deleteTransaction({ id, accountId: acct.id, date: p.date, allowImported: true });
          log.deleted.push(rec);
          delete store.seen[id];
        }
        deleted.push(rec);
      }
    }

    // Forget ledger entries whose transaction is gone (cleared or removed).
    for (const id of Object.keys(store.seen)) {
      if (liveIds.has(id) || deleted.some((d) => d.id === id)) continue;
      if (!dryRun) assertTransactionMutationAvailable({ ids: [id] });
      delete store.seen[id];
    }

    if (!dryRun) {
      writeJsonSafe(PHANTOM_SEEN_PATH, store);
      if (log.deleted.length > 500) log.deleted = log.deleted.slice(-500);
      writeJsonSafe(PHANTOM_LOG_PATH, log);
    }
    return { ok: true, dryRun: !!dryRun, deletedCount: deleted.length, deleted, flaggedAged, watching: Object.keys(store.seen).length };
  }, { mode: dryRun ? 'read' : 'write' });
}
function getPhantomLog({ limit = 100 } = {}) {
  const log = readPhantomLog();
  return { deleted: log.deleted.slice(-Math.abs(limit)).reverse(), total: log.deleted.length };
}

// ---------------------------------------------------------------------------
// Receipts — scan a receipt, link it to a transaction, keep the raw image on the
// server (durable) alongside the on-device copy. Metadata lives in receipts.json,
// image bytes in RECEIPTS_DIR/<id>.<ext>.
// ---------------------------------------------------------------------------
function readReceipts() {
  const s = readJsonSafe(RECEIPTS_PATH, { byTxn: {} });
  return s && s.byTxn && typeof s.byTxn === 'object' ? s : { byTxn: {} };
}
const EXT_FOR_MIME = { 'image/jpeg': 'jpg', 'image/jpg': 'jpg', 'image/png': 'png', 'image/heic': 'heic', 'image/heif': 'heic', 'image/webp': 'webp' };
function ensureReceiptsDir() {
  fs.mkdirSync(RECEIPTS_DIR, { recursive: true, mode: 0o700 });
  fs.chmodSync(RECEIPTS_DIR, 0o700);
}
function detectedImageMime(buffer) {
  if (buffer.length >= 3 && buffer[0] === 0xff && buffer[1] === 0xd8 && buffer[2] === 0xff) return 'image/jpeg';
  if (buffer.length >= 8 && buffer.subarray(0, 8).equals(Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]))) return 'image/png';
  if (buffer.length >= 12 && buffer.subarray(0, 4).toString('ascii') === 'RIFF' && buffer.subarray(8, 12).toString('ascii') === 'WEBP') return 'image/webp';
  if (buffer.length >= 12 && buffer.subarray(4, 8).toString('ascii') === 'ftyp') {
    const brand = buffer.subarray(8, 12).toString('ascii').toLowerCase();
    if (['heic', 'heix', 'hevc', 'hevx'].includes(brand)) return 'image/heic';
    if (['mif1', 'msf1', 'heif'].includes(brand)) return 'image/heif';
  }
  return null;
}
function decodeImageBase64(value) {
  const clean = stripBase64Envelope(value);
  if (!clean || clean.length % 4 === 1 || !/^[A-Za-z0-9+/]*={0,2}$/.test(clean)) throw new Error('invalid base64 image');
  const estimated = exactBase64DecodedBytes(clean);
  if (estimated > RECEIPT_MAX_DECODED_BYTES) throw new Error('image too large (max 25MB)');
  const buffer = Buffer.from(clean, 'base64');
  if (!buffer.length) throw new Error('empty image');
  if (buffer.length > RECEIPT_MAX_DECODED_BYTES) throw new Error('image too large (max 25MB)');
  return buffer;
}

// Persist a scanned receipt. `imageBase64` is the raw (optionally data-URI-prefixed)
// image; OCR text/lines + a guessed total/date are stored for search + display.
function addReceipt({
  txnId,
  imageBase64,
  mime,
  ocrText,
  ocrLines,
  amount,
  date,
  source,
} = {}) {
  if (!txnId) throw new Error('txnId required');
  if (!imageBase64) throw new Error('imageBase64 required');
  assertTransactionMutationAvailable({ ids: [txnId] });
  const normalizedAmount = amount == null ? null : fromCents(toCents(amount));
  const buf = decodeImageBase64(imageBase64);
  const m = (mime || 'image/jpeg').toLowerCase();
  if (!EXT_FOR_MIME[m]) throw new Error('unsupported receipt image type');
  const detected = detectedImageMime(buf);
  const compatibleHeif = detected && ['image/heic', 'image/heif'].includes(detected) && ['image/heic', 'image/heif'].includes(m);
  if (!detected || (detected !== m && !compatibleHeif)) throw new Error('receipt image bytes do not match the declared type');
  const sha256 = crypto.createHash('sha256').update(buf).digest('hex');
  const store = readReceipts();
  for (const receipts of Object.values(store.byTxn)) {
    const duplicate = receipts.find((receipt) => receipt.sha256 === sha256);
    if (duplicate) throw new Error(`duplicate receipt image already stored as ${duplicate.id}`);
  }
  const ext = EXT_FOR_MIME[detected];
  const id = `rcpt_${Date.now().toString(36)}_${crypto.randomBytes(6).toString('hex')}`;
  ensureReceiptsDir();
  const finalPath = safeReceiptPath(`${id}.${ext}`);
  const tempPath = `${finalPath}.upload-${process.pid}`;
  let fd;
  try {
    fd = fs.openSync(tempPath, 'wx', 0o600);
    fs.writeFileSync(fd, buf);
    fs.fsyncSync(fd);
    fs.closeSync(fd);
    fd = undefined;
    fs.renameSync(tempPath, finalPath);
  } catch (error) {
    if (fd !== undefined) {
      try { fs.closeSync(fd); } catch (_) {}
    }
    try { fs.unlinkSync(tempPath); } catch (_) {}
    throw error;
  }
  const rec = {
    id, txnId: String(txnId), file: `${id}.${ext}`, mime: detected, size: buf.length,
    ocrText: typeof ocrText === 'string' ? ocrText.slice(0, 8000) : '',
    ocrLines: Array.isArray(ocrLines) ? ocrLines.slice(0, 200) : [],
    amount: normalizedAmount,
    date: date || null,
    source: source || 'camera',
    sha256,
    evidenceStatus: ocrText || (Array.isArray(ocrLines) && ocrLines.length) ? 'needs-review' : 'unreadable',
    uploadedAt: new Date().toISOString(),
  };
  (store.byTxn[rec.txnId] = store.byTxn[rec.txnId] || []).push(rec);
  try {
    writeJsonSafe(RECEIPTS_PATH, store);
  } catch (error) {
    try { fs.unlinkSync(finalPath); } catch (_) {}
    throw error;
  }
  return publicReceipt(rec);
}
// Strip server-only fields for API responses (the file name stays internal).
function publicReceipt(r) {
  return { id: r.id, txnId: r.txnId, mime: r.mime, size: r.size, ocrText: r.ocrText, ocrLines: r.ocrLines, amount: r.amount, date: r.date, source: r.source, evidenceStatus: r.evidenceStatus || 'unreadable', uploadedAt: r.uploadedAt };
}
function getReceipts({ txnId } = {}) {
  const store = readReceipts();
  if (txnId) return { receipts: (store.byTxn[String(txnId)] || []).map(publicReceipt) };
  const all = [];
  for (const list of Object.values(store.byTxn)) for (const r of list) all.push(publicReceipt(r));
  return { receipts: all };
}
function assertReceiptMutationAvailable({ id } = {}) {
  if (!id) throw new Error('id required');
  const store = readReceipts();
  for (const [txnId, receipts] of Object.entries(store.byTxn)) {
    const receipt = receipts.find((candidate) => candidate.id === id);
    if (!receipt) continue;
    assertTransactionMutationAvailable({ ids: [txnId, receipt.txnId] });
    return;
  }
}
// Resolve a receipt id to its on-disk file for streaming.
function getReceiptFile({ id } = {}) {
  if (!id) return null;
  const store = readReceipts();
  for (const list of Object.values(store.byTxn)) {
    const r = list.find((x) => x.id === id);
    if (r) {
      const file = safeReceiptPath(r.file);
      return fs.existsSync(file) ? { path: file, mime: r.mime } : null;
    }
  }
  return null;
}
function deleteReceipt({ id } = {}) {
  if (!id) throw new Error('id required');
  assertReceiptMutationAvailable({ id });
  const store = readReceipts();
  let removed = null;
  for (const [txn, list] of Object.entries(store.byTxn)) {
    const idx = list.findIndex((x) => x.id === id);
    if (idx >= 0) {
      removed = list[idx];
      list.splice(idx, 1);
      if (!list.length) delete store.byTxn[txn];
      break;
    }
  }
  if (removed) {
    const file = safeReceiptPath(removed.file);
    const trash = `${file}.pending-delete-${process.pid}-${Date.now()}`;
    if (fs.existsSync(file)) fs.renameSync(file, trash);
    try {
      writeJsonSafe(RECEIPTS_PATH, store);
      if (fs.existsSync(trash)) fs.unlinkSync(trash);
    } catch (error) {
      try { if (fs.existsSync(trash)) fs.renameSync(trash, file); } catch (_) {}
      throw error;
    }
  }
  return { ok: true, removed: !!removed };
}

function safeReceiptPath(file) {
  if (!file || path.basename(file) !== file) throw new Error('invalid receipt file reference');
  const resolved = path.resolve(RECEIPTS_DIR, file);
  if (path.dirname(resolved) !== path.resolve(RECEIPTS_DIR)) throw new Error('invalid receipt file path');
  return resolved;
}

function isStateObject(value) {
  return Boolean(value) && typeof value === 'object' && !Array.isArray(value);
}

function readTransactionDeletionReferenceStores() {
  return {
    receipts: readJsonSafe(
      RECEIPTS_PATH,
      { byTxn: {} },
      (value) => isStateObject(value)
        && isStateObject(value.byTxn)
        && Object.values(value.byTxn).every(Array.isArray),
    ),
    links: readJsonSafe(
      REIMB_LINKS_PATH,
      { links: [] },
      (value) => isStateObject(value) && Array.isArray(value.links),
    ),
    suggestions: readJsonSafe(
      REIMB_SUGGEST_PATH,
      { confirmed: {}, dismissed: [] },
      (value) => isStateObject(value)
        && isStateObject(value.confirmed)
        && Array.isArray(value.dismissed),
    ),
    reconciliation: readJsonSafe(
      RECON_PATH,
      { enabled: false, months: {} },
      (value) => isStateObject(value) && isStateObject(value.months),
    ),
    phantomSeen: readJsonSafe(
      PHANTOM_SEEN_PATH,
      { seen: {} },
      (value) => isStateObject(value) && isStateObject(value.seen),
    ),
  };
}

function planTransactionReferenceDeletion(targetIds) {
  const result = rewriteTransactionDeletionReferences(
    readTransactionDeletionReferenceStores(),
    targetIds,
  );
  for (const file of result.receiptFilesToDelete) safeReceiptPath(file);
  return {
    stats: result.stats,
    receiptFilesToDelete: result.receiptFilesToDelete,
  };
}

function applyTransactionDeletionReferenceStep(step, targetIds, _plan) {
  const current = readTransactionDeletionReferenceStores();
  const next = rewriteTransactionDeletionReferences(current, targetIds).stores[step];
  const destinations = {
    receipts: RECEIPTS_PATH,
    links: REIMB_LINKS_PATH,
    suggestions: REIMB_SUGGEST_PATH,
    reconciliation: RECON_PATH,
    phantomSeen: PHANTOM_SEEN_PATH,
  };
  if (!destinations[step]) throw new Error(`unknown transaction deletion reference step: ${step}`);
  if (JSON.stringify(current[step]) !== JSON.stringify(next)) {
    if (step === 'links') writeReimbLinks(next);
    else writeJsonSafe(destinations[step], next);
  }
}

function transactionDeletionReferencesConverged(targetIds, _plan) {
  const current = readTransactionDeletionReferenceStores();
  const rewritten = rewriteTransactionDeletionReferences(current, targetIds);
  return TRANSACTION_DELETION_REFERENCE_STEPS.every(
    (step) => JSON.stringify(current[step]) === JSON.stringify(rewritten.stores[step]),
  );
}

function transactionDeletionReceiptFileState(file) {
  const resolved = safeReceiptPath(file);
  const receipts = readTransactionDeletionReferenceStores().receipts;
  const referenced = Object.values(receipts.byTxn)
    .some((list) => list.some((receipt) => receipt?.file === file));
  return { exists: fs.existsSync(resolved), referenced };
}

function unlinkTransactionDeletionReceiptFile(file) {
  const state = transactionDeletionReceiptFileState(file);
  if (state.referenced) throw new Error('refusing to delete a referenced receipt file');
  const resolved = safeReceiptPath(file);
  if (fs.existsSync(resolved)) fs.unlinkSync(resolved);
}

function readTransactionReferenceStores() {
  return {
    receipts: readReceipts(),
    links: readReimbLinks(),
    suggestions: readReimbSuggest(),
    reconciliation: readRecon(),
    phantomSeen: readPhantomSeen(),
  };
}

const TRANSACTION_REFERENCE_STEPS = Object.freeze([
  'receipts',
  'links',
  'suggestions',
  'reconciliation',
  'phantomSeen',
]);

function planTransactionReferenceMigration(idMap) {
  const result = rewriteTransactionReplacementReferences(readTransactionReferenceStores(), idMap);
  return {
    stats: result.stats,
  };
}

function applyTransactionReferenceStep(step, idMap, _plan) {
  const current = readTransactionReferenceStores();
  const next = rewriteTransactionReplacementReferences(current, idMap).stores[step];
  const destinations = {
    receipts: RECEIPTS_PATH,
    links: REIMB_LINKS_PATH,
    suggestions: REIMB_SUGGEST_PATH,
    reconciliation: RECON_PATH,
    phantomSeen: PHANTOM_SEEN_PATH,
  };
  if (!destinations[step]) throw new Error(`unknown transaction reference step: ${step}`);
  if (JSON.stringify(current[step]) !== JSON.stringify(next)) {
    if (step === 'links') writeReimbLinks(next);
    else writeJsonSafe(destinations[step], next);
  }
}

function transactionReferencesConverged(idMap, _plan) {
  const current = readTransactionReferenceStores();
  const rewritten = rewriteTransactionReplacementReferences(current, idMap);
  for (const step of TRANSACTION_REFERENCE_STEPS) {
    if (JSON.stringify(current[step]) !== JSON.stringify(rewritten.stores[step])) return false;
  }
  return true;
}

// Collapse a split back into a single plain transaction (RM's "remove split").
// delete + re-add as a simple row so we never hit the unsafe in-place unsplit path.
async function removeSplit({ id, accountId, date, categoryId } = {}) {
  assertTransactionMutationAvailable({ ids: [id] });
  return withApi(async (api) => {
    if (!accountId || !date) throw new Error('accountId and date required');
    const txns = await api.getTransactions(accountId, date, date);
    let parent = txns.find((t) => t.id === id);
    if (parent && parent.parent_id) parent = txns.find((t) => t.id === parent.parent_id) || parent;
    if (!parent) throw new Error('transaction not found');
    if (!parent.is_parent) return { ok: true, mode: 'noop' }; // already simple
    const replacement = addableTransaction(parent, {
      category: categoryId || undefined,
      subtransactions: undefined,
    });
    delete replacement.subtransactions;
    const added = await replaceActualTransaction(api, { accountId, original: parent, replacement });
    const { references } = replacementSagaResult(added);
    return {
      ok: true,
      mode: 'unsplit',
      id: String(added.id),
      previousId: String(parent.id),
      references,
    };
  }, { mode: 'write' });
}

// Permanently remove a transaction. Deleting a split parent removes its legs too.
// Rocket-Money parity: user-facing deletes are refused for BANK-IMPORTED rows
// (those carry an imported_id) — only manually-added ones can be deleted by hand.
// The automated phantom cleanup passes allowImported=true to remove stale pending
// charges that fell off the feed. Every caller must still provide account + date
// so authorization and sidecar cleanup are based on the canonical ledger row.
async function deleteTransaction({
  id,
  accountId,
  date,
  allowImported = false,
  bulkDelegation = null,
  faultInjector,
} = {}) {
  if (!id) throw new Error('id required');
  if (!accountId || !date) throw new Error('accountId and date required');
  if (bulkDelegation) {
    if (String(id) !== String(bulkDelegation.txnId)) {
      throw new BulkOperationInProgressError();
    }
    if (String(accountId) !== String(bulkDelegation.accountId)) {
      throw new BulkOperationInProgressError();
    }
    getBulkOperationSagaManager().assertDeletionDelegationAuthorized(bulkDelegation);
  }
  assertTransactionDeletionAvailable({ accountId, ids: [id], bulkDelegation });
  return withApi(async (api) => {
    const txns = await api.getTransactions(accountId, date, date);
    let transaction = txns.find((item) => String(item.id) === String(id));
    if (!transaction) throw new Error('transaction not found');
    if (transaction.parent_id) {
      if (!allowImported) throw new Error('split legs cannot be deleted independently');
      const parent = txns.find(
        (item) => String(item.id) === String(transaction.parent_id),
      );
      if (!parent) throw new Error('split parent not found');
      transaction = parent;
    }
    if (!allowImported && transaction.imported_id) {
      throw new Error('Bank-imported transactions can’t be deleted — only ones you added manually.');
    }
    const ids = [
      String(transaction.id),
      ...(transaction.subtransactions || []).map((leg) => String(leg.id)),
    ];
    assertTransactionDeletionAvailable({ accountId, ids, transaction, bulkDelegation });
    return getTransactionDeletionSagaManager().remove(api, {
      accountId,
      date,
      transaction,
      faultInjector,
      bulkDelegation,
    });
  }, { mode: 'write' });
}

// Rename a transaction's payee (RM "rename"). Resolves the free-text name to a payee
// (find-or-create); Actual keeps imported_payee + imported_id untouched so the
// original bank description and future matching are preserved. Blank name clears it.
async function setPayee({ id, payee, isLeg, parentId, accountId, date } = {}) {
  assertTransactionMutationAvailable({
    ids: isLeg ? [parentId, id] : [id],
  });
  return withApi(async (api) => {
    if (!isLeg) {
      const payeeId = await resolvePayeeId(api, payee);
      await api.updateTransaction(id, { payee: payeeId || null });
      return { ok: true, mode: 'update' };
    }
    if (!parentId || !accountId || !date) throw new Error('parentId, accountId and date required for split legs');
    const txns = await api.getTransactions(accountId, date, date);
    const parent = txns.find((t) => t.id === parentId);
    if (!parent || !Array.isArray(parent.subtransactions)) throw new Error('parent split not found');
    assertReconstructableTransaction(parent);
    await assertTransactionImportedIdentityAvailable(api, { accountId, original: parent });
    const payeeId = await resolvePayeeId(api, payee);
    const subs = parent.subtransactions.map((s) => ({
      amount: s.amount,
      category: s.category || null,
      notes: s.notes || undefined,
      payee: s.id === id ? payeeId || null : s.payee || undefined,
    }));
    const replacement = addableTransaction(parent, { category: undefined, subtransactions: subs });
    const added = await replaceActualTransaction(api, {
      accountId,
      original: parent,
      replacement,
      requestedLegs: retainedReplacementLegs(parent),
    });
    const { idMap, references } = replacementSagaResult(added);
    return {
      ok: true,
      mode: 'rebuild-split',
      id: idMap[String(id)] || String(added.id),
      parentId: String(added.id),
      previousId: String(id),
      references,
    };
  }, { mode: 'write' });
}

// ---------------------------------------------------------------------------
// Categorization rules — auto-apply a category to matching (uncategorized) txns
// ---------------------------------------------------------------------------
function getRules() {
  const store = readJsonSafe(RULES_PATH, { rules: [] });
  return { rules: Array.isArray(store.rules) ? store.rules : [] };
}

// Apply a single rule to uncategorized, non-split txns in a window. Only ever
// fills an EMPTY category, so it can't clobber a manual categorization.
async function applyRuleToTxns(api, rule, { months = 24 } = {}) {
  const today = todayYMD();
  const start = addDays(today, -Math.round(30.44 * months));
  const accounts = (await api.getAccounts()).filter((a) => !a.closed);
  const payees = await api.getPayees();
  const pn = {};
  for (const p of payees) pn[p.id] = p.name || '';
  const needle = (rule.match || '').toLowerCase().trim();
  if (!needle || !rule.categoryId) return 0;
  let applied = 0;
  for (const a of accounts) {
    const txns = await api.getTransactions(a.id, start, today);
    for (const t of txns) {
      if (t.is_parent || t.parent_id) continue; // don't touch splits
      if (t.category) continue; // only uncategorized
      const name = (pn[t.payee] || t.imported_payee || '').toLowerCase();
      if (!name.includes(needle)) continue;
      assertTransactionMutationAvailable({ accountId: a.id, ids: [t.id] });
      await api.updateTransaction(t.id, { category: rule.categoryId });
      applied++;
    }
  }
  return applied;
}

async function saveRule({ match, categoryId, categoryName } = {}, {
  sync = true,
  operationKey = null,
  journalBinding = null,
  faultInjector = null,
} = {}) {
  const m = (match || '').trim();
  if (!m || !categoryId) throw new Error('match and categoryId required');
  const store = getRules();
  if (!store || !Array.isArray(store.rules)) throw new Error('invalid rules store');
  const id = 'r' + Date.now().toString(36);
  const rule = { id, match: m, categoryId, categoryName: categoryName || '', created: todayYMD() };
  const result = await withApi((api) => getBulkOperationSagaManager().run(api, {
    kind: 'rules_save',
    operationKey,
    journalBinding,
    params: { rule },
    faultInjector,
    deferSync: !sync,
  }), { mode: 'write' });
  if (result.status === 'unresolved') {
    throw new Error(`rule save outcome unresolved (${result.auditOutcome?.failed || 0} failed item(s))`);
  }
  if (result.failed) {
    throw new Error(`rule save failed for ${result.failed} item(s)`);
  }
  return { ok: result.ok, needsSync: result.needsSync, id: result.id || id, applied: result.applied, status: result.status, auditOutcome: result.auditOutcome };
}

function deleteRule({ id } = {}) {
  if (!id) throw new Error('id required');
  const store = getRules();
  const before = store.rules.length;
  store.rules = store.rules.filter((r) => r.id !== id);
  writeJsonSafe(RULES_PATH, store);
  return { ok: true, removed: before - store.rules.length };
}

// Move peer settle-ups (Splitwise/Venmo/Zelle) that imported into an Income
// category over to Reimbursement, so a friend paying you back never counts as
// real income. Only ever touches income-filed inflows whose payee/notes match a
// settle-up service — manual categorizations elsewhere are left alone.
async function refileSettleUps({ sync = true } = {}) {
  return withApi(async (api) => {
    const groups = await api.getCategoryGroups();
    const catInfo = buildCatInfo(groups);
    let reimbId = null;
    for (const g of groups) for (const c of g.categories || []) if (REIMB_CAT.test(c.name || '')) reimbId = c.id;
    if (!reimbId) return { ok: false, moved: 0, reason: 'no Reimbursement category' };
    const payees = await api.getPayees();
    const pn = {};
    for (const p of payees) pn[p.id] = p.name || '';
    const accts = (await api.getAccounts()).filter((a) => !a.offbudget && !a.closed);
    let moved = 0;
    for (const a of accts) {
      const tx = await api.getTransactions(a.id, '2000-01-01', todayYMD());
      for (const t of tx) {
        if (t.is_parent || t.parent_id) continue;
        if (!(t.amount > 0)) continue; // paybacks are inflows
        const meta = t.category ? catInfo[t.category] : null;
        if (!meta || meta.kind !== 'income') continue; // only rescue misfiled income
        const hay = `${pn[t.payee] || t.imported_payee || ''} ${t.notes || ''}`;
        if (!SETTLE_UP_PAYEE.test(hay)) continue;
        assertTransactionMutationAvailable({ accountId: a.id, ids: [t.id] });
        await api.updateTransaction(t.id, { category: reimbId });
        moved++;
      }
    }
    if (moved && sync) await syncNow();
    return { ok: true, moved };
  }, { mode: 'write' });
}

// ---------------------------------------------------------------------------
// Splitwise share-as-spending. For an expense a friend PAID that I owe a share
// of, no charge ever hits my card — so my real consumption goes uncounted. We
// mirror each such share into Actual as a synthetic expense on a dedicated
// "Splitwise" account, tagged #sw-<expenseId> so re-runs update/prune instead of
// duplicating. A later settle-up I make is money movement (Reimbursement), not a
// second spend — my share is "spent" the moment I consume it. The account is
// on-budget (so the share counts as spend + is drill-downable) but excluded from
// net worth in getTrends, since it's a spend-attribution ledger, not real cash.
// ---------------------------------------------------------------------------
const SW_ACCOUNT_NAME = process.env.SPLITWISE_ACCOUNT_NAME || 'Splitwise';
const SW_CATEGORY_NAME = process.env.SPLITWISE_CATEGORY_NAME || 'Splitwise';
const SW_CAT_KEYWORDS = [
  [/rent|mortgage|lease/i, 'rent'],
  [/util|electric|water|sewage|trash|internet|wifi|phone/i, 'util'],
  [/grocer/i, 'grocer'],
  [/dining|restaurant|dinner|lunch|breakfast|liquor|bar\b/i, 'dining'],
  [/gas\/fuel|fuel|petrol/i, 'gas'],
  [/car|uber|lyft|taxi|transport|parking|toll|bus|train|flight|airfare/i, 'transport'],
  [/hotel|airbnb|lodging|hostel/i, 'travel'],
  [/movie|game|entertain|concert|ticket/i, 'entertain'],
  [/shop|amazon|electronic|target|clothing/i, 'shop'],
];
async function ensureSplitwiseAccount(api) {
  const accts = await api.getAccounts();
  const found = accts.find((a) => (a.name || '').toLowerCase() === SW_ACCOUNT_NAME.toLowerCase());
  if (found) return found.id;
  return api.createAccount({ name: SW_ACCOUNT_NAME, offbudget: false }, 0);
}
async function ensureSplitwiseCategory(api) {
  const groups = await api.getCategoryGroups();
  for (const g of groups) for (const c of g.categories || []) if ((c.name || '').toLowerCase() === SW_CATEGORY_NAME.toLowerCase()) return c.id;
  const spendGroup = groups.find((g) => !g.is_income && !MONEY_MOVEMENT_GROUP.test(g.name || '') && !INCOME_GROUP.test(g.name || '') && (g.categories || []).length);
  if (!spendGroup) return null;
  return api.createCategory({ name: SW_CATEGORY_NAME, group_id: spendGroup.id });
}
function pickSplitwiseCategory(swCatName, spendCats) {
  const n = (swCatName || '').toLowerCase();
  for (const [rx, kw] of SW_CAT_KEYWORDS) {
    if (rx.test(n)) { const hit = spendCats.find((c) => c.name.toLowerCase().includes(kw)); if (hit) return hit.id; }
  }
  return null;
}
function validateSplitwiseMirrorSnapshot(truth, { now = Date.now(), maxAgeMs = owesSnapshotMaxAgeMs() } = {}) {
  try {
    return validateSplitwiseMirrorSnapshotRaw(truth, { now, maxAgeMs });
  } catch (error) {
    throw new SplitwiseMirrorSnapshotError(String(error?.message || error || 'Splitwise snapshot validation failed'));
  }
}
function validateSplitwiseMirrorSnapshotRaw(truth, { now = Date.now(), maxAgeMs = owesSnapshotMaxAgeMs() } = {}) {
  if (!truth || typeof truth !== 'object') throw new Error('Splitwise snapshot is missing');
  const manifest = truth.manifest;
  if (
    truth.schemaVersion !== 2 ||
    !manifest ||
    manifest.complete !== true ||
    manifest.itemizedComplete !== true ||
    manifest.resolvedEvents !== manifest.expectedEvents ||
    (manifest.failedEvents || []).length
  ) {
    throw new Error('Splitwise snapshot is incomplete; refusing to modify mirrored spending');
  }
  const expectedCurrency = process.env.SPLITWISE_CURRENCY || 'USD';
  if (manifest.currency !== expectedCurrency) {
    throw new Error(`Splitwise snapshot currency must be ${expectedCurrency}`);
  }
  const generatedAt = Date.parse(truth.generatedAt || '');
  if (!Number.isFinite(generatedAt) || now - generatedAt > maxAgeMs || generatedAt > now + 5 * 60 * 1000) {
    throw new Error('Splitwise snapshot is stale or has an invalid timestamp; refusing to modify mirrored spending');
  }
  if (!Array.isArray(truth.othersPaidItems)) throw new Error('Splitwise snapshot is missing itemized spending');
  const seen = new Set();
  for (const item of truth.othersPaidItems) {
    const id = String(item?.id || '');
    if (!/^\d+$/.test(id)) throw new Error('Splitwise snapshot contains an invalid expense id');
    if (seen.has(id)) throw new Error(`Splitwise snapshot contains duplicate expense ${id}`);
    seen.add(id);
    try {
      myShareExpenseCents(item);
    } catch (error) {
      throw new Error(String(error.message || error));
    }
    if (item.currency && item.currency !== expectedCurrency) {
      throw new Error(`Splitwise expense ${id} has unexpected currency ${item.currency}`);
    }
  }
  return truth.othersPaidItems;
}
async function preflightSplitwiseMirrorShareSync() {
  return withApi(async (actualApi) => preflightSplitwiseMirrorAdmission({
    api: actualApi,
    readTruth: () => readJsonSafe(OWES_TRUTH_PATH, null),
    validateSnapshot: validateSplitwiseMirrorSnapshot,
    readResolutions: readSplitwiseMirrorResolutions,
    accountName: SW_ACCOUNT_NAME,
    categoryName: SW_CATEGORY_NAME,
    accountRangeStart: '1900-01-01',
    accountRangeEnd: '9999-12-31',
  }), { mode: 'read', skipRecover: true });
}
async function syncSplitwiseShareExpenses({
  sync = true,
  operationKey = null,
  journalBinding = null,
  faultInjector = null,
} = {}) {
  const result = await withApi((api) => getBulkOperationSagaManager().run(api, {
    kind: 'splitwise_mirror',
    operationKey,
    journalBinding,
    params: {},
    faultInjector,
    deferSync: !sync,
  }), { mode: 'write' });
  if (result.status === 'unresolved') {
    throw new BulkOperationOutcomeUnknownError('Splitwise mirror outcome unresolved');
  }
  if (result.needsSync && result.status === 'in_progress') {
    return result;
  }
  if (operationKey) {
    return getBulkOperationResult(operationKey) || result;
  }
  return result;
}

// Built-in merchant catalog — the "Rocket Money auto-categorize". Each entry maps
// a payee keyword to a category TYPE; the type is resolved to whichever of YOUR
// Actual categories matches by name, so it adapts to your setup. Applied only to
// still-uncategorized txns AFTER your own rules (which always win).
const MERCHANT_CATALOG = [
  { label: 'Restaurants, coffee & food delivery', rx: /tandoori|pizza|restaurant|grill|kitchen|cafe|coffee|starbucks|dunkin|chipotle|burger|taco|sushi|thai|ramen|bbq|diner|bakery|doordash|uber\s?eats|grubhub|postmates|panera|subway|wendy|\bkfc\b|popeye|deli|bistro|noodle|curry|biryani|domino/i, type: 'dining' },
  { label: 'Gas stations', rx: /\bshell\b|chevron|exxon|\barco\b|mobil|valero|circle k|marathon|speedway|gas station|\bfuel\b/i, type: 'gas' },
  { label: 'Rideshare & transit', rx: /\buber\b|lyft|\btaxi\b|\bcab\b|\bmetro\b|transit|caltrain|\bbart\b|amtrak|parking|\btoll/i, type: 'transport' },
  { label: 'Groceries', rx: /whole foods|trader joe|safeway|kroger|\baldi\b|grocer|sprouts|publix|wegmans|ralphs/i, type: 'groceries' },
  { label: 'Shopping & retail', rx: /amazon|\btarget\b|walmart|best buy|\bebay\b|etsy|ikea|macy|nordstrom|uniqlo/i, type: 'shopping' },
  { label: 'Streaming & subscriptions', rx: /netflix|hulu|disney|spotify|\bhbo\b|youtube\s?premium|prime video|apple music|patreon|icloud|dropbox/i, type: 'subscriptions' },
  { label: 'Movies, games & events', rx: /\bsteam\b|playstation|\bxbox\b|nintendo|\bamc\b|cinema|movie|regal|concert|ticketmaster|stubhub/i, type: 'entertainment' },
  { label: 'Utilities & internet', rx: /comcast|xfinity|at&t|verizon|t-mobile|pg&e|\bdte\b|sewage|electric|\butility\b|internet|\bwifi\b/i, type: 'utilities' },
  { label: 'Health, pharmacy & fitness', rx: /\bcvs\b|walgreens|pharmacy|hospital|clinic|dental|\bdoctor\b|medical|\bgym\b|fitness|equinox/i, type: 'health' },
  { label: 'Travel & hotels', rx: /airbnb|hotel|marriott|hilton|hyatt|expedia|booking\.com|airlines|delta air|united air|southwest air|airfare|\bflight\b/i, type: 'travel' },
  { label: 'Interest, dividends & payroll', rx: /interest|dividend|payroll|direct dep|tax refund/i, type: 'income' },
];
const CATALOG_TYPE_MATCH = {
  dining: /dining|restaurant|food|eat/i,
  gas: /\bgas\b|fuel/i,
  transport: /rideshare|transit|transport|commute|\bcar\b/i,
  groceries: /grocer/i,
  shopping: /shop|amazon|merchandise|retail/i,
  subscriptions: /subscri|streaming/i,
  entertainment: /entertain|movie|game|fun|recreation/i,
  utilities: /util|\bbills?\b/i,
  health: /health|medical|pharma|fitness|wellness/i,
  travel: /travel|trip|vacation|flight|hotel|lodging/i,
  income: /income|interest|paycheck|salary/i,
};
function resolveCatalogCategory(type, groups, catInfo) {
  const rx = CATALOG_TYPE_MATCH[type];
  if (!rx) return null;
  for (const g of groups) {
    const incomeGroup = g.is_income === true || INCOME_GROUP.test(g.name || '');
    for (const c of g.categories || []) {
      if (type === 'income') { if (incomeGroup && rx.test(c.name || '')) return c.id; }
      else { const info = catInfo[c.id]; if (info && info.kind === 'spend' && rx.test(c.name || '')) return c.id; }
    }
  }
  if (type === 'income') for (const g of groups) if (g.is_income === true || INCOME_GROUP.test(g.name || '')) for (const c of g.categories || []) return c.id;
  return null;
}
async function applyBuiltinCatalog(api, { months = 24 } = {}) {
  const today = todayYMD();
  const start = addDays(today, -Math.round(30.44 * months));
  const groups = await api.getCategoryGroups();
  const catInfo = buildCatInfo(groups);
  const typeCat = {};
  for (const type of Object.keys(CATALOG_TYPE_MATCH)) typeCat[type] = resolveCatalogCategory(type, groups, catInfo);
  const accounts = (await api.getAccounts()).filter((a) => !a.closed);
  const payees = await api.getPayees();
  const pn = {};
  for (const p of payees) pn[p.id] = p.name || '';
  let applied = 0;
  for (const a of accounts) {
    const txns = await api.getTransactions(a.id, start, today);
    for (const t of txns) {
      if (t.is_parent || t.parent_id || t.category || t.transfer_id) continue;
      const hay = `${pn[t.payee] || t.imported_payee || ''} ${t.notes || ''}`;
      for (const entry of MERCHANT_CATALOG) {
        if (!entry.rx.test(hay)) continue;
        if (entry.type === 'income' ? !(t.amount > 0) : !(t.amount < 0)) continue; // sign guard
        const cat = typeCat[entry.type];
        if (!cat) break;
        assertTransactionMutationAvailable({ accountId: a.id, ids: [t.id] });
        await api.updateTransaction(t.id, { category: cat });
        applied++;
        break;
      }
    }
  }
  return applied;
}
// Read-only view of the catalog for the Rules screen (regex hidden).
function getCatalogDisplay() {
  return MERCHANT_CATALOG.map((c) => ({ label: c.label, type: c.type }));
}

// Re-apply every rule (used on refresh + manual "apply now"). Successful work is
// synced, but any failed stage is surfaced so refresh never claims full success.
async function applyRules({
  sync = true,
  operationKey = null,
  journalBinding = null,
  faultInjector = null,
} = {}) {
  const result = await withApi((api) => getBulkOperationSagaManager().run(api, {
    kind: 'rules_apply',
    operationKey,
    journalBinding,
    params: {},
    faultInjector,
    deferSync: !sync,
  }), { mode: 'write' });
  if (result.status === 'unresolved') {
    throw new Error(`categorization outcome unresolved (${result.failed || 0} failed item(s))`);
  }
  if (result.failed) {
    throw new Error(`categorization failed in ${result.failed} item(s)`);
  }
  return {
    ok: result.ok,
    needsSync: result.needsSync,
    applied: result.applied,
    settleUpsMoved: result.settleUpsMoved || 0,
    status: result.status,
    auditOutcome: result.auditOutcome,
  };
}

// Force a payee to be treated as recurring even if detection didn't catch it
// (derives the same normalized key the engine uses).
function markRecurring({ payee, isBill } = {}) {
  const key = recurringKey(payee || '');
  if (!key) throw new Error('a valid payee is required');
  return setRecurringOverride({ key, forced: true, isBill });
}

// ---------------------------------------------------------------------------
// Write: safe split-aware notes change (mirrors setTransactionCategory)
// ---------------------------------------------------------------------------
async function setTransactionNotes({ id, notes, isLeg, parentId, accountId, date }) {
  assertTransactionMutationAvailable({
    ids: isLeg ? [parentId, id] : [id],
  });
  return withApi(async (api) => {
    if (!isLeg) {
      await api.updateTransaction(id, { notes: notes || null });
      return { ok: true, mode: 'update' };
    }
    if (!parentId || !accountId || !date) throw new Error('parentId, accountId and date required for split legs');
    const txns = await api.getTransactions(accountId, date, date);
    const parent = txns.find((t) => t.id === parentId);
    if (!parent || !Array.isArray(parent.subtransactions)) throw new Error('parent split not found');
    const subs = parent.subtransactions.map((s) => ({
      amount: s.amount,
      category: s.category || null,
      notes: s.id === id ? (notes || undefined) : (s.notes || undefined),
      payee: s.payee || undefined,
    }));
    const replacement = addableTransaction(parent, { category: undefined, subtransactions: subs });
    const added = await replaceActualTransaction(api, {
      accountId,
      original: parent,
      replacement,
      requestedLegs: retainedReplacementLegs(parent),
    });
    const { idMap, references } = replacementSagaResult(added);
    return {
      ok: true,
      mode: 'rebuild-split',
      id: idMap[String(id)] || String(added.id),
      parentId: String(added.id),
      previousId: String(id),
      references,
    };
  }, { mode: 'write' });
}

// Move a transaction to a different date. Handy for refunds that post the month
// after the purchase — dating the refund back to the purchase month makes it net
// that month's spending instead of the current one. Split legs inherit their
// parent's date, so only the parent (or a simple txn) can be moved.
async function setTransactionDate({ id, date, isLeg }) {
  if (isLeg) throw new Error('A split leg inherits its parent’s date — move the parent instead.');
  if (!/^\d{4}-\d{2}-\d{2}$/.test(date || '')) throw new Error('date must be YYYY-MM-DD');
  assertTransactionMutationAvailable({ ids: [id] });
  return withApi(async (api) => {
    await api.updateTransaction(id, { date });
    return { ok: true, date };
  }, { mode: 'write' });
}

// ---------------------------------------------------------------------------
// Savings goals — funded allocations; linked accounts are capacity constraints,
// never balances that multiple goals may each claim in full.
// ---------------------------------------------------------------------------
async function getGoals() {
  return withApi(async (api) => {
    const goals = readJsonSafe(GOALS_PATH, []);
    const accounts = (await api.getAccounts()).filter((a) => !a.closed);
    const bals = await Promise.all(accounts.map((a) => api.getAccountBalance(a.id)));
    const balById = {};
    accounts.forEach((a, i) => { balById[a.id] = bals[i] / 100; });
    return goals.map((g) => {
      const current = Math.max(0, Number(g.current) || 0);
      const remaining = Math.max(0, Number(g.target) - current);
      let monthlyRequired = null;
      if (g.deadline && /^\d{4}-\d{2}$/.test(g.deadline)) {
        const now = todayYMD().slice(0, 7);
        const [nowYear, nowMonth] = now.split('-').map(Number);
        const [endYear, endMonth] = g.deadline.split('-').map(Number);
        const months = Math.max(1, (endYear - nowYear) * 12 + endMonth - nowMonth + 1);
        monthlyRequired = fromCents(Math.ceil(Math.round(remaining * 100) / months));
      }
      return {
        ...g,
        current: round2(current),
        pct: g.target > 0 ? Math.min(999, Math.round((current / g.target) * 100)) : null,
        fundingSource: g.accountId ? 'allocated-account' : 'manual',
        availableInAccount: g.accountId && balById[g.accountId] != null ? Math.max(0, round2(balById[g.accountId])) : null,
        monthlyRequired,
      };
    });
  });
}

async function saveGoal(goal = {}) {
  const target = fromCents(toCents(goal.target));
  const current = goal.current === undefined ? 0 : fromCents(toCents(goal.current));
  if (!goal.name || !(target > 0)) throw new Error('name and positive target required');
  if (current < 0) throw new Error('current must be non-negative');
  const input = { ...goal, target, current };
  return withApi(async (api) => {
    const goals = readJsonSafe(GOALS_PATH, []);
    const normalized = { ...input };
    if (normalized.accountId) {
      const accounts = await api.getAccounts();
      const account = accounts.find((candidate) => candidate.id === normalized.accountId && !candidate.closed);
      if (!account) throw new Error('linked account not found');
      const capacity = Math.max(0, (await api.getAccountBalance(account.id)) / 100);
      const allocatedElsewhere = goals
        .filter((candidate) => candidate.id !== normalized.id && candidate.accountId === normalized.accountId)
        .reduce((sum, candidate) => sum + Math.max(0, Number(candidate.current) || 0), 0);
      if (allocatedElsewhere + normalized.current > capacity + 0.005) {
        throw new Error(`goal allocations exceed the linked account balance by ${round2(allocatedElsewhere + normalized.current - capacity)}`);
      }
    }
    if (normalized.id) {
      const i = goals.findIndex((candidate) => candidate.id === normalized.id);
      if (i >= 0) goals[i] = { ...goals[i], ...normalized };
      else goals.push(normalized);
    } else {
      normalized.id = 'g' + Date.now().toString(36);
      goals.push(normalized);
    }
    writeJsonSafe(GOALS_PATH, goals);
    return { ok: true, id: normalized.id };
  });
}

function deleteGoal(id) {
  if (!id) throw new Error('id required');
  const goals = readJsonSafe(GOALS_PATH, []).filter((g) => g.id !== id);
  writeJsonSafe(GOALS_PATH, goals);
  return { ok: true };
}

// ---------------------------------------------------------------------------
// All-time transaction search + CSV report data.
// ---------------------------------------------------------------------------
async function searchTransactions({ q, start, end, limit = 200 } = {}) {
  const today = todayYMD();
  const startDate = start || '2000-01-01';
  const endDate = end || today;
  const all = await getTransactions({ start: startDate, end: endDate });
  const needle = (q || '').toLowerCase().trim();
  const res = needle
    ? all.filter((t) =>
        (t.payee || '').toLowerCase().includes(needle) ||
        (t.category || '').toLowerCase().includes(needle) ||
        (t.account || '').toLowerCase().includes(needle) ||
        (t.notes || '').toLowerCase().includes(needle))
    : all;
  return {
    transactions: res.slice(0, limit),
    total: res.length,
    truncated: res.length > limit,
    range: { start: startDate, end: endDate },
  };
}

// Distinct #hashtags across recent transactions, for tag autocomplete + management.
// Tags live inline in transaction notes (e.g. "#ev-trip #alex"); this aggregates
// them with usage counts so the app can offer reuse instead of duplicates.
async function getTags({ start, end } = {}) {
  const today = todayYMD();
  const startDate = start || addDays(today, -365 * 3);
  const endDate = end || today;
  const all = await getTransactions({ start: startDate, end: endDate });
  const counts = new Map(); // lowercased raw -> { raw, count }
  for (const t of all) {
    const notes = t.notes || '';
    const seen = new Set();
    for (const m of notes.matchAll(/#([A-Za-z0-9][\w-]*)/g)) {
      const raw = m[0];
      const key = raw.toLowerCase();
      if (seen.has(key)) continue; // count each tag at most once per transaction
      seen.add(key);
      const cur = counts.get(key) || { raw, count: 0 };
      cur.count += 1;
      counts.set(key, cur);
    }
  }
  const tags = [...counts.values()]
    .map(({ raw, count }) => {
      const token = raw.slice(1);
      const isEvent = /^ev-/i.test(token);
      return { raw, token, label: isEvent ? token.replace(/^ev-/i, '') : token, kind: isEvent ? 'event' : 'tag', count };
    })
    .sort((a, b) => b.count - a.count || a.token.localeCompare(b.token));
  return { tags };
}

async function getMonthlyReport({ month } = {}) {
  const m = month || todayYMD().slice(0, 7);
  const [Y, M] = m.split('-').map(Number);
  const start = `${m}-01`;
  const end = monthRange(Y, M - 1).end;
  const [transactions, spending] = await Promise.all([
    getTransactions({ start, end, budgetOnly: true }),
    getSpending({ month: m }),
  ]);
  return { month: m, start, end, transactions, summary: spending.current };
}

function buildReportsPayload({ month, monthly, trends, insights, tags, generatedAt = new Date().toISOString() }) {
  const summaryComplete = monthly.summary?.completeness?.complete !== false;
  const merchants = {};
  for (const t of monthly.transactions || []) {
    if (t.amount >= 0) continue;
    const key = t.payee || 'Unknown';
    const cur = merchants[key] || { payee: key, spend: 0, count: 0 };
    cur.spend = round2(cur.spend + Math.abs(t.amount));
    cur.count++;
    merchants[key] = cur;
  }
  const topMerchants = Object.values(merchants).sort((a, b) => b.spend - a.spend).slice(0, 12);
  const totalSpend = summaryComplete ? (monthly.summary?.totalSpend ?? 0) : null;
  const categories = Object.entries(monthly.summary?.spending || {})
    .map(([name, spend]) => ({
      name,
      spend: round2(Number(spend) || 0),
      pct: summaryComplete && totalSpend > 0 ? round2(((Number(spend) || 0) / totalSpend) * 100) : null,
    }))
    .sort((a, b) => b.spend - a.spend);
  return {
    generatedAt,
    month,
    completeness: mergeProjectionCompleteness([
      monthly.summary?.completeness,
      trends?.completeness,
      insights?.completeness,
    ]),
    saved: [
      { id: 'monthly-review', title: 'Monthly review', subtitle: 'Income, spend, top categories, and review tasks' },
      { id: 'merchant-trends', title: 'Merchant trends', subtitle: 'Top merchants for the selected month' },
      { id: 'tag-events', title: 'Tags and events', subtitle: 'Spend grouped by note tags and trips' },
    ],
    monthlyReview: {
      income: summaryComplete ? (monthly.summary?.totalIncome || 0) : null,
      spend: summaryComplete ? (monthly.summary?.totalSpend || 0) : null,
      knownSpendSubtotal: summaryComplete ? undefined : monthly.summary?.knownSpendSubtotal,
      knownIncomeSubtotal: summaryComplete ? undefined : monthly.summary?.knownIncomeSubtotal,
      net: summaryComplete
        ? round2((monthly.summary?.totalIncome || 0) - (monthly.summary?.totalSpend || 0))
        : null,
      completeness: monthly.summary?.completeness,
      transactionCount: monthly.transactions.length,
      largest: insights.largestCharges || [],
      uncategorized: insights.uncategorized || [],
    },
    categoryTrends: categories,
    merchantTrends: topMerchants,
    tagSummary: tags.tags || [],
    cashFlow: trends.months || [],
  };
}

async function getReports({ month } = {}) {
  const m = month || todayYMD().slice(0, 7);
  const [year, monthNumber] = m.split('-').map(Number);
  const reportRange = monthRange(year, monthNumber - 1);
  const [monthly, trends, insights, tags] = await Promise.all([
    getMonthlyReport({ month: m }),
    getTrends({ months: 12, endMonth: m }),
    getInsights({ month: m }),
    getTags({ start: reportRange.start, end: reportRange.end }),
  ]);
  return buildReportsPayload({ month: m, monthly, trends, insights, tags });
}

module.exports = {
  config,
  initApi,
  getHealth,
  withApi,
  runActualRead,
  runActualWrite,
  runActualRecover,
  syncNow,
  bankSync,
  resetApi,
  shutdownApi,
  getAccounts,
  setAccountOverride,
  getManualAssets,
  getInvestments,
  saveManualAsset,
  deleteManualAsset,
  getTransactions,
  createTransaction,
  getSpending,
  getTrends,
  getBudgets,
  setBudgetAmount,
  getReimbursement,
  classifyOwesTruth,
  directReimbursementLegs,
  getOwesConfig,
  setOwesConfig,
  getReimbLinks,
  addReimbLink,
  deleteReimbLink,
  prepareReimbLinkAdmission,
  exportReimbursementLegacyReport,
  getReview,
  setReviewDisposition,
  suggestRepayments,
  confirmRepayment,
  validateRepaymentConfirmationAdmission,
  prepareRepaymentConfirmationAdmission,
  dismissRepayment,
  undismissRepayment,
  getInsights,
  getCategories,
  setTransactionCategory,
  splitTransaction,
  removeSplit,
  sweepReimbursementTags,
  cleanupPhantoms,
  getBulkOperationResult,
  proveBulkOperationJournalCompletion,
  assertBulkOperationJournalAdmission,
  getPhantomLog,
  addReceipt,
  getReceipts,
  getReceiptFile,
  assertReceiptMutationAvailable,
  deleteReceipt,
  decodeImageBase64,
  getReimbursementLedger,
  getReconciliation,
  setReconcileItem,
  setReconcileMonth,
  setReconcileEnabled,
  getReconcilePending,
  getTransactionById,
  SagaInterruption,
  addableTransaction,
  assertReconstructableTransaction,
  assertTransactionDeletionAvailable,
  assertTransactionMutationAvailable,
  assertTransactionReplacementAvailable,
  transactionReplacementMap,
  replaceActualTransaction,
  recoverTransactionDeletionSagas,
  recoverRepaymentConfirmationSagas,
  recoverReimbursementLinkSagas,
  recoverBulkOperationSagas,
  recoverTransactionSagas,
  getMerchantHistory,
  deleteTransaction,
  setPayee,
  getRules,
  getCatalogDisplay,
  getEvents,
  saveEvent,
  deleteEvent,
  reconcileSplits,
  saveRule,
  deleteRule,
  applyRules,
  refileSettleUps,
  validateSplitwiseMirrorSnapshot,
  preflightSplitwiseMirrorShareSync,
  syncSplitwiseShareExpenses,
  getRecurring,
  setRecurringOverride,
  markRecurring,
  getIncome,
  getBills,
  getForecast,
  getToday,
  setBillPaid,
  searchTransactions,
  getTags,
  getMonthlyReport,
  buildReportsPayload,
  getReports,
  setTransactionNotes,
  setTransactionDate,
  getGoals,
  saveGoal,
  deleteGoal,
};

Object.defineProperty(module.exports, 'api', {
  enumerable: true,
  get() {
    if (process.env.ALLOW_RAW_ACTUAL_API === '1') return api;
    throw new Error(
      'Direct data.api access bypasses the Actual coordinator; use runActualRead/runActualWrite or set ALLOW_RAW_ACTUAL_API=1 for tests',
    );
  },
});
