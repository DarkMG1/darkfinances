'use strict';

const { describe, it } = require('node:test');
const assert = require('node:assert/strict');
const {
  fetchAccountTransactionsBounded,
  validateCanonicalDateRange,
  splitCalendarChunks,
} = require('../lib/bounded-ledger-access');
const { loadQueryScalingConfig } = require('../lib/query-scaling-config');
const { QueryResultLimitExceededError } = require('../lib/query-errors');

describe('actual-tools bounded ledger access', () => {
  it('does not require finance-dashboard at runtime', () => {
    const text = require('fs').readFileSync(require('path').join(__dirname, '../lib/bounded-ledger-access.js'), 'utf8');
    assert.ok(!text.includes("require('../finance-dashboard"));
    assert.ok(!text.includes("require('../../finance-dashboard"));
  });

  it('chunks wide ranges for sequential fetches', () => {
    const chunks = splitCalendarChunks('2024-01-01', '2024-03-15', 31);
    assert.ok(chunks.length >= 2);
  });

  it('enforces row budget before retaining additional account batches', async () => {
    const api = {
      getTransactions: async (accountId) => Array.from({ length: 5 }, (_, i) => ({
        id: `${accountId}-${i}`,
        date: '2024-01-01',
        amount: -100,
      })),
    };
    await assert.rejects(
      () => fetchAccountTransactionsBounded(api, {
        accounts: [{ id: 'a1' }, { id: 'a2' }, { id: 'a3' }],
        start: '2024-01-01',
        end: '2024-01-31',
        maxRows: 10,
        config: loadQueryScalingConfig(),
      }),
      QueryResultLimitExceededError,
    );
  });

  it('validates canonical ranges', () => {
    const config = loadQueryScalingConfig();
    const range = validateCanonicalDateRange('2024-01-01', '2024-01-31', { config, purpose: 'test' });
    assert.equal(range.start, '2024-01-01');
  });
});
