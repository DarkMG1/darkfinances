'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');

const { PROVENANCE, TRANSFER_REASON, buildCategoryInfo, buildTransferIndex, classifyTransactionLeaves } = require('../lib/domain/classification');
const {
  PROJECTION_INCOMPLETE_REASON,
  mergeProjectionCompleteness,
  projectionCompletenessFromLeaves,
  spendSummaryFromClassifiedLeaves,
} = require('../lib/domain/projection-completeness');

const catInfo = buildCategoryInfo([
  { name: 'Income', is_income: true, categories: [{ id: 'salary', name: 'Salary' }] },
  { name: 'Money Movement', categories: [{ id: 'transfer', name: 'Transfer' }] },
  { name: 'Spending', categories: [{ id: 'food', name: 'Food' }] },
], {
  incomeGroup: /^income$/i,
  moneyMovementGroup: /money movement/i,
  moneyMovementCategory: /^transfer$/i,
  reimbursementCategory: /^reimbursement$/i,
});

function classifyRows(rows) {
  const index = buildTransferIndex(rows);
  return rows.flatMap((row) => classifyTransactionLeaves(row.transaction, catInfo, {
    accountId: row.accountId,
    transferIndex: index,
  }));
}

test('complete leaves yield authoritative totals and complete flag', () => {
  const rows = [
    { transaction: { id: 'a', amount: -5000, category: 'food' }, accountId: 'checking' },
    { transaction: { id: 'b', amount: 90000, category: 'salary' }, accountId: 'checking' },
  ];
  const summary = spendSummaryFromClassifiedLeaves(classifyRows(rows));
  assert.equal(summary.completeness.complete, true);
  assert.equal(summary.totalSpend, 50);
  assert.equal(summary.totalIncome, 900);
  assert.equal(summary.knownSpendSubtotal, undefined);
});

test('malformed transfer pair yields null authoritative totals and lower-bound subtotals', () => {
  const rows = [
    { transaction: { id: 'a', amount: -50000, transfer_id: 'b', category: 'food' }, accountId: 'checking' },
    { transaction: { id: 'b', amount: 25000, transfer_id: 'a' }, accountId: 'savings' },
  ];
  const summary = spendSummaryFromClassifiedLeaves(classifyRows(rows));
  assert.equal(summary.completeness.complete, false);
  assert.equal(summary.totalSpend, null);
  assert.equal(summary.totalIncome, null);
  assert.equal(summary.knownSpendSubtotal, 0);
  assert.ok(summary.completeness.incompleteReasons.includes(PROJECTION_INCOMPLETE_REASON));
  assert.ok(summary.completeness.transferIdentityUnresolvedCount > 0);
});

test('one-sided transfer outside window stays complete', () => {
  const rows = [{ transaction: { id: 'only', amount: -25000, transfer_id: 'absent' }, accountId: 'checking' }];
  const summary = spendSummaryFromClassifiedLeaves(classifyRows(rows));
  assert.equal(summary.completeness.complete, true);
  assert.equal(summary.totalSpend, 0);
});

test('mergeProjectionCompleteness fails closed when any part is incomplete', () => {
  const merged = mergeProjectionCompleteness([
    { complete: true, incompleteReasons: [], transferIdentityUnresolvedCount: 0, transferIdentityReasons: [] },
    {
      complete: false,
      incompleteReasons: [PROJECTION_INCOMPLETE_REASON, TRANSFER_REASON.PAIR_AMOUNT_MISMATCH],
      transferIdentityUnresolvedCount: 2,
      transferIdentityReasons: [TRANSFER_REASON.PAIR_AMOUNT_MISMATCH],
    },
  ]);
  assert.equal(merged.complete, false);
  assert.equal(merged.transferIdentityUnresolvedCount, 2);
  assert.ok(merged.incompleteReasons.includes(PROJECTION_INCOMPLETE_REASON));
});

test('projectionCompletenessFromLeaves ignores non-transfer incomplete kinds', () => {
  const completeness = projectionCompletenessFromLeaves([
    { kind: 'incomplete', provenance: 'other', reason: 'x' },
    { kind: 'spend', provenance: PROVENANCE.TRANSFER_IDENTITY, reason: 'ignored' },
  ]);
  assert.equal(completeness.complete, true);
});
