#!/usr/bin/env node
'use strict';

const path = require('node:path');
const process = require('node:process');

process.env.ACTUAL_API_PATH = path.join(__dirname, '../test/fixtures/query-scaling-actual.js');
process.env.ACTUAL_DATA_DIR = path.join(__dirname, '../test/.tmp-benchmark-cache');
process.env.ACTUAL_SERVER_URL = 'http://127.0.0.1:1';
process.env.ACTUAL_PASSWORD = 'bench';
process.env.ACTUAL_SYNC_ID = 'bench';
process.env.FINANCE_TIME_ZONE = 'America/Los_Angeles';
process.env.FINANCE_QUERY_MAX_LEDGER_ROWS = '500000';
process.env.FINANCE_QUERY_MAX_TXN_LIST_ROWS = '500000';

const fixture = require('../test/fixtures/query-scaling-actual');
const data = require('../dataModule');
const { getActiveQueryStats, runWithQueryInstrumentation } = require('../lib/bounded-ledger-access');

async function bench(label, fn) {
  fixture.state.callLog.length = 0;
  let stats;
  const started = Date.now();
  await runWithQueryInstrumentation(async () => {
    await fn();
    stats = getActiveQueryStats();
  });
  const elapsedMs = Date.now() - started;
  console.log(JSON.stringify({
    label,
    elapsedMs,
    getTransactionsCalls: stats.getTransactionsCalls,
    accountsQueried: stats.accountsQueried,
    rowsScanned: stats.rowsScanned,
    rowsReturned: stats.rowsReturned,
    callBounds: fixture.state.callLog.slice(0, 3),
    totalCalls: fixture.state.callLog.length,
  }, null, 2));
}

(async () => {
  fixture.reset({ accountCount: 4, rowsPerAccount: 30_000, anchorMonth: '2024-06' });
  await data.initApi({ skipRecover: true });
  await bench('trends-3mo', () => data.getTrends({ months: 3, endMonth: '2024-06' }));
  await bench('spending-april', () => data.getSpending({ start: '2024-04-01', end: '2024-04-30' }));
  await bench('search-june-page', () => data.searchTransactions({
    start: '2024-06-01',
    end: '2024-06-30',
    limit: 100,
  }));
  data.resetApi();
})().catch((error) => {
  console.error(error);
  process.exit(1);
});
