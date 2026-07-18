'use strict';
/* VENDORED from finance-dashboard/lib/bounded-ledger-access.js
 * Regenerate: node finance-dashboard/scripts/sync-bounded-ledger-vendor.js
 * Source sha256: e0fa02868d282329e7035c182782d805fd5233afb8273939d25b76e518ee2a0f
 * Standalone for actual-tools — must not require finance-dashboard at runtime.
 */

const crypto = require('crypto');
const { AsyncLocalStorage } = require('async_hooks');
const { addDays, daysBetween, todayYMD } = require('./date-only');
const {
  LEDGER_EPOCH,
  loadQueryScalingConfig,
} = require('./query-scaling-config');
const {
  QueryAbortedError,
  QueryCursorSecretError,
  QueryRangeExceededError,
  QueryResultLimitExceededError,
} = require('./query-errors');

const SEARCH_CURSOR_VERSION = 2;
const DEV_CURSOR_FALLBACK = 'finance-query-cursor-dev-only';
const instrumentationStore = new AsyncLocalStorage();
const DATE_RE = /^\d{4}-\d{2}-\d{2}$/;

function isValidStableCursorSecret(value) {
  const text = String(value || '').trim();
  return text.length >= 8 && text !== DEV_CURSOR_FALLBACK;
}

function allowsDevCursorFallback({ allowDevFallback } = {}) {
  if (allowDevFallback === true) return true;
  if (process.env.NODE_ENV === 'test') return true;
  if (process.env.DEMO_ONLY === '1') return true;
  return false;
}

function resolveCursorSigningSecret({ allowDevFallback } = {}) {
  const explicit = String(process.env.FINANCE_QUERY_CURSOR_SECRET || '').trim();
  if (explicit) return explicit;
  const syncId = String(process.env.ACTUAL_SYNC_ID || '').trim();
  if (isValidStableCursorSecret(syncId)) return syncId;
  if (allowsDevCursorFallback({ allowDevFallback })) return DEV_CURSOR_FALLBACK;
  throw new QueryCursorSecretError(
    'Query cursor signing requires FINANCE_QUERY_CURSOR_SECRET or a validated ACTUAL_SYNC_ID',
  );
}

function assertCursorSigningConfigured({ allowDevFallback } = {}) {
  resolveCursorSigningSecret({ allowDevFallback });
}

function createQueryStats() {
  return {
    accountsQueried: 0,
    getTransactionsCalls: 0,
    rowsScanned: 0,
    rowsReturned: 0,
    peakRowsRetained: 0,
    elapsedMs: 0,
    budgetExhausted: false,
    aborted: false,
  };
}

function getActiveQueryStats() {
  return instrumentationStore.getStore()?.stats ?? null;
}

function getActiveQueryAbortSignal() {
  return instrumentationStore.getStore()?.signal ?? null;
}

function runWithQueryInstrumentation(fn, { budgetMs, signal } = {}) {
  const stats = createQueryStats();
  const started = Date.now();
  const config = loadQueryScalingConfig();
  const effectiveBudget = budgetMs ?? config.queryBudgetMs;
  return instrumentationStore.run({ stats, signal, budgetMs: effectiveBudget }, async () => {
    try {
      return await fn(stats);
    } finally {
      stats.elapsedMs = Date.now() - started;
      if (effectiveBudget != null && stats.elapsedMs > effectiveBudget) stats.budgetExhausted = true;
    }
  });
}

function attachQueryStatsHeaders(res, stats) {
  if (!res || !stats) return;
  res.setHeader('X-Finance-Query-Accounts', String(stats.accountsQueried || 0));
  res.setHeader('X-Finance-Query-Calls', String(stats.getTransactionsCalls || 0));
  res.setHeader('X-Finance-Query-Rows-Scanned', String(stats.rowsScanned || 0));
  res.setHeader('X-Finance-Query-Rows-Returned', String(stats.rowsReturned || 0));
  res.setHeader('X-Finance-Query-Peak-Retained', String(stats.peakRowsRetained || 0));
  res.setHeader('X-Finance-Query-Elapsed-Ms', String(stats.elapsedMs || 0));
  if (stats.budgetExhausted) res.setHeader('X-Finance-Query-Budget-Exhausted', '1');
  if (stats.aborted) res.setHeader('X-Finance-Query-Aborted', '1');
}

