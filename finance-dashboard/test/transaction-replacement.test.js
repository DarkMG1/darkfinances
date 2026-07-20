const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const os = require('os');
const path = require('path');

const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'darkfinances-replacement-'));
for (const [key, name] of Object.entries({
  PERSONAL_CONFIG_PATH: 'personal.json',
  RECEIPTS_PATH: 'receipts.json',
  RECEIPTS_DIR: 'receipts',
  REIMB_LINKS_PATH: 'links.json',
  REIMB_SUGGEST_PATH: 'suggestions.json',
  RECON_PATH: 'reconciliation.json',
  PHANTOM_SEEN_PATH: 'phantom-seen.json',
  TRANSACTION_SAGAS_PATH: 'transaction-sagas.json',
})) process.env[key] = path.join(dir, name);

const {
  addableSplitLeg,
  addableTransaction,
  recoverTransactionSagas,
  replaceActualTransaction,
  transactionReplacementMap,
} = require('../dataModule');
const {
  shapeMatches,
  transactionFingerprint,
  transactionShape,
  rollbackReplacementMap,
  metadataRestoreFields,
  forwardReferenceMigrationLocked,
  postMigrationReplacementDriftReason,
} = require('../lib/transaction-replacement-saga');
test.beforeEach(() => {
  fs.rmSync(process.env.TRANSACTION_SAGAS_PATH, { force: true });
});
test.after(() => fs.rmSync(dir, { recursive: true, force: true }));

function fakeApi(original, { failFirstAdd = false } = {}) {
  let rows = [structuredClone(original)];
  let sequence = 0;
  let addCalls = 0;
  return {
    async getAccounts() {
      return [{ id: 'account', name: 'Account', closed: false, offbudget: false }];
    },
    async getTransactions(accountId) {
      return accountId == null || accountId === 'account' ? structuredClone(rows) : [];
    },
    async deleteTransaction(id) { rows = rows.filter((row) => row.id !== id); },
    async addTransactions(_accountId, [transaction]) {
      addCalls += 1;
      if (failFirstAdd && addCalls === 1) throw new Error('simulated add failure');
      const id = `replacement-${++sequence}`;
      const subs = (transaction.subtransactions || []).map((sub, index) => ({
        ...sub,
        id: `${id}-leg-${index + 1}`,
        parent_id: id,
      }));
      rows.push({
        ...structuredClone(transaction),
        id,
        is_parent: subs.length > 0,
        subtransactions: subs,
      });
    },
    async updateTransaction(id, fields) {
      const row = rows.find((transaction) => transaction.id === id);
      if (row) Object.assign(row, structuredClone(fields));
    },
    async sync() {},
  };
}

const original = {
  id: 'old-parent',
  date: '2026-07-09',
  amount: -1000,
  payee: 'payee-id',
  notes: 'parent note',
  cleared: false,
  imported_id: 'bank-import-id',
  imported_payee: 'Original merchant',
  category: 'old-category',
  is_parent: false,
  subtransactions: [],
};

test('addable transaction preserves import identity and parent metadata', () => {
  assert.deepEqual(addableTransaction(original), {
    date: '2026-07-09',
    amount: -1000,
    payee: 'payee-id',
    notes: 'parent note',
    cleared: false,
    imported_id: 'bank-import-id',
    imported_payee: 'Original merchant',
    category: 'old-category',
    subtransactions: undefined,
  });
});

const parentPayee = 'payee-id';
const splitShapeBase = {
  date: '2026-07-09',
  amount: -1000,
  payee: parentPayee,
  notes: 'parent notes',
  cleared: false,
  imported_id: null,
  category: null,
  subtransactions: [
    { amount: -400, category: 'cat-1', notes: 'leg one' },
    { amount: -600, category: 'cat-2', notes: 'leg two' },
  ],
};

