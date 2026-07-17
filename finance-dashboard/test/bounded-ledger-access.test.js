'use strict';

const { describe, it } = require('node:test');
const assert = require('node:assert/strict');
const {
  buildQueryCacheFingerprint,
  decodeSearchCursor,
  encodeSearchCursor,
  enforceRowBudgetOrThrow,
  resolveBoundedLedgerStart,
  resolveCursorSigningSecret,
  assertCursorSigningConfigured,
  resolveNetWorthQueryStart,
  resolveSearchWindow,
  validateCanonicalDateRange,
} = require('../lib/bounded-ledger-access');
const { loadQueryScalingConfig } = require('../lib/query-scaling-config');
const { daysBetween } = require('../lib/date-only');
const {
  QueryCursorSecretError,
  QueryRangeExceededError,
  QueryResultLimitExceededError,
} = require('../lib/errors');

process.env.FINANCE_QUERY_CURSOR_SECRET = 'test-cursor-secret';

describe('bounded ledger access', () => {
  it('validates canonical date ranges and rejects oversized windows', () => {
    const config = loadQueryScalingConfig();
    const range = validateCanonicalDateRange('2024-01-01', '2024-01-31', { config, purpose: 'test' });
    assert.equal(range.start, '2024-01-01');
    assert.equal(range.end, '2024-01-31');
    assert.throws(
      () => validateCanonicalDateRange('2024-01-31', '2024-01-01', { config, purpose: 'test' }),
      QueryRangeExceededError,
    );
    assert.throws(
      () => validateCanonicalDateRange('2000-01-01', '2024-12-31', {
        config: { ...config, maxLedgerQueryDays: 30 },
        purpose: 'test',
        maxSpanDays: 30,
      }),
      QueryRangeExceededError,
    );
  });

  it('separates cache fingerprints for distinct query inputs', () => {
    const a = buildQueryCacheFingerprint({ kind: 'txns', start: '2024-01-01', end: '2024-01-31' });
    const b = buildQueryCacheFingerprint({ kind: 'txns', start: '2024-02-01', end: '2024-02-29' });
    const c = buildQueryCacheFingerprint({ kind: 'txns', start: '2024-01-01', end: '2024-01-31', cursor: 'x' });
    assert.notEqual(a, b);
    assert.notEqual(a, c);
  });

  it('round-trips signed keyset search cursors', () => {
    const cursor = encodeSearchCursor({
      start: '2024-01-01',
      end: '2024-03-31',
      anchorDate: '2024-02-15',
      anchorId: 'tx-99',
      q: 'coffee',
      limit: 100,
      generation: 7,
    });
    const decoded = decodeSearchCursor(cursor, { expectedGeneration: 7 });
    assert.equal(decoded.start, '2024-01-01');
    assert.equal(decoded.end, '2024-03-31');
    assert.equal(decoded.anchorDate, '2024-02-15');
    assert.equal(decoded.anchorId, 'tx-99');
    assert.equal(decoded.q, 'coffee');
    assert.equal(decoded.limit, 100);
    assert.equal(decoded.generation, 7);
  });

  it('rejects tampered search cursors', () => {
    const cursor = encodeSearchCursor({
      start: '2024-01-01',
      end: '2024-03-31',
      anchorDate: '2024-02-15',
      anchorId: 'tx-99',
      q: 'coffee',
      limit: 100,
      generation: 1,
    });
    const tampered = `${cursor}x`;
    assert.throws(() => decodeSearchCursor(tampered), QueryRangeExceededError);
  });

  it('rejects stale generation and mismatched cursor query bindings', () => {
    const cursor = encodeSearchCursor({
      start: '2024-01-01',
      end: '2024-03-31',
      anchorDate: '2024-02-15',
      anchorId: 'tx-99',
      q: 'coffee',
      limit: 100,
      generation: 1,
    });
    assert.throws(
      () => decodeSearchCursor(cursor, { expectedGeneration: 2 }),
      QueryRangeExceededError,
    );
    const decoded = decodeSearchCursor(cursor, { expectedGeneration: 1 });
    assert.equal(decoded.q, 'coffee');
    assert.equal(decoded.start, '2024-01-01');
  });

  it('defaults search windows to configured lookback', () => {
    const config = loadQueryScalingConfig();
    const range = resolveSearchWindow({ end: '2024-06-30', config });
    assert.equal(range.end, '2024-06-30');
    assert.equal(range.spanDays, config.defaultSearchLookbackDays);
  });

  it('marks net worth history incomplete when epoch span exceeds cap', () => {
    const config = loadQueryScalingConfig();
    const complete = resolveNetWorthQueryStart({
      windowStart: '2024-01-01',
      end: '2013-06-01',
      config: { ...config, maxLedgerQueryDays: 5000 },
    });
    assert.equal(complete.complete, true);
    assert.equal(complete.start, '2000-01-01');

    const partial = resolveNetWorthQueryStart({
      windowStart: '2020-01-01',
      end: '2024-12-31',
      config: { ...config, maxLedgerQueryDays: 1000 },
    });
    assert.equal(partial.complete, false);
    assert.equal(partial.start, '2020-01-01');
  });

  it('clamps configured ledger starts when lifetime span exceeds cap', () => {
    const config = loadQueryScalingConfig();
    const complete = resolveBoundedLedgerStart({
      configuredStart: '2024-01-01',
      end: '2024-06-30',
      config: { ...config, maxLedgerQueryDays: 3660 },
    });
    assert.equal(complete.complete, true);
    assert.equal(complete.start, '2024-01-01');

    const partial = resolveBoundedLedgerStart({
      configuredStart: '2000-01-01',
      end: '2026-07-17',
      config: { ...config, maxLedgerQueryDays: 3660 },
    });
    assert.equal(partial.complete, false);
    assert.ok(partial.start > '2000-01-01');
    assert.equal(daysBetween(partial.start, partial.end) + 1, 3660);
  });

  it('isolates query stats across concurrent instrumentation contexts', async () => {
    const { runWithQueryInstrumentation } = require('../lib/bounded-ledger-access');
    const [a, b] = await Promise.all([
      runWithQueryInstrumentation(async (stats) => {
        stats.getTransactionsCalls = 3;
        stats.rowsScanned = 100;
        await new Promise((r) => setTimeout(r, 5));
        return stats.getTransactionsCalls;
      }),
      runWithQueryInstrumentation(async (stats) => {
        stats.getTransactionsCalls = 7;
        return stats.getTransactionsCalls;
      }),
    ]);
    assert.equal(a, 3);
    assert.equal(b, 7);
  });

  it('discards retained batches when row budget would be exceeded', () => {
    const batches = [{ account: { id: 'a1' }, transactions: [{ id: 1 }] }];
    assert.throws(
      () => enforceRowBudgetOrThrow({
        batches,
        totalRowsRetained: 8,
        incomingCount: 5,
        rowCap: 10,
      }),
      QueryResultLimitExceededError,
    );
    assert.equal(batches.length, 0);
  });

  it('rejects production cursor signing when no stable secret is configured', () => {
    const saved = {
      nodeEnv: process.env.NODE_ENV,
      demoOnly: process.env.DEMO_ONLY,
      cursorSecret: process.env.FINANCE_QUERY_CURSOR_SECRET,
      syncId: process.env.ACTUAL_SYNC_ID,
    };
    delete process.env.FINANCE_QUERY_CURSOR_SECRET;
    delete process.env.ACTUAL_SYNC_ID;
    process.env.NODE_ENV = 'production';
    delete process.env.DEMO_ONLY;
    try {
      assert.throws(
        () => resolveCursorSigningSecret(),
        QueryCursorSecretError,
      );
      assert.throws(
        () => assertCursorSigningConfigured(),
        QueryCursorSecretError,
      );
      assert.throws(
        () => encodeSearchCursor({
          start: '2024-01-01',
          end: '2024-01-31',
          q: '',
          limit: 10,
          generation: 1,
        }),
        QueryCursorSecretError,
      );
    } finally {
      process.env.NODE_ENV = saved.nodeEnv;
      if (saved.demoOnly == null) delete process.env.DEMO_ONLY;
      else process.env.DEMO_ONLY = saved.demoOnly;
      if (saved.cursorSecret == null) delete process.env.FINANCE_QUERY_CURSOR_SECRET;
      else process.env.FINANCE_QUERY_CURSOR_SECRET = saved.cursorSecret;
      if (saved.syncId == null) delete process.env.ACTUAL_SYNC_ID;
      else process.env.ACTUAL_SYNC_ID = saved.syncId;
    }
  });

  it('accepts validated ACTUAL_SYNC_ID when explicit cursor secret is absent', () => {
    const saved = {
      cursorSecret: process.env.FINANCE_QUERY_CURSOR_SECRET,
      syncId: process.env.ACTUAL_SYNC_ID,
    };
    delete process.env.FINANCE_QUERY_CURSOR_SECRET;
    process.env.ACTUAL_SYNC_ID = 'stable-sync-id-12345678';
    try {
      assert.equal(resolveCursorSigningSecret(), 'stable-sync-id-12345678');
      const cursor = encodeSearchCursor({
        start: '2024-01-01',
        end: '2024-01-31',
        q: '',
        limit: 10,
        generation: 3,
      });
      assert.equal(decodeSearchCursor(cursor, { expectedGeneration: 3 }).generation, 3);
    } finally {
      if (saved.cursorSecret == null) delete process.env.FINANCE_QUERY_CURSOR_SECRET;
      else process.env.FINANCE_QUERY_CURSOR_SECRET = saved.cursorSecret;
      if (saved.syncId == null) delete process.env.ACTUAL_SYNC_ID;
      else process.env.ACTUAL_SYNC_ID = saved.syncId;
    }
  });

  it('invalidates cursors signed before a secret rotation', () => {
    const saved = process.env.FINANCE_QUERY_CURSOR_SECRET;
    process.env.FINANCE_QUERY_CURSOR_SECRET = 'rotation-secret-a';
    const cursor = encodeSearchCursor({
      start: '2024-01-01',
      end: '2024-01-31',
      q: '',
      limit: 10,
      generation: 1,
    });
    process.env.FINANCE_QUERY_CURSOR_SECRET = 'rotation-secret-b';
    assert.throws(() => decodeSearchCursor(cursor), QueryRangeExceededError);
    process.env.FINANCE_QUERY_CURSOR_SECRET = saved;
  });
});
