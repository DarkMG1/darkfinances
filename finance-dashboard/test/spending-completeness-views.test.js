'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const { buildSpendingCompletenessViews } = require('../lib/domain/spending-completeness-views');

const completeCurrent = {
  completeness: { complete: true, incompleteReasons: [], transferIdentityUnresolvedCount: 0, transferIdentityReasons: [] },
};
const incompletePrevious = {
  completeness: {
    complete: false,
    incompleteReasons: ['transfer_identity_unresolved'],
    transferIdentityUnresolvedCount: 1,
    transferIdentityReasons: ['transfer_pair_amount_mismatch'],
  },
};

test('previous-only mismatch leaves primary completeness complete and comparison incomplete', () => {
  const views = buildSpendingCompletenessViews({
    current: completeCurrent,
    previous: incompletePrevious,
    spendingProjection: { incompleteReasons: [] },
  });
  assert.equal(views.completeness.complete, true);
  assert.equal(views.comparisonCompleteness.complete, false);
  assert.deepEqual(views.current.completeness, views.completeness);
});

test('current-month mismatch fails closed on primary completeness', () => {
  const views = buildSpendingCompletenessViews({
    current: incompletePrevious,
    previous: completeCurrent,
    spendingProjection: { incompleteReasons: [] },
  });
  assert.equal(views.completeness.complete, false);
  assert.equal(views.comparisonCompleteness.complete, false);
});

test('spending projection incompleteness fails closed on primary completeness', () => {
  const views = buildSpendingCompletenessViews({
    current: completeCurrent,
    previous: completeCurrent,
    spendingProjection: { incompleteReasons: ['account_balance_unavailable'] },
  });
  assert.equal(views.completeness.complete, false);
  assert.ok(views.completeness.incompleteReasons.includes('account_balance_unavailable'));
  assert.equal(views.comparisonCompleteness.complete, false);
});

test('Today-style completeness gate stays complete when only comparison is incomplete', () => {
  const views = buildSpendingCompletenessViews({
    current: completeCurrent,
    previous: incompletePrevious,
    spendingProjection: { incompleteReasons: [] },
  });
  const safeToSpendComplete = true;
  const todayComplete = safeToSpendComplete && views.completeness?.complete === true;
  assert.equal(todayComplete, true);
});

test('month-over-month delta requires comparison completeness while headline uses primary completeness', () => {
  const views = buildSpendingCompletenessViews({
    current: { ...completeCurrent, totalSpend: 500, totalIncome: 1000 },
    previous: { ...incompletePrevious, totalSpend: 400, totalIncome: 900 },
    spendingProjection: { incompleteReasons: [] },
  });
  const spendingComplete = views.completeness?.complete === true;
  const comparisonComplete = views.comparisonCompleteness?.complete === true;
  const cur = views.current;
  const prev = { totalSpend: 400 };
  const totalSpend = spendingComplete && cur.totalSpend != null ? cur.totalSpend : null;
  const spendDelta = spendingComplete && comparisonComplete && prev.totalSpend > 0 && cur.totalSpend != null
    ? ((cur.totalSpend - prev.totalSpend) / prev.totalSpend) * 100
    : null;
  assert.equal(totalSpend, 500);
  assert.equal(spendDelta, null);
});