test('shape comparison treats null leg payee as parent payee inheritance', () => {
  const withNullLegPayee = structuredClone(splitShapeBase);
  const withParentLegPayee = {
    ...structuredClone(splitShapeBase),
    subtransactions: splitShapeBase.subtransactions.map((leg) => ({
      ...leg,
      payee: parentPayee,
    })),
  };
  assert.equal(shapeMatches(withNullLegPayee, withParentLegPayee), true);
  assert.equal(
    transactionFingerprint(withNullLegPayee),
    transactionFingerprint(withParentLegPayee),
  );
});

test('shape comparison rejects explicit different leg payee', () => {
  const withNullLegPayee = structuredClone(splitShapeBase);
  const withDistinctLegPayee = {
    ...structuredClone(splitShapeBase),
    subtransactions: [
      { ...splitShapeBase.subtransactions[0], payee: 'leg-payee-1' },
      { ...splitShapeBase.subtransactions[1] },
    ],
  };
  assert.equal(shapeMatches(withNullLegPayee, withDistinctLegPayee), false);
});

test('transactionShape does not mutate stored leg payee values', () => {
  const txn = structuredClone(splitShapeBase);
  transactionShape(txn);
  assert.equal(txn.subtransactions[0].payee, undefined);
  assert.equal(txn.subtransactions[1].payee, undefined);
});

test('shape comparison treats reversed split leg order as the same multiset', () => {
  const forward = structuredClone(splitShapeBase);
  const reversed = {
    ...structuredClone(splitShapeBase),
    subtransactions: [...splitShapeBase.subtransactions].reverse(),
  };
  assert.equal(shapeMatches(forward, reversed), true);
  assert.equal(
    transactionFingerprint(forward),
    transactionFingerprint(reversed),
  );
  assert.deepEqual(transactionShape(forward).legs, transactionShape(reversed).legs);
});

test('shape comparison rejects different leg amounts even when order matches', () => {
  const baseline = structuredClone(splitShapeBase);
  const changed = {
    ...structuredClone(splitShapeBase),
    subtransactions: [
      { ...splitShapeBase.subtransactions[0], amount: -401 },
      splitShapeBase.subtransactions[1],
    ],
  };
  assert.equal(shapeMatches(baseline, changed), false);
});

test('shape comparison rejects different leg categories notes or payees', () => {
  const baseline = structuredClone(splitShapeBase);
  assert.equal(shapeMatches(baseline, {
    ...structuredClone(splitShapeBase),
    subtransactions: [
      { ...splitShapeBase.subtransactions[0], category: 'other-category' },
      splitShapeBase.subtransactions[1],
    ],
  }), false);
  assert.equal(shapeMatches(baseline, {
    ...structuredClone(splitShapeBase),
    subtransactions: [
      { ...splitShapeBase.subtransactions[0], notes: 'other notes' },
      splitShapeBase.subtransactions[1],
    ],
  }), false);
  assert.equal(shapeMatches(baseline, {
    ...structuredClone(splitShapeBase),
    subtransactions: [
      { ...splitShapeBase.subtransactions[0], payee: 'other-payee' },
      splitShapeBase.subtransactions[1],
    ],
  }), false);
});

test('shape comparison preserves duplicate leg multiplicity', () => {
  const duplicateLeg = { amount: -500, category: 'cat-dup', notes: 'dup' };
  const twoDupes = {
    ...structuredClone(splitShapeBase),
    amount: -2000,
    subtransactions: [duplicateLeg, { ...duplicateLeg }],
  };
  const oneDupe = {
    ...structuredClone(splitShapeBase),
    amount: -1500,
    subtransactions: [duplicateLeg],
  };
  assert.equal(shapeMatches(twoDupes, {
    ...structuredClone(twoDupes),
    subtransactions: [...twoDupes.subtransactions].reverse(),
  }), true);
  assert.equal(shapeMatches(twoDupes, oneDupe), false);
});

test('transactionShape does not mutate source subtransaction arrays', () => {
  const txn = structuredClone(splitShapeBase);
  const before = txn.subtransactions.map((leg) => ({ ...leg }));
  transactionShape(txn);
  assert.deepEqual(txn.subtransactions, before);
});