function assertCanonicalDate(value, fieldName) {
  const text = String(value || '');
  if (!DATE_RE.test(text)) {
    throw new QueryRangeExceededError(`${fieldName} must be a canonical YYYY-MM-DD date`);
  }
  const [year, month, day] = text.split('-').map(Number);
  const probe = new Date(Date.UTC(year, month - 1, day));
  if (
    probe.getUTCFullYear() !== year ||
    probe.getUTCMonth() !== month - 1 ||
    probe.getUTCDate() !== day
  ) {
    throw new QueryRangeExceededError(`${fieldName} is not a valid calendar date`);
  }
  return text;
}

function validateCanonicalDateRange(start, end, {
  config = loadQueryScalingConfig(),
  purpose = 'ledger query',
  maxSpanDays = config.maxLedgerQueryDays,
  allowOpenEnd = false,
} = {}) {
  if (start == null && end == null) {
    throw new QueryRangeExceededError(`${purpose} requires a bounded start and end date`);
  }
  const startDate = start == null ? LEDGER_EPOCH : assertCanonicalDate(start, 'start');
  let endDate = end == null ? (allowOpenEnd ? todayYMD() : todayYMD()) : assertCanonicalDate(end, 'end');
  if (!allowOpenEnd && end == null) endDate = todayYMD();
  if (startDate > endDate) {
    throw new QueryRangeExceededError(`${purpose} start must be on or before end`);
  }
  const spanDays = daysBetween(startDate, endDate) + 1;
  if (spanDays > maxSpanDays) {
    throw new QueryRangeExceededError(
      `${purpose} range of ${spanDays} days exceeds the maximum of ${maxSpanDays} days`,
    );
  }
  return { start: startDate, end: endDate, spanDays };
}

function resolveNetWorthQueryStart({ windowStart, end, config = loadQueryScalingConfig() } = {}) {
  const epochSpan = daysBetween(LEDGER_EPOCH, end) + 1;
  if (epochSpan <= config.maxLedgerQueryDays) {
    return { start: LEDGER_EPOCH, complete: true };
  }
  return { start: windowStart, complete: false };
}

function resolveBoundedLedgerStart({
  configuredStart,
  end,
  config = loadQueryScalingConfig(),
} = {}) {
  const start = configuredStart || LEDGER_EPOCH;
  const endDate = end || todayYMD();
  const spanDays = daysBetween(start, endDate) + 1;
  if (spanDays <= config.maxLedgerQueryDays) {
    return { start, end: endDate, complete: true, configuredStart: start };
  }
  const boundedStart = addDays(endDate, -(config.maxLedgerQueryDays - 1));
  const effectiveStart = boundedStart > start ? boundedStart : start;
  return {
    start: effectiveStart,
    end: endDate,
    complete: effectiveStart <= start,
    configuredStart: start,
  };
}

function splitCalendarChunks(start, end, chunkDays) {
  const chunks = [];
  let cursor = start;
  while (cursor <= end) {
    const chunkEnd = addDays(cursor, chunkDays - 1);
    chunks.push({ start: cursor, end: chunkEnd > end ? end : chunkEnd });
    cursor = addDays(chunks[chunks.length - 1].end, 1);
  }
  return chunks;
}

function signSearchCursorPayload(payload) {
  const body = JSON.stringify(payload);
  const signature = crypto.createHmac('sha256', resolveCursorSigningSecret()).update(body).digest('base64url');
  return Buffer.from(JSON.stringify({ payload, signature }), 'utf8').toString('base64url');
}

function verifySearchCursorPayload(token) {
  let envelope;
  try {
    envelope = JSON.parse(Buffer.from(String(token), 'base64url').toString('utf8'));
  } catch (_) {
    throw new QueryRangeExceededError('search cursor is invalid');
  }
  if (!envelope?.payload || !envelope.signature) {
    throw new QueryRangeExceededError('search cursor is invalid');
  }
  const body = JSON.stringify(envelope.payload);
  const expected = crypto.createHmac('sha256', resolveCursorSigningSecret()).update(body).digest('base64url');
  if (envelope.signature !== expected) {
    throw new QueryRangeExceededError('search cursor signature is invalid');
  }
  return envelope.payload;
}

async function loadLedgerReadContext(api, {
  accountFilter,
  includeClosed = true,
} = {}) {
  const accountsRaw = await api.getAccounts();
  let accounts = accountsRaw;
  if (typeof accountFilter === 'function') accounts = accounts.filter(accountFilter);
  else if (!includeClosed) accounts = accounts.filter((a) => !a.closed);
  return { accounts, accountsRaw };
}

function normalizePayeeKey(name) {
  return String(name || '').toLowerCase().replace(/[^a-z0-9]+/g, '');
}

