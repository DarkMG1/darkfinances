'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const os = require('os');
const path = require('path');
const {
  REFERENCE_STEPS: TRANSACTION_DELETION_REFERENCE_STEPS,
} = require('../lib/transaction-deletion-references');
const {
  canonicalTransactionSnapshot,
  createTransactionDeletionSaga,
  transactionDeletionFingerprint,
} = require('../lib/transaction-deletion-saga');

const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'darkfinances-delete-callers-'));
const stateFiles = {
  PERSONAL_CONFIG_PATH: 'personal.json',
  RECEIPTS_PATH: 'receipts.json',
  RECEIPTS_DIR: 'receipts',
  REIMB_LINKS_PATH: 'links.json',
  REIMB_SUGGEST_PATH: 'suggestions.json',
  RECON_PATH: 'reconciliation.json',
  PHANTOM_SEEN_PATH: 'phantom-seen.json',
  PHANTOM_LOG_PATH: 'phantom-log.json',
  RULES_PATH: 'rules.json',
  TRANSACTION_SAGAS_PATH: 'transaction-sagas.json',
  TRANSACTION_DELETION_SAGAS_PATH: 'transaction-deletion-sagas.json',
  BULK_OPERATION_SAGAS_PATH: 'bulk-operation-sagas.json',
  OWES_TRUTH_PATH: 'owes-truth.json',
};
for (const [key, name] of Object.entries(stateFiles)) process.env[key] = path.join(dir, name);
process.env.ACTUAL_API_PATH = path.join(__dirname, 'fixtures', 'deletion-actual.js');

const fakeActual = require('./fixtures/deletion-actual');
const data = require('../dataModule');

const manualSplit = Object.freeze({
  id: 'manual-parent',
  account: 'account',
  date: '2026-07-10',
  amount: -1000,
  payee: 'payee',
  notes: 'manual split',
  cleared: true,
  imported_id: null,
  category: null,
  is_parent: true,
  subtransactions: [
    {
      id: 'manual-leg-a',
      parent_id: 'manual-parent',
      amount: -400,
      category: 'category-a',
      notes: 'a',
    },
    {
      id: 'manual-leg-b',
      parent_id: 'manual-parent',
      amount: -600,
      category: 'category-b',
      notes: 'b',
    },
  ],
});

function writeJson(file, value) {
  fs.writeFileSync(file, `${JSON.stringify(value, null, 2)}\n`);
}

function readJson(file) {
  return JSON.parse(fs.readFileSync(file, 'utf8'));
}

function reset(rows = [manualSplit]) {
  fs.rmSync(dir, { recursive: true, force: true });
  fs.mkdirSync(process.env.RECEIPTS_DIR, { recursive: true });
  fakeActual.configure({ rows });
  writeJson(process.env.RECEIPTS_PATH, {
    unknown: 'keep',
    byTxn: {
      [manualSplit.id]: [{
        id: 'receipt',
        txnId: manualSplit.id,
        file: 'receipt.jpg',
      }],
    },
  });
  fs.writeFileSync(path.join(process.env.RECEIPTS_DIR, 'receipt.jpg'), 'receipt bytes');
  writeJson(process.env.REIMB_LINKS_PATH, { links: [] });
  writeJson(process.env.REIMB_SUGGEST_PATH, { confirmed: {}, dismissed: [] });
  writeJson(process.env.RECON_PATH, { enabled: false, months: {} });
  writeJson(process.env.PHANTOM_SEEN_PATH, { seen: {} });
  writeJson(process.env.PHANTOM_LOG_PATH, { deleted: [] });
  writeJson(process.env.BULK_OPERATION_SAGAS_PATH, { schemaVersion: 1, sagas: {} });
}

function deletionState() {
  if (!fs.existsSync(process.env.TRANSACTION_DELETION_SAGAS_PATH)) {
    return { schemaVersion: 1, sagas: {} };
  }
  return readJson(process.env.TRANSACTION_DELETION_SAGAS_PATH);
}