test('addableSplitLeg omits inherited parent payee but keeps explicit different payee', () => {
  assert.deepEqual(addableSplitLeg(
    { amount: -500, category: 'cat-1', notes: 'first', payee: parentPayee },
    parentPayee,
  ), {
    amount: -500,
    category: 'cat-1',
    notes: 'first',
  });
  assert.deepEqual(addableSplitLeg(
    { amount: -500, category: 'cat-1', notes: 'named', payee: 'leg-payee-1' },
    parentPayee,
  ), {
    amount: -500,
    category: 'cat-1',
    notes: 'named',
    payee: 'leg-payee-1',
  });
});

test('replacement map treats Actual canonicalized inherited payee as unnamed intent', () => {
  const original = {
    id: 'old-parent',
    payee: parentPayee,
    subtransactions: [
      { id: 'old-leg-1', amount: -400, category: 'cat-1', notes: 'leg one' },
      { id: 'old-leg-2', amount: -600, category: 'cat-2', notes: 'leg two' },
    ],
  };
  const replacement = {
    id: 'new-parent',
    payee: parentPayee,
    subtransactions: [
      { id: 'new-leg-1', amount: -400, category: 'cat-1', notes: 'updated', payee: parentPayee },
      { id: 'new-leg-2', amount: -600, category: 'cat-2', notes: 'leg two', payee: parentPayee },
    ],
  };
  const intended = addableTransaction(original, {
    category: undefined,
    subtransactions: [
      { amount: -400, category: 'cat-1', notes: 'updated' },
      { amount: -600, category: 'cat-2', notes: 'leg two' },
    ],
  });
  assert.deepEqual(
    transactionReplacementMap(original, replacement, ['old-leg-1', 'old-leg-2'], intended),
    { 'old-parent': 'new-parent', 'old-leg-1': 'new-leg-1', 'old-leg-2': 'new-leg-2' },
  );
});

test('replacement map matches retained legs when Actual returns reversed order', () => {
  const original = {
    id: 'old-parent',
    payee: parentPayee,
    subtransactions: [
      { id: 'old-leg-1', amount: -400, category: 'cat-1', notes: 'leg one', payee: 'leg-payee-1' },
      { id: 'old-leg-2', amount: -600, category: 'cat-2', notes: 'leg two', payee: 'leg-payee-2' },
    ],
  };
  const replacement = {
    id: 'new-parent',
    payee: parentPayee,
    subtransactions: [
      { id: 'new-leg-2', amount: -600, category: 'cat-2', notes: 'leg two', payee: 'leg-payee-2' },
      { id: 'new-leg-1', amount: -400, category: 'cat-1', notes: 'updated', payee: 'leg-payee-1' },
    ],
  };
  const intended = addableTransaction(original, {
    category: undefined,
    subtransactions: [
      { amount: -400, category: 'cat-1', notes: 'updated', payee: 'leg-payee-1' },
      { amount: -600, category: 'cat-2', notes: 'leg two', payee: 'leg-payee-2' },
    ],
  });
  assert.deepEqual(
    transactionReplacementMap(original, replacement, ['old-leg-1', 'old-leg-2'], intended),
    { 'old-parent': 'new-parent', 'old-leg-1': 'new-leg-1', 'old-leg-2': 'new-leg-2' },
  );
});

