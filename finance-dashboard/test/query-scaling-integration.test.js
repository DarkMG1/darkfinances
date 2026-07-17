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

const data = require('../dataModule');
const fixture = require('./fixtures/query-scaling-actual');

describe('query scaling integration', () => {
  before(async () => {
    fixture.reset({ accountCount: 2, rowsPerAccount: 120 });
    await data.initApi({ skipRecover: true });
  });

  after(() => {
    data.resetApi();
    fixture.reset({ accountCount: 2, rowsPerAccount: 0 });
  });

  it('issues one bounded getTransactions call per account with exact date bounds', async () => {
    fixture.reset({ accountCount: 3, rowsPerAccount: 40 });
    await data.resetApi();
    await data.initApi({ skipRecover: true });
    fixture.state.callLog.length = 0;
    let stats;
    await runWithQueryInstrumentation(async () => {
      await data.getSpending({ start: '2024-04-01', end: '2024-04-30' });
      stats = getActiveQueryStats();
    });
    assert.equal(fixture.state.callLog.length, 6);
    const starts = new Set(fixture.state.callLog.map((call) => call.start));
    assert.deepEqual(starts, new Set(['2024-04-01', '2024-03-02']));
    for (const call of fixture.state.callLog) {
      assert.ok(call.end === '2024-04-30' || call.end === '2024-03-31');
    }
    assert.equal(stats.getTransactionsCalls, 6);
    assert.equal(stats.accountsQueried, 6);
  });

  it('preserves small-ledger trends shape with complete net-worth history', async () => {
    process.env.FINANCE_QUERY_MAX_LEDGER_DAYS = '12000';
    fixture.reset({ accountCount: 2, rowsPerAccount: 120, anchorMonth: '2024-06' });
    await data.resetApi();
    await data.initApi({ skipRecover: true });
    fixture.state.callLog.length = 0;
    const bounded = await data.getTrends({ months: 6, endMonth: '2024-06' });
    assert.equal(bounded.months.length, 6);
    assert.equal(bounded.scope.netWorthHistoryComplete, true);
    assert.equal(bounded.scope.queriedFrom, '2000-01-01');
    assert.ok(fixture.state.callLog.every((call) => call.start === '2000-01-01'));
    delete process.env.FINANCE_QUERY_MAX_LEDGER_DAYS;
  });

  it('paginates search results without duplicates', async () => {
    fixture.reset({ accountCount: 1, rowsPerAccount: 25, anchorMonth: '2024-06' });
    await data.resetApi();
    await data.initApi({ skipRecover: true });
    const first = await data.searchTransactions({ start: '2024-06-01', end: '2024-06-30', limit: 10 });
    assert.equal(first.transactions.length, 10);
    assert.ok(first.pagination.nextCursor);
    const second = await data.searchTransactions({ cursor: first.pagination.nextCursor });
    const ids = new Set(first.transactions.map((t) => t.id));
    for (const row of second.transactions) assert.ok(!ids.has(row.id));
  });

  it('rejects oversized row scans with 413', async () => {
    process.env.FINANCE_QUERY_MAX_LEDGER_ROWS = '10';
    fixture.reset({ accountCount: 2, rowsPerAccount: 20, anchorMonth: '2024-06' });
    await data.resetApi();
    await data.initApi({ skipRecover: true });
    await assert.rejects(
      () => data.getTransactions({ start: '2024-01-01', end: '2024-12-31' }),
      QueryResultLimitExceededError,
    );
    delete process.env.FINANCE_QUERY_MAX_LEDGER_ROWS;
  });

  it('scales linearly with synthetic 100k+ ledger using operation counters', async () => {
    process.env.FINANCE_QUERY_MAX_LEDGER_ROWS = '500000';
    fixture.reset({ accountCount: 4, rowsPerAccount: 30_000, anchorMonth: '2024-06' });
    await data.resetApi();
    await data.initApi({ skipRecover: true });
    fixture.state.callLog.length = 0;
    let stats;
    await runWithQueryInstrumentation(async () => {
      await data.getTrends({ months: 3, endMonth: '2024-06' });
      stats = getActiveQueryStats();
    });
    assert.equal(stats.getTransactionsCalls, 4);
    assert.ok(stats.rowsScanned <= 130_000);
    assert.ok(stats.rowsScanned >= 100_000);
    for (const call of fixture.state.callLog) {
      assert.ok(call.start >= '2024-04-01');
      assert.ok(call.end <= '2024-06-30');
    }
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
    assert.equal(batches.length, 2);
    assert.equal(stats.aborted, true);
    assert.equal(stats.getTransactionsCalls, 2);
  });
});