function latestDeletion() {
  return Object.values(deletionState().sagas)
    .sort((left, right) => String(right.updatedAt).localeCompare(String(left.updatedAt)))[0] || null;
}

function activeDeletionRecord({
  phase = 'delete_pending',
  accountId = 'account',
  parentId = manualSplit.id,
  legIds = manualSplit.subtransactions.map((leg) => leg.id),
} = {}) {
  return {
    id: 'active-delete',
    recordVersion: 1,
    phase,
    status: phase === 'completed' ? 'completed' : 'started',
    accountId,
    date: manualSplit.date,
    target: {
      parentId,
      legIds,
      ids: [parentId, ...legIds],
    },
    updatedAt: '2026-07-10T00:00:00.000Z',
  };
}

test.before(async () => {
  reset();
  await data.initApi();
});

test.after(() => fs.rmSync(dir, { recursive: true, force: true }));

test('direct deletion uses a separate saga and keeps receipt bytes until sync', async () => {
  reset();
  const result = await data.deleteTransaction({
    id: manualSplit.id,
    accountId: 'account',
    date: manualSplit.date,
  });

  assert.deepEqual(result, {
    ok: true,
    deleted: manualSplit.id,
    references: {
      receipts: 1,
      links: 0,
      suggestions: 0,
      reconciliation: 0,
      phantomSeen: 0,
    },
  });
  assert.equal(fakeActual.inspect().counts.delete, 1);
  assert.equal(latestDeletion().phase, 'sync_pending');
  assert.equal(readJson(process.env.RECEIPTS_PATH).byTxn[manualSplit.id], undefined);
  assert.ok(fs.existsSync(path.join(process.env.RECEIPTS_DIR, 'receipt.jpg')));

  await data.syncNow();
  assert.equal(latestDeletion().phase, 'completed');
  assert.equal(fakeActual.inspect().counts.sync, 1);
  assert.equal(fs.existsSync(path.join(process.env.RECEIPTS_DIR, 'receipt.jpg')), false);
  assert.equal(fs.existsSync(process.env.TRANSACTION_SAGAS_PATH), false);
});

test('sync resumes an apply-then-throw deletion before synchronizing', async () => {
  reset();
  const deleteTransaction = data.api.deleteTransaction;
  let responseLost = false;
  data.api.deleteTransaction = async (id) => {
    await deleteTransaction(id);
    if (!responseLost) {
      responseLost = true;
      throw new Error('Actual delete response lost');
    }
  };

  try {
    await assert.rejects(
      data.deleteTransaction({
        id: manualSplit.id,
        accountId: 'account',
        date: manualSplit.date,
      }),
      /response lost/,
    );
    assert.equal(fakeActual.inspect().counts.delete, 1);
    assert.equal(latestDeletion().phase, 'delete_pending');
    assert.ok(readJson(process.env.RECEIPTS_PATH).byTxn[manualSplit.id]);
    assert.ok(fs.existsSync(path.join(process.env.RECEIPTS_DIR, 'receipt.jpg')));

    await data.syncNow();
    assert.equal(fakeActual.inspect().counts.delete, 1);
    assert.equal(fakeActual.inspect().counts.sync, 1);
    assert.equal(latestDeletion().phase, 'completed');
    assert.equal(readJson(process.env.RECEIPTS_PATH).byTxn[manualSplit.id], undefined);
    assert.equal(fs.existsSync(path.join(process.env.RECEIPTS_DIR, 'receipt.jpg')), false);
  } finally {
    data.api.deleteTransaction = deleteTransaction;
  }
});

