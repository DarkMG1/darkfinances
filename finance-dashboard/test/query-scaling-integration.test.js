'use strict';

const { describe, it, before, after } = require('node:test');
const assert = require('node:assert/strict');
const path = require('node:path');
const {
  fetchAccountTransactionsBounded,
  getActiveQueryStats,
  runWithQueryInstrumentation,
} = require('../lib/bounded-ledger-access');
const { QueryResultLimitExceededError } = require('../lib/errors');

process.env.ACTUAL_API_PATH = path.join(__dirname, 'fixtures', 'query-scaling-actual.js');
process.env.ACTUAL_DATA_DIR = path.join(__dirname, '.tmp-query-scaling-cache');
process.env.ACTUAL_SERVER_URL = 'http://127.0.0.1:1';
process.env.ACTUAL_PASSWORD = 'test';
process.env.ACTUAL_SYNC_ID = 'test-sync';
process.env.FINANCE_TIME_ZONE = 'America/Los_Angeles';
process.env.FINANCE_QUERY_MAX_LEDGER_ROWS = '500000';
process.env.FINANCE_QUERY_MAX_TXN_LIST_ROWS = '500000';
process.env.FINANCE_QUERY_CURSOR_SECRET = 'integration-cursor-secret';

const data = require('../dataModule');
const fixture = require('./fixtures/query-scaling-actual');

