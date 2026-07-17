'use strict';

const { describe, it } = require('node:test');
const assert = require('node:assert/strict');
const {
  buildQueryCacheFingerprint,
  decodeSearchCursor,
  encodeSearchCursor,
  resolveBoundedLedgerStart,
  resolveNetWorthQueryStart,
  resolveSearchWindow,
  validateCanonicalDateRange,
} = require('../lib/bounded-ledger-access');
const { loadQueryScalingConfig } = require('../lib/query-scaling-config');
const { daysBetween } = require('../lib/date-only');
const { QueryRangeExceededError } = require('../lib/errors');

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

  it('round-trips stable search cursors', () => {
    const cursor = encodeSearchCursor({
      start: '2024-01-01',
      end: '2024-03-31',
      offset: 200,
      q: 'coffee',
      limit: 100,
    });
    const decoded = decodeSearchCursor(cursor);
    assert.equal(decoded.start, '2024-01-01');
    assert.equal(decoded.end, '2024-03-31');
    assert.equal(decoded.offset, 200);
    assert.equal(decoded.q, 'coffee');
    assert.equal(decoded.limit, 100);
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
});
