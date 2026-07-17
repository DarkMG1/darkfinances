'use strict';

const { todayYMD } = require('./date-only');

const LEDGER_EPOCH = '2000-01-01';
const DEFAULTS = Object.freeze({
  maxLedgerQueryDays: 3660,
  maxLedgerRowsPerRead: 100_000,
  ledgerChunkDays: 31,
  queryBudgetMs: 120_000,
});

function loadQueryScalingConfig(env = process.env) {
  const config = { ...DEFAULTS, ledgerEpoch: LEDGER_EPOCH, financeToday: todayYMD() };
  for (const [field, envName] of Object.entries({
    maxLedgerQueryDays: 'FINANCE_QUERY_MAX_LEDGER_DAYS',
    maxLedgerRowsPerRead: 'FINANCE_QUERY_MAX_LEDGER_ROWS',
    ledgerChunkDays: 'FINANCE_QUERY_LEDGER_CHUNK_DAYS',
  })) {
    const raw = env[envName];
    if (raw == null || raw === '') continue;
    const parsed = Number.parseInt(String(raw), 10);
    if (Number.isFinite(parsed) && parsed > 0) config[field] = parsed;
  }
  return Object.freeze(config);
}

module.exports = { DEFAULTS, LEDGER_EPOCH, loadQueryScalingConfig };