test('sync completes a healthy deletion before surfacing an independent drive error', async () => {
  const blocked = {
    id: 'blocked-parent',
    account: 'account',
    date: manualSplit.date,
    amount: -700,
    payee: 'payee',
    notes: 'blocked',
    cleared: true,
    imported_id: null,
    category: 'category',
    is_parent: false,
    subtransactions: [],
  };
  reset([manualSplit, blocked]);
  await data.deleteTransaction({
    id: manualSplit.id,
    accountId: 'account',
    date: manualSplit.date,
  });

  const state = deletionState();
  const ready = Object.values(state.sagas)[0];
  const staleSnapshot = canonicalTransactionSnapshot({ ...blocked, amount: -999 });
  state.sagas.blocked = {
    id: 'blocked',
    recordVersion: 1,
    status: 'started',
    phase: 'delete_pending',
    accountId: 'account',
    date: blocked.date,
    target: {
      parentId: blocked.id,
      legIds: [],
      ids: [blocked.id],
      snapshot: staleSnapshot,
      fingerprint: transactionDeletionFingerprint(staleSnapshot),
    },
    startedAt: '2026-07-10T00:00:00.000Z',
    updatedAt: '2026-07-10T00:00:00.000Z',
  };
  writeJson(process.env.TRANSACTION_DELETION_SAGAS_PATH, state);

  await assert.rejects(data.syncNow(), /financial shape changed/);
  let recovered = deletionState().sagas;
  assert.equal(fakeActual.inspect().counts.sync, 1);
  assert.equal(fakeActual.inspect().counts.delete, 1);
  assert.equal(recovered[ready.id].phase, 'completed');
  assert.equal(recovered.blocked.phase, 'delete_pending');
  assert.equal(fakeActual.inspect().rows.some((row) => row.id === blocked.id), true);
  assert.equal(fs.existsSync(path.join(process.env.RECEIPTS_DIR, 'receipt.jpg')), false);

  const completed = JSON.stringify(recovered[ready.id]);
  await assert.rejects(data.syncNow(), /financial shape changed/);
  recovered = deletionState().sagas;
  assert.equal(fakeActual.inspect().counts.sync, 2);
  assert.equal(fakeActual.inspect().counts.delete, 1);
  assert.equal(JSON.stringify(recovered[ready.id]), completed);
  assert.equal(fs.existsSync(path.join(process.env.RECEIPTS_DIR, 'receipt.jpg')), false);
});

test('replacement ownership blocks transaction and reference mutations before effects', async () => {
  reset();
  writeJson(process.env.TRANSACTION_SAGAS_PATH, {
    schemaVersion: 1,
    sagas: {
      active: {
        id: 'replacement-active',
        recordVersion: 2,
        phase: 'replacement_ready',
        status: 'aborted',
        accountId: 'account',
        original: structuredClone(manualSplit),
      },
    },
  });

  await assert.rejects(
    data.deleteTransaction({
      id: manualSplit.id,
      accountId: 'account',
      date: manualSplit.date,
    }),
    (error) => error.code === 'TRANSACTION_REPLACEMENT_IN_PROGRESS' && error.status === 409,
  );
  for (const call of [
    () => data.setTransactionDate({ id: manualSplit.id, date: '2026-07-11' }),
    () => data.deleteReceipt({ id: 'receipt' }),
    () => data.addReimbLink({
      inflow: { id: manualSplit.id, amount: 10 },
      expense: { id: 'unrelated', amount: -10 },
    }),
    () => data.setReconcileItem({
      month: manualSplit.date.slice(0, 7),
      id: manualSplit.id,
      reconciled: true,
    }),
  ]) {
    await assert.rejects(
      async () => call(),
      (error) => error.code === 'TRANSACTION_REPLACEMENT_IN_PROGRESS',
    );
  }
  assert.equal(fakeActual.inspect().counts.delete, 0);
  assert.equal(fakeActual.inspect().counts.update, 0);
  assert.equal(Object.keys(deletionState().sagas).length, 0);
  assert.ok(fs.existsSync(path.join(process.env.RECEIPTS_DIR, 'receipt.jpg')));
});