test('rollback replacement map resolves legs by idMap content not checkpoint order', () => {
  const saga = {
    original: {
      id: 'old-parent',
      payee: parentPayee,
      subtransactions: [
        { id: 'old-leg-1', amount: -400, category: 'cat-1', notes: 'leg one', payee: 'leg-payee-1' },
        { id: 'old-leg-2', amount: -600, category: 'cat-2', notes: 'leg two', payee: 'leg-payee-2' },
      ],
    },
    replacement: {
      payee: parentPayee,
      subtransactions: [
        { amount: -400, category: 'cat-1', notes: 'updated', payee: 'leg-payee-1' },
        { amount: -600, category: 'cat-2', notes: 'leg two', payee: 'leg-payee-2' },
      ],
    },
    legOwnership: ['old-leg-1', 'old-leg-2'],
    replacementIds: {
      parentId: 'new-parent',
      legIds: ['new-leg-2', 'new-leg-1'],
    },
    idMap: {
      'old-parent': 'new-parent',
      'old-leg-1': 'new-leg-1',
      'old-leg-2': 'new-leg-2',
    },
  };
  const restored = {
    id: 'restored-parent',
    payee: parentPayee,
    subtransactions: [
      { id: 'restored-leg-2', amount: -600, category: 'cat-2', notes: 'leg two', payee: 'leg-payee-2' },
      { id: 'restored-leg-1', amount: -400, category: 'cat-1', notes: 'leg one', payee: 'leg-payee-1' },
    ],
  };
  assert.deepEqual(rollbackReplacementMap(saga, restored), {
    'old-parent': 'restored-parent',
    'old-leg-1': 'restored-leg-1',
    'old-leg-2': 'restored-leg-2',
    'new-parent': 'restored-parent',
    'new-leg-1': 'restored-leg-1',
    'new-leg-2': 'restored-leg-2',
  });
});

test('rollback replacement map fails closed without refreshed idMap', () => {
  const saga = {
    original: { id: 'old-parent', subtransactions: [] },
    replacementIds: { parentId: 'new-parent', legIds: ['new-leg-1'] },
  };
  assert.throws(
    () => rollbackReplacementMap(saga, { id: 'restored-parent', subtransactions: [] }),
    /requires refreshed idMap/,
  );
});

test('rollback replacement map fails closed when checkpoint leg ids are absent from idMap', () => {
  const saga = {
    original: {
      id: 'old-parent',
      payee: parentPayee,
      subtransactions: [
        { id: 'old-leg-1', amount: -400, category: 'cat-1', notes: 'leg one' },
      ],
    },
    replacement: {
      payee: parentPayee,
      subtransactions: [{ amount: -400, category: 'cat-1', notes: 'leg one' }],
    },
    legOwnership: ['old-leg-1'],
    replacementIds: { parentId: 'new-parent', legIds: ['stale-leg-id'] },
    idMap: { 'old-parent': 'new-parent', 'old-leg-1': 'live-leg-id' },
  };
  assert.throws(
    () => rollbackReplacementMap(saga, {
      id: 'restored-parent',
      payee: parentPayee,
      subtransactions: [{ id: 'restored-leg-1', amount: -400, category: 'cat-1', notes: 'leg one' }],
    }),
    /stale/,
  );
});

test('replacement identifies the new parent and generated leg IDs', async () => {
  const api = fakeApi(original);
  const replacement = addableTransaction(original, {
    category: undefined,
    subtransactions: [
      { amount: -400, category: 'cat-1', notes: 'mine' },
      { amount: -600, category: 'cat-2', notes: 'shared' },
    ],
  });
  const added = await replaceActualTransaction(api, {
    accountId: 'account',
    original,
    replacement,
  });
  assert.equal(added.id, 'replacement-1');
  assert.equal(added.subtransactions.length, 2);
  assert.deepEqual(transactionReplacementMap(original, added), { 'old-parent': 'replacement-1' });
});

test('unknown add failure stays nonterminal and recovery finishes the intended replacement', async () => {
  const api = fakeApi(original, { failFirstAdd: true });
  await assert.rejects(
    replaceActualTransaction(api, {
      accountId: 'account',
      original,
      replacement: addableTransaction(original, {
        category: undefined,
        subtransactions: [{ amount: -500 }, { amount: -500 }],
      }),
    }),
    /simulated add failure/
  );
  await recoverTransactionSagas(api);
  await recoverTransactionSagas(api);
  const rows = await api.getTransactions();
  assert.equal(rows.length, 1);
  assert.equal(rows[0].amount, original.amount);
  assert.equal(rows[0].imported_id, original.imported_id);
  assert.equal(rows[0].subtransactions.length, 2);
});

