'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const {
  applyAllocationLink,
  applyConfirmationRecord,
  confirmationConverged,
  linksConverged,
  validateAllocationPlan,
} = require('../lib/repayment-confirmation-sidecars');

test('validateAllocationPlan conserves cents and respects expense bounds', () => {
  const summary = validateAllocationPlan({
    inflowAmountCents: 5000,
    inflowId: 'inflow',
    existingLinks: [],
    allocations: [
      { expenseId: 'exp-a', amountCents: 2000, expenseSnapshot: { amountCents: -3000 } },
      { expenseId: 'exp-b', amountCents: 2500, expenseSnapshot: { amountCents: -4000 } },
    ],
  });
  assert.equal(summary.totalAllocatedCents, 4500);
  assert.equal(summary.allocationCount, 2);

  assert.throws(
    () => validateAllocationPlan({
      inflowAmountCents: 1000,
      inflowId: 'inflow',
      allocations: [
        { expenseId: 'exp-a', amountCents: 600, expenseSnapshot: { amountCents: -500 } },
      ],
    }),
    /exceeds remaining expense capacity/,
  );

  assert.throws(
    () => validateAllocationPlan({
      inflowAmountCents: 1000,
      inflowId: 'inflow',
      allocations: [
        { expenseId: 'exp-a', amountCents: 700, expenseSnapshot: { amountCents: -1000 } },
        { expenseId: 'exp-b', amountCents: 400, expenseSnapshot: { amountCents: -1000 } },
      ],
    }),
    /allocation plan exceeds inflow amount/,
  );
});

test('sidecar writes are idempotent and preserve unknown fields', () => {
  const links = {
    schemaVersion: 1,
    unknown: { keep: true },
    links: [{
      inflow: { id: 'other', amount: 5 },
      expense: { id: 'legacy', amount: -5 },
      amount: 5,
    }],
  };
  applyAllocationLink(links, {
    inflowSnapshot: { id: 'inflow', date: '2026-07-10', amountCents: 5000 },
    expenseSnapshot: { id: 'exp-a', date: '2026-07-09', amountCents: -3000 },
    amountCents: 2000,
    person: 'alex',
  });
  applyAllocationLink(links, {
    inflowSnapshot: { id: 'inflow', date: '2026-07-10', amountCents: 5000 },
    expenseSnapshot: { id: 'exp-a', date: '2026-07-09', amountCents: -3000 },
    amountCents: 2000,
    person: 'alex',
  });
  assert.equal(links.links.length, 2);
  assert.deepEqual(links.unknown, { keep: true });
  assert.ok(linksConverged({
    allocations: [{ expenseId: 'exp-a', amountCents: 2000, expenseSnapshot: { amountCents: -3000 } }],
  }, links, { inflowSnapshot: { id: 'inflow' }, person: 'alex' }));

  const suggestions = {
    confirmed: { legacy: { inflowId: null, at: 'keep' } },
    dismissed: ['keep'],
    extra: true,
  };
  applyConfirmationRecord(suggestions, {
    suggestionId: 'sg_inflow',
    inflowId: 'inflow',
    allocationCount: 1,
    confirmedAt: '2026-07-10T12:00:00.000Z',
  });
  applyConfirmationRecord(suggestions, {
    suggestionId: 'sg_inflow',
    inflowId: 'inflow',
    allocationCount: 1,
    confirmedAt: '2026-07-10T12:00:00.000Z',
  });
  assert.ok(confirmationConverged({
    suggestionId: 'sg_inflow',
    inflowId: 'inflow',
    allocationCount: 1,
    store: suggestions,
  }));
  assert.deepEqual(suggestions.confirmed.legacy, { inflowId: null, at: 'keep' });
  assert.equal(suggestions.extra, true);
});

test('legacy numeric expense ids in prior links reduce remaining capacity', () => {
  assert.throws(
    () => validateAllocationPlan({
      inflowAmountCents: 5000,
      inflowId: 'inflow',
      existingLinks: [{
        inflow: { id: 'legacy-inflow' },
        expense: { id: 42, amount: -25 },
        amount: 25,
      }],
      allocations: [{
        expenseId: '42',
        amountCents: 600,
        expenseSnapshot: { amountCents: -3000 },
      }],
    }),
    /exceeds remaining expense capacity/,
  );
});
