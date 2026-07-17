'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const {
  rewriteTransactionDeletionReferences,
} = require('../lib/transaction-deletion-references');

function stores() {
  return {
    receipts: {
      schemaVersion: 1,
      unknown: { keep: true },
      byTxn: {
        parent: [
          { id: 'deleted-only', txnId: 'parent', file: 'deleted.jpg', audit: 'keep-until-removed' },
          { id: 'shared', txnId: 'parent', file: 'shared.jpg' },
        ],
        other: [
          { id: 'survivor', txnId: 'other', file: 'shared.jpg', legacy: null },
          { id: 'misbucketed', txnId: 'leg', file: 'leg.jpg' },
        ],
      },
    },
    links: {
      schemaVersion: 1,
      unknown: 'keep',
      links: [
        { inflow: { id: 'payment' }, expense: { id: 'leg' }, amount: 11, createdAt: 'original' },
        { inflow: null, expense: { id: 'other' }, amount: 12, createdAt: 'legacy-null' },
        { inflow: { id: 'same' }, expense: { id: 'same' }, amount: 13, createdAt: 'legacy-self' },
      ],
    },
    suggestions: {
      schemaVersion: 1,
      unknown: ['keep'],
      dismissed: ['parent', null, 'other', 'other'],
      confirmed: {
        sg_parent: { inflowId: 'parent', amount: 20, at: 'deleted' },
        sg_other: {
          inflowId: 'other',
          amount: 21,
          at: 'keep',
          allocations: [
            { amount: 4, expense: { id: 'leg', amount: -4 }, auditAt: 'remove' },
            { amount: 17, expense: { id: 'expense', amount: -17 }, auditAt: 'keep' },
          ],
        },
        legacy: { inflowId: null, amount: 22, at: 'legacy-null', allocations: null },
      },
    },
    reconciliation: {
      schemaVersion: 1,
      enabled: true,
      unknown: { keep: true },
      months: {
        '2026-07': {
          done: true,
          doneAt: 'do-not-rewrite',
          unknown: 'keep',
          items: { parent: 'remove', other: 'keep' },
        },
        legacy: null,
      },
    },
    phantomSeen: {
      schemaVersion: 1,
      unknown: 42,
      seen: {
        leg: { firstSeen: 'remove' },
        other: { firstSeen: 'keep', legacy: null },
      },
    },
  };
}

test('deletion removes exact-ID evidence while preserving unrelated legacy rows', () => {
  const before = stores();
  const unrelatedLink = structuredClone(before.links.links[1]);
  const selfLink = structuredClone(before.links.links[2]);
  const survivingAllocation = structuredClone(
    before.suggestions.confirmed.sg_other.allocations[1],
  );

  const result = rewriteTransactionDeletionReferences(before, ['parent', 'leg']);

  assert.deepEqual(Object.keys(result.stores.receipts.byTxn), ['other']);
  assert.deepEqual(result.stores.receipts.byTxn.other, [
    { id: 'survivor', txnId: 'other', file: 'shared.jpg', legacy: null },
  ]);
  assert.deepEqual(result.receiptFilesToDelete, ['deleted.jpg', 'leg.jpg']);
  assert.deepEqual(result.stores.receipts.unknown, { keep: true });

  assert.deepEqual(result.stores.links.links, [unrelatedLink, selfLink]);
  assert.equal(result.stores.links.unknown, 'keep');

  assert.deepEqual(result.stores.suggestions.dismissed, [null, 'other', 'other']);
  assert.equal(result.stores.suggestions.confirmed.sg_parent, undefined);
  assert.deepEqual(
    result.stores.suggestions.confirmed.sg_other.allocations,
    [survivingAllocation],
  );
  assert.deepEqual(
    result.stores.suggestions.confirmed.legacy,
    before.suggestions.confirmed.legacy,
  );
  assert.deepEqual(result.stores.suggestions.unknown, ['keep']);

  assert.deepEqual(result.stores.reconciliation.months['2026-07'], {
    done: true,
    doneAt: 'do-not-rewrite',
    unknown: 'keep',
    items: { other: 'keep' },
  });
  assert.equal(result.stores.reconciliation.months.legacy, null);
  assert.deepEqual(result.stores.reconciliation.unknown, { keep: true });

  assert.deepEqual(result.stores.phantomSeen.seen, {
    other: { firstSeen: 'keep', legacy: null },
  });
  assert.equal(result.stores.phantomSeen.unknown, 42);
  assert.deepEqual(before, stores(), 'the input stores are not mutated');
});

test('deletion reference rewriting is idempotent', () => {
  const first = rewriteTransactionDeletionReferences(stores(), ['parent', 'leg']);
  const second = rewriteTransactionDeletionReferences(first.stores, ['parent', 'leg']);
  assert.deepEqual(second.stores, first.stores);
  assert.deepEqual(second.receiptFilesToDelete, []);
  assert.deepEqual(second.stats, {
    receipts: 0,
    links: 0,
    suggestions: 0,
    reconciliation: 0,
    phantomSeen: 0,
  });
});

test('malformed reference stores fail closed instead of being normalized', () => {
  const malformed = stores();
  malformed.links.links = null;
  assert.throws(
    () => rewriteTransactionDeletionReferences(malformed, ['parent']),
    /invalid reimbursement links reference store/,
  );
});
