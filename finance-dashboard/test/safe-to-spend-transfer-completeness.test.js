'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const { SAFE_TO_SPEND_INPUTS, SAFE_TO_SPEND_REASON, safeToSpendIncompleteReasons } = require('../lib/safe-to-spend');

test('transfer identity unresolved quarantines safe-to-spend', () => {
  const reasons = safeToSpendIncompleteReasons({
    accounts: [{ id: 'a', name: 'Checking', role: 'operating_cash', roleSource: 'explicit', hidden: false, balance: 1000 }],
    visibleAccounts: [{ id: 'a', name: 'Checking', role: 'operating_cash', roleSource: 'explicit', hidden: false }],
    operatingAccounts: [{ id: 'a', name: 'Checking', role: 'operating_cash', balance: 1000 }],
    budgets: {
      supported: true,
      [SAFE_TO_SPEND_INPUTS]: {
        targetedCategoryCount: 2,
        eligibleCategoryCount: 2,
        targetlessSpentCategoryCount: 0,
        unresolvedRolloverCategoryCount: 0,
      },
    },
    spendingCompleteness: {
      complete: false,
      incompleteReasons: ['transfer_identity_unresolved'],
      transferIdentityUnresolvedCount: 1,
      transferIdentityReasons: ['transfer_pair_amount_mismatch'],
    },
  });
  assert.ok(reasons.includes(SAFE_TO_SPEND_REASON.transferIdentityUnresolved));
});

test('complete spending completeness does not add transfer identity reason', () => {
  const reasons = safeToSpendIncompleteReasons({
    accounts: [{ id: 'a', name: 'Checking', role: 'operating_cash', roleSource: 'explicit', hidden: false }],
    visibleAccounts: [{ id: 'a', name: 'Checking', role: 'operating_cash', roleSource: 'explicit', hidden: false }],
    operatingAccounts: [{ id: 'a', name: 'Checking', role: 'operating_cash', balance: 1000 }],
    budgets: { supported: false },
    spendingCompleteness: {
      complete: true,
      incompleteReasons: [],
      transferIdentityUnresolvedCount: 0,
      transferIdentityReasons: [],
    },
  });
  assert.equal(reasons.includes(SAFE_TO_SPEND_REASON.transferIdentityUnresolved), false);
});