describe('query scaling integration', () => {
  before(async () => {
    fixture.reset({ accountCount: 2, rowsPerAccount: 120, yearSpan: 10 });
    await data.initApi({ skipRecover: true });
  });

  after(() => {
    data.resetApi();
    fixture.reset({ accountCount: 2, rowsPerAccount: 0 });
  });

  it('issues one bounded getTransactions call per account for merged spending windows', async () => {
    fixture.reset({ accountCount: 3, rowsPerAccount: 40, yearSpan: 10 });
    await data.resetApi();
    await data.initApi({ skipRecover: true });
    fixture.state.callLog.length = 0;
    let stats;
    await runWithQueryInstrumentation(async () => {
      await data.getSpending({ start: '2024-04-01', end: '2024-04-30' });
      stats = getActiveQueryStats();
    });
    assert.equal(fixture.state.callLog.length, 3);
    assert.equal(stats.getTransactionsCalls, 3);
    assert.equal(stats.accountsQueried, 3);
    for (const call of fixture.state.callLog) {
      assert.equal(call.start, '2024-03-02');
      assert.ok(call.end === '2024-04-30');
    }
  });

  it('preserves small-ledger trends shape with complete net-worth history', async () => {
    process.env.FINANCE_QUERY_MAX_LEDGER_DAYS = '12000';
    fixture.reset({ accountCount: 2, rowsPerAccount: 120, anchorMonth: '2024-06', yearSpan: 10 });
    await data.resetApi();
    await data.initApi({ skipRecover: true });
    const bounded = await data.getTrends({ months: 6, endMonth: '2024-06' });
    assert.equal(bounded.months.length, 6);
    assert.equal(bounded.scope.netWorthHistoryComplete, true);
    assert.ok(bounded.months.every((m) => m.netWorth != null));
    delete process.env.FINANCE_QUERY_MAX_LEDGER_DAYS;
  });

  it('nulls net worth in trends when history is incomplete', async () => {
    process.env.FINANCE_QUERY_MAX_LEDGER_DAYS = '2000';
    fixture.reset({ accountCount: 2, rowsPerAccount: 80, anchorMonth: '2024-06', yearSpan: 10 });
    await data.resetApi();
    await data.initApi({ skipRecover: true });
    const bounded = await data.getTrends({ months: 3, endMonth: '2024-06' });
    assert.equal(bounded.scope.netWorthHistoryComplete, false);
    assert.ok(bounded.months.every((m) => m.netWorth == null));
    delete process.env.FINANCE_QUERY_MAX_LEDGER_DAYS;
  });

  it('paginates search results with signed keyset cursors without duplicates', async () => {
    fixture.reset({ accountCount: 1, rowsPerAccount: 25, anchorMonth: '2024-06', yearSpan: 1 });
    await data.resetApi();
    await data.initApi({ skipRecover: true });
    const first = await data.searchTransactions({ start: '2024-06-01', end: '2024-06-30', limit: 10 });
    assert.equal(first.transactions.length, 10);
    assert.ok(first.pagination.nextCursor);
    const second = await data.searchTransactions({ cursor: first.pagination.nextCursor });
    const ids = new Set(first.transactions.map((t) => t.id));
    for (const row of second.transactions) assert.ok(!ids.has(row.id));
  });

  it('rejects search cursor mutation between pages and query/range mismatches', async () => {
    const { getActualCoordinator } = require('../lib/actual-coordinator');
    fixture.reset({ accountCount: 1, rowsPerAccount: 25, anchorMonth: '2024-06', yearSpan: 1 });
    await data.resetApi();
    await data.initApi({ skipRecover: true });
    const first = await data.searchTransactions({ start: '2024-06-01', end: '2024-06-30', limit: 10 });
    const { QueryRangeExceededError } = require('../lib/errors');
    getActualCoordinator().invalidateGeneration();
    await assert.rejects(
      () => data.searchTransactions({ cursor: first.pagination.nextCursor }),
      QueryRangeExceededError,
    );
    await assert.rejects(
      () => data.searchTransactions({
        cursor: first.pagination.nextCursor,
        start: '2024-06-01',
        end: '2024-06-30',
        q: 'different',
      }),
      QueryRangeExceededError,
    );
  });

  it('rejects oversized row scans with 413 and clears retained batches', async () => {
    process.env.FINANCE_QUERY_MAX_LEDGER_ROWS = '10';
    delete process.env.FINANCE_QUERY_MAX_LEDGER_DAYS;
    fixture.reset({ accountCount: 2, rowsPerAccount: 8, anchorMonth: '2024-06', yearSpan: 1 });
    await data.resetApi();
    await data.initApi({ skipRecover: true });
    let stats;
    await assert.rejects(
      async () => runWithQueryInstrumentation(async (activeStats) => {
        stats = activeStats;
        await data.getTransactions({ start: '2024-01-01', end: '2024-12-31' });
      }),
      QueryResultLimitExceededError,
    );
    assert.ok((stats?.rowsScanned ?? 0) > 10, 'rowsScanned may exceed row cap while scanning chunks');
    assert.ok((stats?.peakRowsRetained ?? 0) <= 10, 'peakRowsRetained must never exceed row cap');
    delete process.env.FINANCE_QUERY_MAX_LEDGER_ROWS;
  });

  it('scales linearly with synthetic 100k+ ledger and bounded windows reduce scanned rows', async () => {
    process.env.FINANCE_QUERY_MAX_LEDGER_ROWS = '500000';
    fixture.reset({ accountCount: 4, rowsPerAccount: 30_000, anchorMonth: '2024-06', yearSpan: 12 });
    await data.resetApi();
    await data.initApi({ skipRecover: true });
    fixture.state.callLog.length = 0;
    let stats;
    await runWithQueryInstrumentation(async () => {
      await data.getTrends({ months: 3, endMonth: '2024-06' });
      stats = getActiveQueryStats();
    });
    assert.equal(stats.getTransactionsCalls, 4);
    assert.ok(stats.rowsScanned < 50_000);
    assert.ok(stats.rowsScanned > 1000);
    for (const call of fixture.state.callLog) {
      assert.ok(call.start >= '2024-04-01');
      assert.ok(call.end <= '2024-06-30');
    }
  });

  it('exposes incomplete reimbursement totals without authoritative owes', async () => {
    process.env.FINANCE_QUERY_MAX_LEDGER_DAYS = '120';
    fixture.reset({ accountCount: 2, rowsPerAccount: 40, anchorMonth: '2024-06', yearSpan: 10 });
    await data.resetApi();
    await data.initApi({ skipRecover: true });
    const reimb = await data.getReimbursement({});
    assert.equal(reimb.totalOwed.complete, false);
    assert.equal(reimb.totalOwed.value, null);
    assert.ok(reimb.totalOwed.lowerBound != null);
    assert.deepEqual(reimb.owes, []);
    delete process.env.FINANCE_QUERY_MAX_LEDGER_DAYS;
    const suggestions = await data.suggestRepayments({ from: '2024-01-01', to: '2024-06-30' });
    assert.equal(suggestions.complete, false);
    assert.deepEqual(suggestions.suggestions, []);
  });
});

describe('fetchAccountTransactionsBounded', () => {
  it('aborts sequential reads when signal aborts mid-fetch', async () => {
    const controller = new AbortController();
    let calls = 0;
    const api = {
      getTransactions: async (accountId) => {
        calls += 1;
        if (calls === 2) controller.abort();
        return [{ id: accountId, date: '2024-01-01', amount: -100 }];
      },
    };
    let stats;
    const batches = await runWithQueryInstrumentation(async () => {
      stats = getActiveQueryStats();
      return fetchAccountTransactionsBounded(api, {
        accounts: [{ id: 'a1' }, { id: 'a2' }, { id: 'a3' }],
        start: '2024-01-01',
        end: '2024-01-31',
        signal: controller.signal,
      });
    }, { signal: controller.signal });
    assert.equal(batches.length, 1);
    assert.equal(stats.aborted, true);
    assert.equal(stats.getTransactionsCalls, 2);
  });
});