test('deletion remove passes canonical original into assertExternalAvailable', async () => {
  reset();
  let captured = null;
  const api = {
    async getTransactions() {
      return [structuredClone(manualSplit)];
    },
    async deleteTransaction() {
      throw new Error('should not delete before hook');
    },
    async sync() {},
  };
  const manager = createTransactionDeletionSaga({
    sagaPath: process.env.TRANSACTION_DELETION_SAGAS_PATH,
    planReferences: () => ({ steps: [], stats: {} }),
    applyReferenceStep: async () => {},
    referencesConverged: () => true,
    referenceSteps: TRANSACTION_DELETION_REFERENCE_STEPS,
    receiptFileState: () => ({ keep: [], remove: [] }),
    unlinkReceiptFile: () => {},
    assertExternalAvailable: (args) => {
      captured = args;
      throw new Error('hook-stop');
    },
  });

  await assert.rejects(
    manager.remove(api, {
      accountId: 'account',
      date: manualSplit.date,
      transaction: manualSplit,
    }),
    /hook-stop/,
  );
  assert.equal(captured.original.id, manualSplit.id);
  assert.equal(captured.accountId, 'account');
});

test('active deletion blocks a second delete and every replacement caller for its ids', async () => {
  reset();
  writeJson(process.env.TRANSACTION_DELETION_SAGAS_PATH, {
    schemaVersion: 1,
    sagas: { active: activeDeletionRecord() },
  });

  await assert.rejects(
    data.deleteTransaction({
      id: manualSplit.subtransactions[0].id,
      accountId: 'account',
      date: manualSplit.date,
      allowImported: true,
    }),
    (error) => error.code === 'TRANSACTION_DELETION_IN_PROGRESS',
  );

  const mutationCalls = [
    () => data.replaceActualTransaction(fakeActual, {
      accountId: 'account',
      original: structuredClone(manualSplit),
      replacement: data.addableTransaction(manualSplit),
    }),
    () => data.splitTransaction({
      id: manualSplit.id,
      accountId: 'account',
      date: manualSplit.date,
      legs: [
        { id: 'manual-leg-a', amount: -4, categoryId: 'category-a' },
        { id: 'manual-leg-b', amount: -6, categoryId: 'category-b' },
      ],
    }),
    () => data.removeSplit({
      id: manualSplit.id,
      accountId: 'account',
      date: manualSplit.date,
    }),
    () => data.setTransactionCategory({
      id: 'manual-leg-a',
      categoryId: 'category-new',
      isLeg: true,
      parentId: manualSplit.id,
      accountId: 'account',
      date: manualSplit.date,
    }),
    () => data.setPayee({
      id: 'manual-leg-a',
      payee: 'New payee',
      isLeg: true,
      parentId: manualSplit.id,
      accountId: 'account',
      date: manualSplit.date,
    }),
    () => data.setTransactionNotes({
      id: 'manual-leg-a',
      notes: 'new notes',
      isLeg: true,
      parentId: manualSplit.id,
      accountId: 'account',
      date: manualSplit.date,
    }),
    () => data.setTransactionCategory({
      id: manualSplit.id,
      categoryId: 'category-new',
      accountId: 'account',
    }),
    () => data.setTransactionCategory({
      id: manualSplit.id,
      categoryId: 'category-new',
      accountId: 'other-account',
    }),
    () => data.setPayee({
      id: manualSplit.id,
      payee: 'New payee',
      accountId: 'account',
    }),
    () => data.setTransactionNotes({
      id: manualSplit.id,
      notes: 'new notes',
      accountId: 'account',
    }),
    () => data.setTransactionDate({
      id: manualSplit.id,
      date: '2026-07-11',
    }),
    () => data.addReceipt({
      txnId: manualSplit.id,
      imageBase64: Buffer.from('image').toString('base64'),
      mime: 'image/jpeg',
    }),
    () => data.deleteReceipt({ id: 'receipt' }),
    () => data.addReimbLink({
      inflow: { id: manualSplit.id, amount: 10 },
      expense: { id: 'unrelated', amount: -10 },
    }),
    () => data.deleteReimbLink({
      inflowId: manualSplit.id,
      expenseId: 'unrelated',
    }),
    () => data.confirmRepayment({ id: `sg_${manualSplit.id}` }),
    () => data.dismissRepayment({ id: `sg_${manualSplit.id}` }),
    () => data.undismissRepayment({ inflowId: manualSplit.id }),
    () => data.setReconcileItem({
      month: manualSplit.date.slice(0, 7),
      id: manualSplit.id,
      reconciled: true,
    }),
  ];
  for (const call of mutationCalls) {
    await assert.rejects(
      async () => call(),
      (error) => error.code === 'TRANSACTION_DELETION_IN_PROGRESS',
    );
  }
  assert.deepEqual(fakeActual.inspect().counts, {
    delete: 0,
    add: 0,
    update: 0,
    sync: 0,
    createAccount: 0,
    createCategory: 0,
  });
});