function buildClearedSupersederIndex(clearedByAccountId, nameOf) {
  const index = new Map();
  for (const [accountId, transactions] of clearedByAccountId.entries()) {
    const buckets = new Map();
    for (const txn of transactions) {
      const key = normalizePayeeKey(nameOf(txn));
      if (!key || key.length < 3) continue;
      const list = buckets.get(key) || [];
      list.push(txn);
      buckets.set(key, list);
    }
    index.set(String(accountId), buckets);
  }
  return index;
}

function findSupersedingCleared({ pending, clearedIndex, nameOf, payeeName, amountCents }) {
  const key = normalizePayeeKey(payeeName || nameOf(pending));
  if (!key) return null;
  const buckets = clearedIndex.get(String(pending.accountId || pending._accountId || ''));
  if (!buckets) return null;
  const magP = Math.abs(Number(amountCents) || 0);
  const loDate = addDays(String(pending.date).slice(0, 10), -1);
  const candidates = [];
  for (const [bucketKey, list] of buckets.entries()) {
    if (bucketKey.includes(key) || key.includes(bucketKey)) candidates.push(...list);
  }
  for (const candidate of candidates) {
    if (String(candidate.id) === String(pending.id)) continue;
    const magQ = Math.abs(Number(candidate.amount) || 0);
    const near = Math.abs(magQ - magP) <= Math.max(200, magP * 0.30);
    if (near && candidate.date >= loDate) return candidate;
  }
  return null;
}

function noteRowsRetained(stats, totalRowsRetained) {
  if (!stats) return;
  stats.peakRowsRetained = Math.max(stats.peakRowsRetained || 0, totalRowsRetained);
}

function discardRetainedBatches(batches) {
  batches.length = 0;
}

function throwIfQueryAborted({ stats, batches, effectiveSignal, phase } = {}) {
  if (!effectiveSignal?.aborted) return;
  discardRetainedBatches(batches);
  if (stats) {
    stats.aborted = true;
    stats.rowsReturned = 0;
    stats.peakRowsRetained = 0;
  }
  recordQueryAbortSentinel(phase);
  const detail = phase ? ` (${phase})` : '';
  throw new QueryAbortedError(`Ledger query was aborted${detail}`);
}

function recordQueryAbortSentinel(phase) {
  try {
    require('./query-abort-sentinel').recordQueryAbort(phase);
  } catch (_) { /* optional test sentinel */ }
}

function enforceRowBudgetOrThrow({
  stats,
  batches,
  totalRowsRetained,
  incomingCount,
  rowCap,
}) {
  if (totalRowsRetained + incomingCount <= rowCap) return;
  discardRetainedBatches(batches);
  if (stats) noteRowsRetained(stats, 0);
  throw new QueryResultLimitExceededError(
    `Ledger read would retain ${totalRowsRetained + incomingCount} rows, exceeding the maximum of ${rowCap}`,
  );
}

async function fetchAccountTransactionsBounded(api, {
  accounts,
  start,
  end,
  maxRows,
  config = loadQueryScalingConfig(),
  signal,
} = {}) {
  const stats = getActiveQueryStats();
  const effectiveSignal = signal || getActiveQueryAbortSignal();
  const rowCap = maxRows ?? config.maxLedgerRowsPerRead;
  const chunkDays = config.ledgerChunkDays;
  const spanDays = daysBetween(start, end) + 1;
  const chunks = spanDays <= chunkDays
    ? [{ start, end }]
    : splitCalendarChunks(start, end, chunkDays);
  const batches = [];
  let totalRowsRetained = 0;

  for (const account of accounts) {
    throwIfQueryAborted({ stats, batches, effectiveSignal, phase: 'before account fetch' });
    const accountTxns = [];
    for (const chunk of chunks) {
      throwIfQueryAborted({ stats, batches, effectiveSignal, phase: 'before chunk fetch' });
      const txns = await api.getTransactions(account.id, chunk.start, chunk.end);
      if (stats) {
        stats.getTransactionsCalls += 1;
        stats.rowsScanned += txns.length;
      }
      throwIfQueryAborted({ stats, batches, effectiveSignal, phase: 'after in-flight fetch' });
      enforceRowBudgetOrThrow({
        stats,
        batches,
        totalRowsRetained,
        incomingCount: txns.length,
        rowCap,
      });
      accountTxns.push(...txns);
      totalRowsRetained += txns.length;
      noteRowsRetained(stats, totalRowsRetained);
    }
    throwIfQueryAborted({ stats, batches, effectiveSignal, phase: 'before retaining account batch' });
    batches.push({ account, transactions: accountTxns });
    if (stats) stats.accountsQueried += 1;
  }

  if (stats) stats.rowsReturned = totalRowsRetained;
  return batches;
}

