'use strict';

const fs = require('fs');
const path = require('path');
const { startEphemeralDashboardServer } = require('./ephemeral-dashboard-server');

const FIXTURE_PATH = path.join(__dirname, '..', 'fixtures', 'query-scaling-actual.js');

function queryScalingPreloadBody({ accountCount, rowsPerAccount }) {
  return `
    const fixture = require(${JSON.stringify(FIXTURE_PATH)});
    fixture.reset({ accountCount: ${accountCount}, rowsPerAccount: ${rowsPerAccount}, anchorMonth: '2024-06', yearSpan: 1 });
  `;
}

function queryScalingExtraEnvForDir(dir, {
  fetchDelayMs = 0,
  accountCount = 2,
  rowsPerAccount = 8,
  barrierDir = null,
  eventsSeed = null,
} = {}) {
  if (eventsSeed) {
    fs.writeFileSync(path.join(dir, 'events.json'), JSON.stringify(eventsSeed));
  }
  return {
    FINANCE_QUERY_CURSOR_SECRET: 'server-test-cursor-secret',
    ACTUAL_API_PATH: FIXTURE_PATH,
    ACTUAL_DATA_DIR: path.join(dir, 'actual-cache'),
    ACTUAL_SERVER_URL: 'http://127.0.0.1:1',
    ACTUAL_PASSWORD: 'test',
    ACTUAL_SYNC_ID: 'test-sync-id',
    FINANCE_TIME_ZONE: 'America/Los_Angeles',
    FINANCE_QUERY_MAX_LEDGER_ROWS: '500000',
    FINANCE_QUERY_MAX_TXN_LIST_ROWS: '500000',
    EVENTS_PATH: path.join(dir, 'events.json'),
    FINANCE_QUERY_TEST_FETCH_DELAY_MS: String(fetchDelayMs),
    FINANCE_QUERY_TEST_ACCOUNT_COUNT: String(accountCount),
    FINANCE_QUERY_TEST_ROWS_PER_ACCOUNT: String(rowsPerAccount),
    ...(barrierDir ? { FINANCE_QUERY_TEST_BARRIER_DIR: barrierDir } : {}),
  };
}

async function startQueryScalingServer(t, {
  preloadBody,
  accountCount = 2,
  rowsPerAccount = 8,
  fetchDelayMs = 0,
  eventsSeed = null,
  barrierDir = null,
  tempPrefix = 'darkfinances-query-scaling-',
} = {}) {
  const started = await startEphemeralDashboardServer(t, {
    tempPrefix,
    preloadFileName: 'seed-query-scaling-fixture.js',
    preloadBody: preloadBody || queryScalingPreloadBody({ accountCount, rowsPerAccount }),
    extraEnvForDir: (dir) => queryScalingExtraEnvForDir(dir, {
      fetchDelayMs,
      accountCount,
      rowsPerAccount,
      barrierDir,
      eventsSeed,
    }),
  });
  return {
    ...started,
    headers: { 'X-Finance-Token': 'test-api-token' },
  };
}

module.exports = {
  FIXTURE_PATH,
  queryScalingExtraEnvForDir,
  queryScalingPreloadBody,
  startQueryScalingServer,
};
