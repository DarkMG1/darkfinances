const test = require('node:test');
const assert = require('node:assert/strict');
const { rewriteTransactionReferences } = require('../lib/transaction-references');

function stores() {
  return {
    receipts: {
      byTxn: {
        parent: [{ id: 'r1', txnId: 'parent', file: 'r1.jpg' }],
        leg: [{ id: 'r2', txnId: 'leg', file: 'r2.jpg' }],
      },
    },
    links: {
      links: [
        { inflow: { id: 'payment' }, expense: { id: 'leg' }, amount: 10 },
        { inflow: { id: 'parent' }, expense: { id: 'leg' }, amount: 2 },
      ],
    },
    suggestions: {
      dismissed: ['payment'],
      confirmed: {
        sg_payment: { inflowId: 'payment', allocations: 1 },
      },
    },
    reconciliation: {
      enabled: true,
      months: {
        '2026-07': { done: false, items: { parent: 'timestamp', other: 'timestamp-2' } },
      },
    },
    phantomSeen: { seen: { parent: { firstSeen: 'now' }, other: { firstSeen: 'before' } } },
  };
}

test('migrates every sidecar reference and merges receipt buckets', () => {
  const result = rewriteTransactionReferences(stores(), {
    parent: 'replacement',
    leg: 'replacement',
    payment: 'new-payment',
  });

  assert.deepEqual(
    result.stores.receipts.byTxn.replacement.map((receipt) => receipt.txnId),
    ['replacement', 'replacement']
  );
  assert.deepEqual(result.stores.links.links, [
    { inflow: { id: 'new-payment' }, expense: { id: 'replacement' }, amount: 10 },
  ]);
  assert.deepEqual(result.stores.suggestions.dismissed, ['new-payment']);
  assert.equal(result.stores.suggestions.confirmed['sg_new-payment'].inflowId, 'new-payment');
  assert.equal(result.stores.reconciliation.months['2026-07'].items.replacement, 'timestamp');
  assert.equal(result.stores.reconciliation.months['2026-07'].items.other, 'timestamp-2');
  assert.deepEqual(Object.keys(result.stores.phantomSeen.seen).sort(), ['other', 'replacement']);
});

test('removing a transaction drops references and identifies receipt files', () => {
  const result = rewriteTransactionReferences(stores(), { parent: null, leg: null });
  assert.deepEqual(result.stores.receipts.byTxn, {});
  assert.deepEqual(result.receiptFilesToDelete.sort(), ['r1.jpg', 'r2.jpg']);
  assert.deepEqual(result.stores.links.links, []);
  assert.equal(result.stores.reconciliation.months['2026-07'].items.parent, undefined);
  assert.equal(result.stores.phantomSeen.seen.parent, undefined);
});