function flattenAccountTransactions(batches) {
  const out = [];
  for (const { account, transactions } of batches) {
    for (const txn of transactions) out.push({ account, transaction: txn });
  }
  return out;
}

function indexTransactionsById(batches) {
  const byId = new Map();
  for (const { account, transactions } of batches) {
    for (const txn of transactions) {
      byId.set(String(txn.id), { account, transaction: txn });
      for (const sub of txn.subtransactions || []) {
        if (sub?.id != null) byId.set(String(sub.id), { account, transaction: txn, leg: sub });
      }
    }
  }
  return byId;
}

function buildQueryCacheFingerprint(parts) {
  return crypto.createHash('sha256').update(JSON.stringify(parts)).digest('hex').slice(0, 32);
}

function encodeSearchCursor(payload) {
  return signSearchCursorPayload({ v: SEARCH_CURSOR_VERSION, ...payload });
}

function decodeSearchCursor(cursor, {
  config = loadQueryScalingConfig(),
  expectedGeneration = null,
} = {}) {
  if (!cursor) return null;
  const parsed = verifySearchCursorPayload(cursor);
  if (!parsed || parsed.v !== SEARCH_CURSOR_VERSION) {
    throw new QueryRangeExceededError('search cursor is unsupported');
  }
  const range = validateCanonicalDateRange(parsed.start, parsed.end, {
    config,
    purpose: 'search cursor',
    maxSpanDays: config.maxSearchRangeDays,
  });
  const limit = Number.parseInt(String(parsed.limit || 200), 10);
  if (!Number.isFinite(limit) || limit < 1 || limit > config.maxSearchLimit) {
    throw new QueryRangeExceededError('search cursor limit is invalid');
  }
  if (expectedGeneration != null && Number(parsed.generation) !== Number(expectedGeneration)) {
    throw new QueryRangeExceededError('search cursor generation is stale');
  }
  const anchorDate = parsed.anchorDate ? assertCanonicalDate(parsed.anchorDate, 'cursor anchorDate') : null;
  const anchorId = parsed.anchorId != null ? String(parsed.anchorId) : null;
  if ((anchorDate && !anchorId) || (!anchorDate && anchorId)) {
    throw new QueryRangeExceededError('search cursor anchor is invalid');
  }
  return {
    ...range,
    limit,
    q: String(parsed.q || ''),
    anchorDate,
    anchorId,
    generation: parsed.generation == null ? null : Number(parsed.generation),
  };
}

function resolveSearchWindow({ start, end, config = loadQueryScalingConfig() } = {}) {
  const today = todayYMD();
  const endDate = end ? assertCanonicalDate(end, 'end') : today;
  const startDate = start
    ? assertCanonicalDate(start, 'start')
    : addDays(endDate, -(config.defaultSearchLookbackDays - 1));
  return validateCanonicalDateRange(startDate, endDate, {
    config,
    purpose: 'transaction search',
    maxSpanDays: config.maxSearchRangeDays,
  });
}

function compareSearchRowsDesc(a, b) {
  const byDate = String(b.date).localeCompare(String(a.date));
  if (byDate !== 0) return byDate;
  return String(b.id).localeCompare(String(a.id));
}

function rowBeforeSearchAnchor(row, anchorDate, anchorId) {
  if (!anchorDate || !anchorId) return true;
  const byDate = String(row.date).localeCompare(String(anchorDate));
  if (byDate < 0) return true;
  if (byDate > 0) return false;
  return String(row.id).localeCompare(String(anchorId)) < 0;
}

module.exports = {
  DEV_CURSOR_FALLBACK,
  LEDGER_EPOCH,
  SEARCH_CURSOR_VERSION,
  assertCanonicalDate,
  assertCursorSigningConfigured,
  attachQueryStatsHeaders,
  buildClearedSupersederIndex,
  buildQueryCacheFingerprint,
  compareSearchRowsDesc,
  createQueryStats,
  decodeSearchCursor,
  discardRetainedBatches,
  encodeSearchCursor,
  enforceRowBudgetOrThrow,
  fetchAccountTransactionsBounded,
  throwIfQueryAborted,
  findSupersedingCleared,
  flattenAccountTransactions,
  getActiveQueryAbortSignal,
  getActiveQueryStats,
  indexTransactionsById,
  loadLedgerReadContext,
  normalizePayeeKey,
  resolveBoundedLedgerStart,
  resolveCursorSigningSecret,
  resolveNetWorthQueryStart,
  resolveSearchWindow,
  rowBeforeSearchAnchor,
  runWithQueryInstrumentation,
  splitCalendarChunks,
  validateCanonicalDateRange,
};