test('unrelated and terminal deletion sagas do not block admission', () => {
  reset();
  writeJson(process.env.TRANSACTION_DELETION_SAGAS_PATH, {
    schemaVersion: 1,
    sagas: {
      unrelated: activeDeletionRecord({
        accountId: 'other-account',
        parentId: 'other-parent',
        legIds: [],
      }),
      terminal: activeDeletionRecord({ phase: 'completed' }),
    },
  });
  assert.doesNotThrow(() => data.assertTransactionDeletionAvailable({
    accountId: 'account',
    ids: [manualSplit.id],
  }));
  assert.doesNotThrow(() => data.assertTransactionReplacementAvailable({
    accountId: 'account',
    ids: [manualSplit.subtransactions[0].id],
  }));
  assert.throws(
    () => data.assertTransactionMutationAvailable({ ids: ['other-parent'] }),
    (error) => error.code === 'TRANSACTION_DELETION_IN_PROGRESS',
  );
});

test('imported user deletion is rejected before saga creation', async () => {
  const imported = {
    ...manualSplit,
    id: 'imported-parent',
    is_parent: false,
    subtransactions: [],
    imported_id: 'bank-import',
  };
  reset([imported]);
  await assert.rejects(
    data.deleteTransaction({
      id: imported.id,
      accountId: 'account',
      date: imported.date,
    }),
    /Bank-imported transactions can’t be deleted/,
  );
  assert.equal(fakeActual.inspect().counts.delete, 0);
  assert.equal(Object.keys(deletionState().sagas).length, 0);
});

test('malformed sidecar preflight creates no saga and performs no Actual mutation', async () => {
  reset();
  writeJson(process.env.REIMB_LINKS_PATH, { links: null, unrelated: 'preserve' });
  await assert.rejects(
    data.deleteTransaction({
      id: manualSplit.id,
      accountId: 'account',
      date: manualSplit.date,
    }),
    (error) => error.code === 'JSON_INVALID_SHAPE',
  );
  assert.equal(fakeActual.inspect().counts.delete, 0);
  assert.equal(Object.keys(deletionState().sagas).length, 0);
  assert.ok(fs.existsSync(path.join(process.env.RECEIPTS_DIR, 'receipt.jpg')));
});

test('authorized phantom cleanup routes each Actual deletion through the saga', async () => {
  const phantom = {
    id: 'phantom',
    account: 'account',
    date: '2026-07-01',
    amount: -1200,
    payee: 'payee',
    notes: 'temporary authorization hold expected to drop',
    cleared: false,
    imported_id: 'pending-bank-id',
    is_parent: false,
    subtransactions: [],
  };
  reset([phantom]);
  writeJson(process.env.RECEIPTS_PATH, { byTxn: {} });
  writeJson(process.env.PHANTOM_SEEN_PATH, {
    seen: {
      [phantom.id]: {
        firstSeen: `${phantom.date}T12:00:00.000Z`,
        lastSeen: `${phantom.date}T12:00:00.000Z`,
      },
    },
  });
  const result = await data.cleanupPhantoms({
    window: 60,
    agedDays: 0,
    observeDays: 0,
    holdAgedDays: 0,
    holdObserveDays: 0,
  });
  assert.equal(result.deletedCount, 1);
  assert.equal(fakeActual.inspect().counts.delete, 1);
  assert.equal(latestDeletion().target.parentId, phantom.id);
  assert.equal(latestDeletion().phase, 'sync_pending');
  await data.syncNow();
  assert.equal(latestDeletion().phase, 'completed');
});