test('startup recovery finishes sidecar migration after replacement commit', async () => {
  const replacement = {
    ...addableTransaction(original),
    id: 'replacement-after-crash',
    is_parent: false,
    subtransactions: [],
  };
  fs.writeFileSync(process.env.RECEIPTS_PATH, JSON.stringify({
    byTxn: {
      [original.id]: [{ id: 'receipt-1', txnId: original.id, file: 'receipt.jpg' }],
    },
  }));
  fs.writeFileSync(process.env.TRANSACTION_SAGAS_PATH, JSON.stringify({
    schemaVersion: 1,
    sagas: {
      crash: {
        id: 'crash',
        status: 'replacement-added',
        accountId: 'account',
        original,
        replacement: addableTransaction(original),
        replacementId: replacement.id,
        requestedLegs: null,
        beforeIds: [original.id],
        startedAt: '2026-07-09T00:00:00.000Z',
        updatedAt: '2026-07-09T00:00:01.000Z',
      },
    },
  }));
  let synced = false;
  await recoverTransactionSagas({
    async getAccounts() {
      return [{ id: 'account', name: 'Account', closed: false, offbudget: false }];
    },
    async getTransactions() { return [structuredClone(replacement)]; },
    async sync() { synced = true; },
  });
  const receipts = JSON.parse(fs.readFileSync(process.env.RECEIPTS_PATH, 'utf8'));
  assert.equal(receipts.byTxn[original.id], undefined);
  assert.equal(receipts.byTxn[replacement.id][0].txnId, replacement.id);
  const saga = JSON.parse(fs.readFileSync(process.env.TRANSACTION_SAGAS_PATH, 'utf8')).sagas.crash;
  assert.equal(saga.status, 'completed');
  assert.equal(synced, true);
});

test('metadataRestoreFields omits subtransactions from parent-only metadata patch', () => {
  const parent = {
    id: 'parent',
    date: '2026-07-09',
    amount: -1000,
    payee: 'payee-id',
    imported_id: 'df-replace:temp',
    is_parent: true,
    subtransactions: [
      { id: 'leg-1', parent_id: 'parent', amount: -500, category: 'cat-1' },
      { id: 'leg-2', parent_id: 'parent', amount: -500, category: 'cat-2' },
    ],
  };
  const payload = metadataRestoreFields(parent, null);
  assert.equal(payload.imported_id, null);
  assert.equal(Object.prototype.hasOwnProperty.call(payload, 'subtransactions'), false);
});

test('forwardReferenceMigrationLocked is false before plan and true after reference migration starts', () => {
  const prePlan = {
    phase: 'replacement_ready',
    referenceMigration: null,
  };
  assert.equal(forwardReferenceMigrationLocked(prePlan), false);
  const planned = {
    phase: 'references_pending',
    referenceMigration: {
      direction: 'forward',
      idMap: { 'old-parent': 'new-parent' },
      completed: [],
    },
  };
  assert.equal(forwardReferenceMigrationLocked(planned), true);
});

test('postMigrationReplacementDriftReason detects stale idMap after reference migration', () => {
  const saga = {
    phase: 'sync_pending',
    replacementIds: { parentId: 'new-parent', legIds: ['leg-a', 'leg-b'] },
    idMap: { 'old-parent': 'new-parent', 'old-leg-a': 'leg-a', 'old-leg-b': 'leg-b' },
    referenceMigration: {
      direction: 'forward',
      idMap: { 'old-parent': 'new-parent', 'old-leg-a': 'leg-a', 'old-leg-b': 'leg-b' },
      completed: ['receipts'],
    },
  };
  const transaction = {
    id: 'new-parent',
    date: '2026-07-09',
    amount: -1000,
    payee: 'payee-id',
    is_parent: true,
    subtransactions: [
      { id: 'leg-a-regenerated', parent_id: 'new-parent', amount: -500, category: 'cat-1' },
      { id: 'leg-b-regenerated', parent_id: 'new-parent', amount: -500, category: 'cat-2' },
    ],
  };
  assert.match(
    postMigrationReplacementDriftReason(saga, transaction),
    /drifted after reference migration started/,
  );
});
