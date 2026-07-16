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
  addableTransaction,
  recoverTransactionSagas,
  replaceActualTransaction,
  transactionReplacementMap,
} = require('../dataModule');
test.beforeEach(() => {
  fs.rmSync(process.env.TRANSACTION_SAGAS_PATH, { force: true });
});
test.after(() => fs.rmSync(dir, { recursive: true, force: true }));

function fakeApi(original, { failFirstAdd = false } = {}) {
  let rows = [structuredClone(original)];
  let sequence = 0;
  let addCalls = 0;
  return {
    async getTransactions() { return structuredClone(rows); },
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