test('dynamic rule application refuses to update an owned transaction', async () => {
  const simple = {
    ...manualSplit,
    id: 'rule-owned',
    notes: 'rule target',
    category: null,
    is_parent: false,
    subtransactions: [],
  };
  reset([simple]);
  writeJson(process.env.TRANSACTION_DELETION_SAGAS_PATH, {
    schemaVersion: 1,
    sagas: {
      active: activeDeletionRecord({ parentId: simple.id, legIds: [] }),
    },
  });

  await assert.rejects(
    data.saveRule({ match: 'Merchant', categoryId: 'category-new' }, { sync: false }),
    (error) => error.code === 'TRANSACTION_DELETION_IN_PROGRESS',
  );
  assert.equal(fakeActual.inspect().counts.update, 0);
});

test('reimbursement sweep refuses to recategorize an owned discovered transaction', async () => {
  const expense = {
    id: 'owned-reimbursement-expense',
    account: 'account',
    date: manualSplit.date,
    amount: -1200,
    payee: 'payee',
    notes: 'fronted for #alex',
    cleared: true,
    imported_id: null,
    category: 'category',
    is_parent: false,
    subtransactions: [],
  };
  reset([expense]);
  fakeActual.configure({
    rows: [expense],
    accounts: [{ id: 'account', name: 'Account', closed: false, offbudget: false }],
    payees: [{ id: 'payee', name: 'Merchant' }],
    categoryGroups: [{
      id: 'spending',
      name: 'Spending',
      is_income: false,
      categories: [
        { id: 'category', name: 'Dining' },
        { id: 'reimbursement', name: 'Reimbursement' },
      ],
    }],
  });
  writeJson(process.env.TRANSACTION_DELETION_SAGAS_PATH, {
    schemaVersion: 1,
    sagas: {
      active: activeDeletionRecord({ parentId: expense.id, legIds: [] }),
    },
  });

  await assert.rejects(
    data.sweepReimbursementTags({
      tags: ['alex'],
      from: expense.date,
      to: expense.date,
    }),
    (error) => error.code === 'TRANSACTION_DELETION_IN_PROGRESS',
  );
  assert.equal(fakeActual.inspect().counts.update, 0);
  assert.equal(fakeActual.inspect().rows[0].category, expense.category);
});

test('phantom cleanup refuses an owned pending transaction before sidecar writes', async () => {
  const phantom = {
    id: 'owned-phantom',
    account: 'account',
    date: '2026-07-01',
    amount: -1200,
    payee: 'payee',
    notes: 'temporary authorization hold expected to drop',
    cleared: false,
    imported_id: 'pending-bank-id',
    is_parent: false,
    subtransactions: [],
  };
  reset([phantom]);
  const seen = {
    seen: {
      [phantom.id]: {
        firstSeen: `${phantom.date}T12:00:00.000Z`,
        lastSeen: `${phantom.date}T12:00:00.000Z`,
      },
    },
  };
  writeJson(process.env.PHANTOM_SEEN_PATH, seen);
  writeJson(process.env.TRANSACTION_DELETION_SAGAS_PATH, {
    schemaVersion: 1,
    sagas: {
      active: activeDeletionRecord({ parentId: phantom.id, legIds: [] }),
    },
  });

  await assert.rejects(
    data.cleanupPhantoms({
      window: 60,
      agedDays: 0,
      observeDays: 0,
      holdAgedDays: 0,
      holdObserveDays: 0,
    }),
    (error) => error.code === 'TRANSACTION_DELETION_IN_PROGRESS',
  );
  assert.equal(fakeActual.inspect().counts.delete, 0);
  assert.deepEqual(readJson(process.env.PHANTOM_SEEN_PATH), seen);
});

