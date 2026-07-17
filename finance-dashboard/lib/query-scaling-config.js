'use strict';

const { todayYMD } = require('./date-only');

const LEDGER_EPOCH = '2000-01-01';

const DEFAULTS = Object.freeze({
  maxLedgerQueryDays: 3660,
  maxLedgerRowsPerRead: 100_000,
  maxTransactionListRows: 10_000,
  maxSearchLimit: 500,
  maxSearchRangeDays: 1095,
  defaultSearchLookbackDays: 1095,
  maxTagsRangeDays: 1095,
  maxTrendsMonths: 60,
  maxRecurringWindowMonths: 36,
  maxMerchantHistoryMonths: 60,
  maxEventsTagLookbackDays: 400,
  queryBudgetMs: 120_000,
});

const INT_FIELDS = [
  'maxLedgerQueryDays',
  'maxLedgerRowsPerRead',
  'maxTransactionListRows',
  'maxSearchLimit',
  'maxSearchRangeDays',
  'defaultSearchLookbackDays',
  'maxTagsRangeDays',
  'maxTrendsMonths',
  'maxRecurringWindowMonths',
  'maxMerchantHistoryMonths',
  'maxEventsTagLookbackDays',
  'queryBudgetMs',
];

const ENV_MAP = Object.freeze({
  maxLedgerQueryDays: 'FINANCE_QUERY_MAX_LEDGER_DAYS',
  maxLedgerRowsPerRead: 'FINANCE_QUERY_MAX_LEDGER_ROWS',
  maxTransactionListRows: 'FINANCE_QUERY_MAX_TXN_LIST_ROWS',
  maxSearchLimit: 'FINANCE_QUERY_MAX_SEARCH_LIMIT',
  maxSearchRangeDays: 'FINANCE_QUERY_MAX_SEARCH_RANGE_DAYS',
  defaultSearchLookbackDays: 'FINANCE_QUERY_DEFAULT_SEARCH_LOOKBACK_DAYS',
  maxTagsRangeDays: 'FINANCE_QUERY_MAX_TAGS_RANGE_DAYS',
  maxTrendsMonths: 'FINANCE_QUERY_MAX_TRENDS_MONTHS',
  maxRecurringWindowMonths: 'FINANCE_QUERY_MAX_RECURRING_WINDOW_MONTHS',
  maxMerchantHistoryMonths: 'FINANCE_QUERY_MAX_MERCHANT_HISTORY_MONTHS',
  maxEventsTagLookbackDays: 'FINANCE_QUERY_MAX_EVENTS_TAG_LOOKBACK_DAYS',
  queryBudgetMs: 'FINANCE_QUERY_BUDGET_MS',
});

function parsePositiveInt(raw, fieldName) {
  if (raw == null || raw === '') return null;
  const parsed = Number.parseInt(String(raw), 10);
  if (!Number.isFinite(parsed) || parsed < 1) {
    throw new Error(`${fieldName} must be a positive integer`);
  }
  return parsed;
}

function validateConfig(config) {
  if (config.maxSearchLimit > config.maxTransactionListRows) {
    throw new Error('maxSearchLimit cannot exceed maxTransactionListRows');
  }
  if (config.defaultSearchLookbackDays > config.maxSearchRangeDays) {
    throw new Error('defaultSearchLookbackDays cannot exceed maxSearchRangeDays');
  }
  return config;
}

function loadQueryScalingConfig(env = process.env) {
  const config = { ...DEFAULTS, ledgerEpoch: LEDGER_EPOCH, financeToday: todayYMD() };
  for (const field of INT_FIELDS) {
    const parsed = parsePositiveInt(env[ENV_MAP[field]], ENV_MAP[field]);
    if (parsed != null) config[field] = parsed;
  }
  return validateConfig(Object.freeze(config));
}

module.exports = {
  DEFAULTS,
  ENV_MAP,
  LEDGER_EPOCH,
  loadQueryScalingConfig,
  validateConfig,
};
