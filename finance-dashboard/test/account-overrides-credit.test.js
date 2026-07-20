'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');

const {
  mergeAccountOverrideEntry,
  validateCreditOverrideCrossFields,
  validEntry,
} = require('../lib/account-overrides-schema');

test('mergeAccountOverrideEntry preserves omitted fields and clears credit policy atomically', () => {
  const merged = mergeAccountOverrideEntry({
    name: 'Card',
    creditLiabilityCoverage: 'current_balance',
    paymentRecurringKey: 'card-pay',
    fundingAccountId: 'checking',
  }, {
    clearCreditLiability: true,
    hidden: true,
  });
  assert.deepEqual(merged, { name: 'Card', hidden: true });
  assert.equal(validEntry(merged), true);
});

test('partial credit override write round-trips without dropping sibling fields', () => {
  const merged = mergeAccountOverrideEntry({
    creditLiabilityCoverage: 'statement',
    paymentRecurringKey: 'card-pay',
    statement: {
      balanceCents: -10000,
      paymentDueDate: '2026-08-01',
      observedAt: '2026-07-01T00:00:00.000Z',
    },
  }, {
    fundingAccountId: 'checking',
  });
  assert.equal(merged.fundingAccountId, 'checking');
  assert.equal(merged.statement.balanceCents, -10000);
  assert.equal(validateCreditOverrideCrossFields(merged).ok, true);
  assert.equal(validEntry(merged), true);
});

test('malformed statement override fails cross-field validation', () => {
  const issues = validateCreditOverrideCrossFields({
    creditLiabilityCoverage: 'statement',
    paymentRecurringKey: 'card-pay',
  });
  assert.equal(issues.ok, false);
  assert.ok(issues.issues.some((issue) => issue.includes('statement payload')));
});

test('statement payload without statement coverage mode is rejected', () => {
  const issues = validateCreditOverrideCrossFields({
    creditLiabilityCoverage: 'current_balance',
    paymentRecurringKey: 'card-pay',
    statement: {
      balanceCents: -10000,
      paymentDueDate: '2026-08-01',
      observedAt: '2026-07-01T00:00:00.000Z',
    },
  });
  assert.equal(issues.ok, false);
});