test('Splitwise mirror update refuses an owned discovered transaction', async () => {
  const mirrored = {
    id: 'owned-mirror-row',
    account: 'splitwise-account',
    date: '2026-07-10',
    amount: -500,
    payee: null,
    notes: 'mirror #sw-123',
    cleared: true,
    imported_id: null,
    category: 'splitwise-category',
    is_parent: false,
    subtransactions: [],
  };
  reset([mirrored]);
  fakeActual.configure({
    rows: [mirrored],
    accounts: [{
      id: 'splitwise-account',
      name: 'Splitwise',
      closed: false,
      offbudget: false,
    }],
    categoryGroups: [{
      id: 'spending',
      name: 'Spending',
      is_income: false,
      categories: [{ id: 'splitwise-category', name: 'Splitwise' }],
    }],
  });
  writeJson(process.env.TRANSACTION_DELETION_SAGAS_PATH, {
    schemaVersion: 1,
    sagas: {
      active: activeDeletionRecord({
        accountId: 'splitwise-account',
        parentId: mirrored.id,
        legIds: [],
      }),
    },
  });
  writeJson(process.env.OWES_TRUTH_PATH, {
    schemaVersion: 2,
    generatedAt: new Date().toISOString(),
    manifest: {
      complete: true,
      itemizedComplete: true,
      resolvedEvents: 0,
      expectedEvents: 0,
      failedEvents: [],
      currency: 'USD',
    },
    othersPaidItems: [{
      id: '123',
      myShare: 7,
      currency: 'USD',
      date: mirrored.date,
      desc: 'changed mirror',
    }],
  });

  await assert.rejects(
    data.syncSplitwiseShareExpenses({ sync: false }),
    (error) => error.code === 'TRANSACTION_DELETION_IN_PROGRESS',
  );
  assert.equal(fakeActual.inspect().counts.update, 0);
  assert.equal(fakeActual.inspect().rows[0].amount, mirrored.amount);
});

test('Splitwise mirror pruning routes individual deletes through the saga', async () => {
  const mirrored = {
    id: 'mirror-row',
    account: 'splitwise-account',
    date: '2026-07-10',
    amount: -500,
    payee: null,
    notes: 'old mirror #sw-123',
    cleared: true,
    imported_id: null,
    category: 'splitwise-category',
    is_parent: false,
    subtransactions: [],
  };
  reset([mirrored]);
  writeJson(process.env.RECEIPTS_PATH, { byTxn: {} });
  fakeActual.configure({
    rows: [mirrored],
    accounts: [{
      id: 'splitwise-account',
      name: 'Splitwise',
      closed: false,
      offbudget: false,
    }],
    categoryGroups: [{
      id: 'spending',
      name: 'Spending',
      is_income: false,
      categories: [{ id: 'splitwise-category', name: 'Splitwise' }],
    }],
  });
  writeJson(process.env.OWES_TRUTH_PATH, {
    schemaVersion: 2,
    generatedAt: new Date().toISOString(),
    manifest: {
      complete: true,
      itemizedComplete: true,
      resolvedEvents: 0,
      expectedEvents: 0,
      failedEvents: [],
      currency: 'USD',
    },
    othersPaidItems: [],
  });

  const result = await data.syncSplitwiseShareExpenses({ sync: false });
  assert.equal(result.pruned, 1);
  assert.equal(fakeActual.inspect().counts.delete, 1);
  assert.equal(latestDeletion().target.parentId, mirrored.id);
  assert.equal(latestDeletion().phase, 'sync_pending');
  await data.syncNow();
  assert.equal(latestDeletion().phase, 'completed');
});
