const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const os = require('os');
const path = require('path');
const { migrateLinkToSchemaV2 } = require('../lib/reimbursement-allocation');

const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'darkfinances-replacement-faults-'));
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
  SagaInterruption,
  addableTransaction,
  assertTransactionReplacementAvailable,
  recoverTransactionSagas,
  replaceActualTransaction,
} = require('../dataModule');

test.after(() => fs.rmSync(dir, { recursive: true, force: true }));

const original = Object.freeze({
  id: 'old-parent',
  account: 'account',
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
});

const decoy = Object.freeze({
  ...original,
  id: 'identical-decoy',
  imported_id: 'lookalike-import-id',
});
const unrelated = Object.freeze({
  id: 'unrelated-live',
  account: 'account',
  date: original.date,
  amount: 2500,
  payee: 'other-payee',
  cleared: true,
  imported_id: 'unrelated-import',
  is_parent: false,
  subtransactions: [],
});

function intendedSplit(source = original) {
  return addableTransaction(source, {
    category: undefined,
    subtransactions: [
      { amount: -333, category: 'cat-1', notes: 'first leg', payee: 'leg-payee-1' },
      { amount: -667, category: 'cat-2', notes: 'second leg', payee: 'leg-payee-2' },
    ],
  });
}

const manualOriginal = Object.freeze({
  id: 'manual-parent',
  account: 'account',
  date: '2026-07-09',
  amount: -1234,
  payee: 'payee-id',
  notes: '[clone-smoke]',
  cleared: false,
  imported_id: null,
  category: 'cat-1',
  is_parent: false,
  subtransactions: [],
});

function manualCloneSplit(source = manualOriginal) {
  return addableTransaction(source, {
    category: undefined,
    subtransactions: [
      { amount: -500, category: 'cat-1', notes: 'first' },
      { amount: -734, category: 'cat-1', notes: 'second' },
    ],
  });
}

function writeJson(file, value) {
  fs.writeFileSync(file, `${JSON.stringify(value, null, 2)}\n`);
}

function resetStores(referenceId = original.id) {
  fs.rmSync(dir, { recursive: true, force: true });
  fs.mkdirSync(process.env.RECEIPTS_DIR, { recursive: true });
  writeJson(process.env.RECEIPTS_PATH, {
    byTxn: {
      [referenceId]: [{ id: 'receipt-1', txnId: referenceId, file: 'receipt.jpg' }],
    },
  });
  fs.writeFileSync(path.join(process.env.RECEIPTS_DIR, 'receipt.jpg'), 'sanitized receipt fixture');
  writeJson(process.env.REIMB_LINKS_PATH, {
    schemaVersion: 2,
    links: [{
      linkKey: `${referenceId}:${unrelated.id}`,
      inflow: { id: referenceId, date: original.date, payee: 'Refund', amount: 10 },
      expense: { id: unrelated.id, date: original.date, payee: 'Expense', amount: -25 },
      allocationCents: 1000,
      amount: 10,
      version: 1,
    }],
  });
  writeJson(process.env.REIMB_SUGGEST_PATH, {
    dismissed: [referenceId],
    confirmed: {
      [`sg_${referenceId}`]: { at: '2026-07-09T00:00:00.000Z', inflowId: referenceId, allocations: [] },
    },
  });
  writeJson(process.env.RECON_PATH, {
    enabled: true,
    months: {
      '2026-07': { done: false, items: { [referenceId]: '2026-07-09T00:00:00.000Z' } },
    },
  });
  writeJson(process.env.PHANTOM_SEEN_PATH, {
    seen: { [referenceId]: { firstSeen: '2026-07-09', lastSeen: '2026-07-09' } },
  });
}

function materializeAdded(transaction, id, accountId = 'account') {
  const subtransactions = (transaction.subtransactions || []).map((leg, index) => ({
    ...structuredClone(leg),
    id: `${id}-leg-${index + 1}`,
    parent_id: id,
  }));
  return {
    ...structuredClone(transaction),
    id,
    account: accountId,
    is_parent: subtransactions.length > 0,
    subtransactions,
  };
}

function durableActual({
  rows = [original, decoy, unrelated],
  applyThenThrowReplacement = false,
  applyThenThrowRestoration = false,
  applyThenThrowRollbackDelete = false,
  addError = null,
  ignoreSparseNullImportedIdUpdates = false,
  deferImportedIdUntilSync = false,
} = {}) {
  const state = {
    rows: structuredClone(rows),
    accounts: [
      { id: 'account', name: 'Account', closed: false, offbudget: false },
      { id: 'closed-account', name: 'Closed', closed: true, offbudget: false },
      { id: 'offbudget-account', name: 'Off Budget', closed: false, offbudget: true },
    ],
    failAccountEnumeration: false,
    queryFailures: new Set(),
    sequence: 0,
    fired: new Set(),
    counts: { add: 0, delete: 0, update: 0, sync: 0 },
  };
  const adapter = {
    state,
    async getAccounts() {
      if (state.failAccountEnumeration) throw new Error('Actual account enumeration failed');
      return structuredClone(state.accounts);
    },
    async getTransactions(accountId, start, end) {
      if (state.queryFailures.has(String(accountId))) {
        throw new Error(`Actual transaction query failed for ${accountId}`);
      }
      return state.rows
        .filter((row) => row.account === accountId && row.date >= start && row.date <= end)
        .map((row) => {
          const copy = structuredClone(row);
          if (deferImportedIdUntilSync && row._staleImportedId !== undefined) {
            copy.imported_id = row._staleImportedId;
          }
          return copy;
        });
    },
    async deleteTransaction(id) {
      state.counts.delete += 1;
      const row = state.rows.find((candidate) => String(candidate.id) === String(id));
      state.rows = state.rows.filter((candidate) => String(candidate.id) !== String(id));
      if (applyThenThrowRollbackDelete
        && row?.id?.startsWith('actual-')
        && !state.fired.has('rollback-delete')) {
        state.fired.add('rollback-delete');
        throw new Error('rollback delete response lost');
      }
    },
    async addTransactions(accountId, [transaction]) {
      state.counts.add += 1;
      if (addError && !state.fired.has('add-error')) {
        state.fired.add('add-error');
        throw addError;
      }
      const id = `actual-${++state.sequence}`;
      state.rows.push(materializeAdded(transaction, id, accountId));
      const importedId = String(transaction.imported_id || '');
      if (applyThenThrowReplacement
        && importedId.startsWith('df-replace:')
        && !state.fired.has('replacement-add')) {
        state.fired.add('replacement-add');
        throw new Error('replacement add response lost');
      }
      if (applyThenThrowRestoration
        && importedId.startsWith('df-restore:')
        && !state.fired.has('restoration-add')) {
        state.fired.add('restoration-add');
        throw new Error('restoration add response lost');
      }
    },
    async updateTransaction(id, fields) {
      state.counts.update += 1;
      const row = state.rows.find((candidate) => String(candidate.id) === String(id));
      if (!row) return;
      const patch = structuredClone(fields);
      if (ignoreSparseNullImportedIdUpdates
        && Object.keys(patch).length === 1
        && patch.imported_id === null) {
        return;
      }
      if (Array.isArray(patch.subtransactions) && row.is_parent) {
        patch.subtransactions = patch.subtransactions.map((leg, index) => ({
          ...structuredClone(leg),
          id: row.subtransactions?.[index]?.id || `${id}-leg-${index + 1}`,
          parent_id: id,
        }));
        Object.assign(row, patch);
        delete row.category;
        if (patch.imported_id === '') row.imported_id = null;
        return;
      }
      if (row.is_parent
        && Object.keys(patch).length === 1
        && Object.prototype.hasOwnProperty.call(patch, 'imported_id')) {
        for (const leg of row.subtransactions || []) {
          if (leg.payee == null) leg.payee = row.payee;
        }
      }
      if (deferImportedIdUntilSync && Object.prototype.hasOwnProperty.call(patch, 'imported_id')) {
        row._staleImportedId = row.imported_id;
      }
      Object.assign(row, patch);
      if (patch.imported_id === '') row.imported_id = null;
    },
    async sync() {
      state.counts.sync += 1;
      if (deferImportedIdUntilSync) {
        for (const row of state.rows) delete row._staleImportedId;
      }
    },
  };
  return adapter;
}

function faultSchedule(rules) {
  const entries = rules.map((rule) => ({ mode: 'crash', ...rule, fired: false }));
  const injector = async (point) => {
    const entry = entries.find((candidate) => !candidate.fired && candidate.point === point);
    if (!entry) return;
    entry.fired = true;
    if (entry.mode === 'error') throw new Error(entry.message || `injected error at ${point}`);
    throw new SagaInterruption(`injected crash at ${point}`);
  };
  injector.entries = entries;
  return injector;
}

function readSagaState() {
  if (!fs.existsSync(process.env.TRANSACTION_SAGAS_PATH)) return { schemaVersion: 1, sagas: {} };
  return JSON.parse(fs.readFileSync(process.env.TRANSACTION_SAGAS_PATH, 'utf8'));
}

function activeSaga() {
  return Object.values(readSagaState().sagas).find((saga) => !['completed', 'rolled_back'].includes(saga.phase)) || null;
}

function latestSaga() {
  return Object.values(readSagaState().sagas)
    .sort((left, right) => String(right.updatedAt).localeCompare(String(left.updatedAt)))[0] || null;
}

function actualMutationCounts(api) {
  const { add, delete: deleted, update, sync } = api.state.counts;
  return { add, delete: deleted, update, sync };
}

function readStores() {
  return {
    receipts: JSON.parse(fs.readFileSync(process.env.RECEIPTS_PATH, 'utf8')),
    links: JSON.parse(fs.readFileSync(process.env.REIMB_LINKS_PATH, 'utf8')),
    suggestions: JSON.parse(fs.readFileSync(process.env.REIMB_SUGGEST_PATH, 'utf8')),
    reconciliation: JSON.parse(fs.readFileSync(process.env.RECON_PATH, 'utf8')),
    phantomSeen: JSON.parse(fs.readFileSync(process.env.PHANTOM_SEEN_PATH, 'utf8')),
  };
}

function referenceSnapshotWithoutId(snapshot) {
  if (!snapshot || typeof snapshot !== 'object') return snapshot;
  const { id: _id, ...rest } = snapshot;
  return rest;
}

function referenceEvidence(stores) {
  return {
    receipts: Object.values(stores.receipts.byTxn || {})
      .flat()
      .map(({ txnId: _txnId, ...receipt }) => receipt)
      .sort((left, right) => String(left.id).localeCompare(String(right.id))),
    links: (stores.links.links || []).map((link) => ({
      amount: link.amount ?? null,
      allocationCents: link.allocationCents ?? null,
      person: link.person ?? null,
      inflow: referenceSnapshotWithoutId(link.inflow),
      expense: referenceSnapshotWithoutId(link.expense),
    })),
    suggestions: {
      dismissedCount: (stores.suggestions.dismissed || []).length,
      confirmed: Object.values(stores.suggestions.confirmed || {}).map((value) => ({
        ...value,
        inflowId: value.inflowId == null ? value.inflowId : '[transaction-id]',
        ...(value.inflow ? { inflow: referenceSnapshotWithoutId(value.inflow) } : {}),
        ...(value.expense ? { expense: referenceSnapshotWithoutId(value.expense) } : {}),
        ...(Array.isArray(value.allocations) ? {
          allocations: value.allocations.map((allocation) => ({
            ...allocation,
            ...(allocation.inflow
              ? { inflow: referenceSnapshotWithoutId(allocation.inflow) }
              : {}),
            ...(allocation.expense
              ? { expense: referenceSnapshotWithoutId(allocation.expense) }
              : {}),
          })),
        } : {}),
      })),
    },
    reconciliation: Object.fromEntries(
      Object.entries(stores.reconciliation.months || {}).map(([month, value]) => [
        month,
        { ...value, items: Object.values(value.items || {}).sort() },
      ]),
    ),
    phantomSeen: Object.values(stores.phantomSeen.seen || {})
      .sort((left, right) => JSON.stringify(left).localeCompare(JSON.stringify(right))),
  };
}

function collapsedReferenceSource() {
  return {
    ...original,
    id: 'collapse-parent',
    imported_id: 'collapse-bank-import',
    category: null,
    is_parent: true,
    subtransactions: [
      {
        id: 'collapse-leg-a',
        parent_id: 'collapse-parent',
        amount: -400,
        category: 'collapse-category-a',
        notes: 'collapse leg a',
        payee: 'collapse-payee-a',
      },
      {
        id: 'collapse-leg-b',
        parent_id: 'collapse-parent',
        amount: -600,
        category: 'collapse-category-b',
        notes: 'collapse leg b',
        payee: 'collapse-payee-b',
      },
    ],
  };
}

function writeCollapsedReferenceStores(source, { links = [], suggestions = { dismissed: [], confirmed: {} } }) {
  const receipt = {
    id: 'collapse-receipt',
    txnId: source.subtransactions[0].id,
    file: 'receipt.jpg',
    amount: 4,
    date: source.date,
    source: 'sanitized',
  };
  writeJson(process.env.RECEIPTS_PATH, {
    byTxn: { [source.subtransactions[0].id]: [receipt] },
  });
  fs.writeFileSync(path.join(process.env.RECEIPTS_DIR, receipt.file), 'preserved receipt bytes');
  writeJson(process.env.REIMB_LINKS_PATH, { schemaVersion: 2, links: links.map(migrateLinkToSchemaV2) });
  writeJson(process.env.REIMB_SUGGEST_PATH, suggestions);
  writeJson(process.env.RECON_PATH, {
    enabled: true,
    months: {
      '2026-07': {
        done: false,
        items: {
          [source.subtransactions[0].id]: 'collapse-reconciliation-a',
          [source.subtransactions[1].id]: 'collapse-reconciliation-b',
        },
      },
    },
  });
  writeJson(process.env.PHANTOM_SEEN_PATH, {
    seen: {
      [source.subtransactions[0].id]: { firstSeen: source.date, source: 'a' },
      [source.subtransactions[1].id]: { firstSeen: source.date, source: 'b' },
    },
  });
}

async function expectCollapsedReferenceRollback({ links, suggestions, errorPattern }) {
  const source = collapsedReferenceSource();
  resetStores(source.subtransactions[0].id);
  writeCollapsedReferenceStores(source, { links, suggestions });
  const storesBefore = readStores();
  const evidenceBefore = referenceEvidence(storesBefore);
  const receiptBefore = fs.readFileSync(path.join(process.env.RECEIPTS_DIR, 'receipt.jpg'));
  const api = durableActual({ rows: [source, unrelated] });
  const replacement = addableTransaction(source, { category: 'collapse-final-category' });
  delete replacement.subtransactions;

  await assert.rejects(
    replaceActualTransaction(api, {
      accountId: 'account',
      original: source,
      replacement,
    }),
    errorPattern,
  );
  assert.equal(latestSaga().phase, 'rolled_back');
  const storesAfter = readStores();
  assert.deepEqual(referenceEvidence(storesAfter), evidenceBefore);
  assertReferencesAreLive(api);
  assert.deepEqual(
    fs.readFileSync(path.join(process.env.RECEIPTS_DIR, 'receipt.jpg')),
    receiptBefore,
  );
  assert.deepEqual(fs.readdirSync(process.env.RECEIPTS_DIR), ['receipt.jpg']);

  const mutationsAfterRollback = actualMutationCounts(api);
  await recoverTransactionSagas(api);
  await recoverTransactionSagas(api);
  assert.deepEqual(actualMutationCounts(api), mutationsAfterRollback);
  assert.equal(latestSaga().phase, 'rolled_back');
  return { api, stores: storesAfter };
}

function referencedIds(stores) {
  const ids = [];
  for (const [id, receipts] of Object.entries(stores.receipts.byTxn || {})) {
    ids.push(id, ...(receipts || []).map((receipt) => String(receipt.txnId)));
  }
  for (const link of stores.links.links || []) ids.push(String(link.inflow.id), String(link.expense.id));
  ids.push(...(stores.suggestions.dismissed || []).map(String));
  for (const [key, value] of Object.entries(stores.suggestions.confirmed || {})) {
    if (key.startsWith('sg_')) ids.push(key.slice(3));
    if (value.inflowId != null) ids.push(String(value.inflowId));
    for (const allocation of Array.isArray(value.allocations) ? value.allocations : []) {
      if (allocation?.inflow?.id != null) ids.push(String(allocation.inflow.id));
      if (allocation?.expense?.id != null) ids.push(String(allocation.expense.id));
    }
  }
  for (const month of Object.values(stores.reconciliation.months || {})) {
    ids.push(...Object.keys(month.items || {}));
  }
  ids.push(...Object.keys(stores.phantomSeen.seen || {}));
  return ids;
}

function liveIds(api) {
  return new Set(api.state.rows.flatMap((row) => [
    String(row.id),
    ...(row.subtransactions || []).map((leg) => String(leg.id)),
  ]));
}

function assertMetadata(transaction, expected) {
  for (const field of ['date', 'amount', 'payee', 'notes', 'cleared', 'imported_id', 'imported_payee']) {
    assert.equal(transaction[field] ?? null, expected[field] ?? null, `preserves ${field}`);
  }
  const legs = transaction.subtransactions || [];
  assert.equal(legs.length, (expected.subtransactions || []).length);
  if (legs.length) {
    assert.equal(legs.reduce((sum, leg) => sum + leg.amount, 0), transaction.amount);
  }
}

function assertReferencesAreLive(api) {
  const stores = readStores();
  const live = liveIds(api);
  const ids = referencedIds(stores);
  assert.ok(ids.every((id) => live.has(id)), `dead sidecar reference in ${JSON.stringify(ids)}`);
  assert.ok(!ids.includes(decoy.id), 'identical-looking decoy was not selected');
  const referencedFiles = new Set(Object.values(stores.receipts.byTxn || {})
    .flatMap((receipts) => receipts.map((receipt) => receipt.file)));
  const files = fs.readdirSync(process.env.RECEIPTS_DIR);
  assert.deepEqual(new Set(files), referencedFiles, 'receipt directory has no orphaned file');
}

function assertConverged(api, expectedReplacement) {
  const saga = latestSaga();
  const sagaOwned = api.state.rows.filter((row) => row.id === original.id || row.id.startsWith('actual-'));
  assert.equal(sagaOwned.length, 1, 'exactly one saga-owned parent remains');
  const decoyAfter = api.state.rows.find((row) => row.id === decoy.id);
  assert.deepEqual(decoyAfter, structuredClone(decoy), 'identical-looking transaction remains untouched');

  if (!saga) {
    assert.equal(sagaOwned[0].id, original.id);
    assertMetadata(sagaOwned[0], original);
  } else if (saga.phase === 'completed') {
    assert.equal(sagaOwned[0].id, saga.replacementIds.parentId);
    assertMetadata(sagaOwned[0], expectedReplacement);
  } else {
    assert.equal(saga.phase, 'rolled_back');
    assert.equal(sagaOwned[0].id, saga.restoredIds.parentId);
    assertMetadata(sagaOwned[0], original);
  }
  assertReferencesAreLive(api);
}

async function recoverPastFault(api, injector) {
  for (let attempt = 0; attempt < 3; attempt += 1) {
    try {
      await recoverTransactionSagas(api, { faultInjector: injector });
    } catch (_) {}
  }
  await recoverTransactionSagas(api);
  const terminalBefore = JSON.stringify(latestSaga());
  const mutationsBefore = actualMutationCounts(api);
  await recoverTransactionSagas(api);
  await recoverTransactionSagas(api);
  assert.deepEqual(actualMutationCounts(api), mutationsBefore, 'terminal recovery repeats no Actual mutation or sync');
  assert.equal(JSON.stringify(latestSaga()), terminalBefore, 'terminal outcome is stable across repeated recovery');
}

async function interruptReplacement(api, replacement, injector) {
  await assert.rejects(
    replaceActualTransaction(api, {
      accountId: 'account',
      original,
      replacement,
      faultInjector: injector,
    }),
  );
  assert.ok(injector.entries.every((entry) => entry.fired), 'requested fault was reached');
}

test('manual split metadata restore clears temporary imported identity on Actual-like updates', async () => {
  resetStores(manualOriginal.id);
  const api = durableActual({
    rows: [manualOriginal, unrelated],
    ignoreSparseNullImportedIdUpdates: true,
  });
  const replacement = manualCloneSplit();
  const added = await replaceActualTransaction(api, {
    accountId: 'account',
    original: manualOriginal,
    replacement,
  });
  assert.equal(added.imported_id, null);
  assert.equal(added.subtransactions.length, 2);
  assert.equal(
    added.subtransactions.reduce((sum, leg) => sum + leg.amount, 0),
    added.amount,
  );
  for (const leg of added.subtransactions) {
    assert.equal(leg.payee ?? null, null, 'full payload restore must not normalize leg payees');
  }
  assert.equal(latestSaga().phase, 'sync_pending');
  assert.equal(api.state.counts.update, 1);
  assert.ok(api.state.counts.sync >= 1);
  const persisted = api.state.rows.find((row) => row.id === added.id);
  assert.equal(persisted.imported_id, null);
  assert.doesNotMatch(JSON.stringify(persisted), /"imported_id":""/);
});

const forwardBoundaries = [
  'initial-saga-write',
  'original-deletion',
  'replacement-add',
  'replacement-reconcile',
  'replacement-id-checkpoint',
  'reference-receipts-write',
  'reference-links-write',
  'reference-suggestions-write',
  'reference-reconciliation-write',
  'reference-phantomSeen-write',
  'reference-reviewState-write',
];

test('forward replacement converges across every durable fault boundary', async (t) => {
  for (const boundary of forwardBoundaries) {
    for (const side of ['before', 'after']) {
      await t.test(`${side}:${boundary}`, async () => {
        resetStores();
        const api = durableActual();
        const replacement = intendedSplit();
        const injector = faultSchedule([{ point: `${side}:${boundary}` }]);
        await interruptReplacement(api, replacement, injector);
        await recoverPastFault(api, injector);
        assertConverged(api, replacement);
      });
    }
  }
});

test('forward recovery checkpoints sync uncertainty before terminal completion', async (t) => {
  for (const side of ['before', 'after']) {
    await t.test(`${side}:sync`, async () => {
      resetStores();
      const api = durableActual();
      const replacement = intendedSplit();
      await replaceActualTransaction(api, {
        accountId: 'account',
        original,
        replacement,
      });
      assert.equal(activeSaga().phase, 'sync_pending');
      const syncFault = faultSchedule([{ point: `${side}:sync` }]);
      await assert.rejects(recoverTransactionSagas(api, { faultInjector: syncFault }));
      await recoverPastFault(api, syncFault);
      assertConverged(api, replacement);
    });
  }
});

test('forward terminal write is restart-safe before and after persistence', async (t) => {
  for (const side of ['before', 'after']) {
    await t.test(`${side}:saga-terminal-write`, async () => {
      resetStores();
      const api = durableActual();
      const replacement = intendedSplit();
      await replaceActualTransaction(api, {
        accountId: 'account',
        original,
        replacement,
      });
      const terminalFault = faultSchedule([{ point: `${side}:saga-terminal-write` }]);
      await assert.rejects(recoverTransactionSagas(api, { faultInjector: terminalFault }));
      await recoverPastFault(api, terminalFault);
      assertConverged(api, replacement);
    });
  }
});

test('apply-then-throw replacement add is reconciled by unique imported identity', async () => {
  resetStores();
  const api = durableActual({ applyThenThrowReplacement: true });
  const replacement = intendedSplit();
  await assert.rejects(replaceActualTransaction(api, {
    accountId: 'account',
    original,
    replacement,
  }), /response lost/);
  assert.equal(api.state.counts.add, 1);
  await recoverPastFault(api);
  assert.equal(api.state.counts.add, 1, 'recovery does not repeat an add that may have applied');
  assertConverged(api, replacement);
});

test('an original moved to a closed account before deletion remains untouched and nonterminal', async () => {
  resetStores();
  const api = durableActual();
  const replacement = intendedSplit();
  const interruption = faultSchedule([{ point: 'after:initial-saga-write' }]);
  await interruptReplacement(api, replacement, interruption);
  const storesBefore = readStores();
  const receiptBefore = fs.readFileSync(path.join(process.env.RECEIPTS_DIR, 'receipt.jpg'));
  api.state.rows.find((row) => row.id === original.id).account = 'closed-account';

  for (let attempt = 0; attempt < 3; attempt += 1) {
    await assert.rejects(
      recoverTransactionSagas(api),
      (error) => error.code === 'TRANSACTION_REPLACEMENT_OUTCOME_UNKNOWN'
        && /saga-owned transaction ids found outside replacement account: old-parent/.test(error.message),
    );
  }

  assert.equal(api.state.rows.find((row) => row.id === original.id).account, 'closed-account');
  assert.deepEqual(actualMutationCounts(api), { add: 0, delete: 0, update: 0, sync: 0 });
  assert.equal(activeSaga().phase, 'delete_pending');
  assert.deepEqual(readStores(), storesBefore);
  assert.deepEqual(
    fs.readFileSync(path.join(process.env.RECEIPTS_DIR, 'receipt.jpg')),
    receiptBefore,
  );
});

test('a checkpointed split replacement moved off-budget blocks rollback and reference effects', async () => {
  resetStores();
  const api = durableActual();
  const replacement = intendedSplit();
  const interruption = faultSchedule([{ point: 'after:replacement-id-checkpoint' }]);
  await interruptReplacement(api, replacement, interruption);
  const saga = activeSaga();
  assert.equal(saga.phase, 'replacement_identified');
  const replacementId = saga.replacementIds.parentId;
  const checkpointedIds = [replacementId, ...saga.replacementIds.legIds].sort();
  api.state.rows.find((row) => row.id === replacementId).account = 'offbudget-account';
  const countsBefore = actualMutationCounts(api);
  const storesBefore = readStores();

  for (let attempt = 0; attempt < 2; attempt += 1) {
    await assert.rejects(
      recoverTransactionSagas(api),
      /saga-owned transaction ids found outside replacement account/,
    );
  }

  const moved = api.state.rows.find((row) => row.id === replacementId);
  assert.equal(moved.account, 'offbudget-account');
  assert.deepEqual(
    [moved.id, ...moved.subtransactions.map((leg) => leg.id)].sort(),
    checkpointedIds,
  );
  assert.deepEqual(actualMutationCounts(api), countsBefore);
  assert.deepEqual(readStores(), storesBefore);
  assert.equal(activeSaga().phase, 'replacement_identified');
});

test('a checkpointed restored row moved across accounts remains nonterminal without recovery effects', async () => {
  resetStores();
  const api = durableActual();
  const replacement = intendedSplit();
  const interruption = faultSchedule([
    { point: 'before:reference-plan-checkpoint', mode: 'error' },
    { point: 'after:restored-id-checkpoint' },
  ]);
  await interruptReplacement(api, replacement, interruption);
  const saga = activeSaga();
  assert.equal(saga.phase, 'restored_identified');
  const restoredId = saga.restoredIds.parentId;
  api.state.rows.find((row) => row.id === restoredId).account = 'closed-account';
  const countsBefore = actualMutationCounts(api);
  const storesBefore = readStores();

  for (let attempt = 0; attempt < 2; attempt += 1) {
    await assert.rejects(
      recoverTransactionSagas(api),
      /saga-owned transaction ids found outside replacement account/,
    );
  }

  assert.equal(api.state.rows.find((row) => row.id === restoredId).account, 'closed-account');
  assert.deepEqual(actualMutationCounts(api), countsBefore);
  assert.deepEqual(readStores(), storesBefore);
  assert.equal(activeSaga().phase, 'restore_metadata_pending');
});

test('an uncheckpointed temporary replacement identity in another account prevents a duplicate add', async () => {
  resetStores();
  const api = durableActual();
  const replacement = intendedSplit();
  const interruption = faultSchedule([{ point: 'before:replacement-add' }]);
  await interruptReplacement(api, replacement, interruption);
  const saga = activeSaga();
  await api.addTransactions('closed-account', [
    addableTransaction(saga.replacement, { imported_id: saga.identity.value }),
  ]);
  const countsBefore = actualMutationCounts(api);
  const storesBefore = readStores();

  for (let attempt = 0; attempt < 2; attempt += 1) {
    await assert.rejects(
      recoverTransactionSagas(api),
      (error) => error.code === 'TRANSACTION_REPLACEMENT_OUTCOME_UNKNOWN'
        && error.message === 'temporary replacement identity found outside replacement account',
    );
  }

  assert.deepEqual(actualMutationCounts(api), countsBefore);
  assert.deepEqual(readStores(), storesBefore);
  assert.equal(activeSaga().phase, 'replacement_add_pending');
  assert.equal(
    api.state.rows.filter((row) => row.imported_id === saga.identity.value).length,
    1,
  );
});

test('ordinary imported identity and financial lookalikes remain account-scoped', async () => {
  resetStores();
  const foreignLookalike = {
    ...structuredClone(original),
    id: 'foreign-imported-lookalike',
    account: 'closed-account',
  };
  const api = durableActual({ rows: [original, decoy, unrelated, foreignLookalike] });
  const replacement = intendedSplit();

  await replaceActualTransaction(api, {
    accountId: 'account',
    original,
    replacement,
  });
  await recoverPastFault(api);

  assert.equal(latestSaga().phase, 'completed');
  assert.deepEqual(
    api.state.rows.find((row) => row.id === foreignLookalike.id),
    foreignLookalike,
  );
  assertConverged(api, replacement);
});

test('account enumeration and cross-account query failures leave replacement nonterminal', async (t) => {
  for (const failure of ['enumeration', 'query']) {
    await t.test(failure, async () => {
      resetStores();
      const api = durableActual();
      const replacement = intendedSplit();
      const interruption = faultSchedule([{ point: 'after:initial-saga-write' }]);
      await interruptReplacement(api, replacement, interruption);
      const storesBefore = readStores();
      if (failure === 'enumeration') {
        api.state.failAccountEnumeration = true;
      } else {
        api.state.queryFailures.add('closed-account');
      }

      for (let attempt = 0; attempt < 2; attempt += 1) {
        await assert.rejects(
          recoverTransactionSagas(api),
          failure === 'enumeration'
            ? /unable to enumerate Actual accounts/
            : /unable to query Actual account closed-account/,
        );
      }
      assert.deepEqual(actualMutationCounts(api), { add: 0, delete: 0, update: 0, sync: 0 });
      assert.deepEqual(readStores(), storesBefore);
      assert.equal(activeSaga().phase, 'delete_pending');
    });
  }
});

test('a prepared saga blocks a second replacement before identity generation or effects', async () => {
  resetStores();
  const api = durableActual();
  const replacement = intendedSplit();
  const interruption = faultSchedule([{ point: 'after:initial-saga-write' }]);
  await interruptReplacement(api, replacement, interruption);

  const sagaBefore = JSON.stringify(readSagaState());
  const rowsBefore = structuredClone(api.state.rows);
  const storesBefore = readStores();
  const countsBefore = actualMutationCounts(api);
  const receiptBefore = fs.readFileSync(path.join(process.env.RECEIPTS_DIR, 'receipt.jpg'));

  await assert.rejects(
    replaceActualTransaction(api, {
      accountId: 'account',
      original,
      replacement,
    }),
    (error) => error.code === 'TRANSACTION_REPLACEMENT_IN_PROGRESS' && error.status === 409,
  );
  assert.equal(JSON.stringify(readSagaState()), sagaBefore, 'no second saga or generated identity is persisted');
  assert.deepEqual(api.state.rows, rowsBefore);
  assert.deepEqual(actualMutationCounts(api), countsBefore);
  assert.deepEqual(readStores(), storesBefore);
  assert.deepEqual(fs.readFileSync(path.join(process.env.RECEIPTS_DIR, 'receipt.jpg')), receiptBefore);

  await recoverTransactionSagas(api);
  const recoveredCounts = actualMutationCounts(api);
  await recoverTransactionSagas(api);
  assert.deepEqual(actualMutationCounts(api), recoveredCounts, 'second recovery repeats no mutation');
  assertConverged(api, replacement);
});

test('active ownership includes original, replacement, restored, and legacy transaction IDs', () => {
  resetStores();
  writeJson(process.env.TRANSACTION_SAGAS_PATH, {
    schemaVersion: 1,
    sagas: {
      active: {
        id: 'active',
        recordVersion: 2,
        status: 'aborted',
        phase: 'replacement_ready',
        accountId: 'account',
        original: {
          id: 'owned-original',
          subtransactions: [{ id: 'owned-original-leg' }],
        },
        replacementIds: {
          parentId: 'owned-replacement',
          legIds: ['owned-replacement-leg'],
        },
        restoredIds: {
          parentId: 'owned-restored',
          legIds: ['owned-restored-leg'],
        },
        replacementId: 'owned-legacy-replacement',
        recoveryTransactionId: 'owned-legacy-restored',
      },
      unresolved: {
        id: 'unresolved',
        status: 'aborted',
        accountId: 'account',
        original: {
          id: 'owned-legacy-original',
          subtransactions: [{ id: 'owned-legacy-original-leg' }],
        },
      },
    },
  });
  for (const id of [
    'owned-original',
    'owned-original-leg',
    'owned-replacement',
    'owned-replacement-leg',
    'owned-restored',
    'owned-restored-leg',
    'owned-legacy-replacement',
    'owned-legacy-restored',
    'owned-legacy-original',
    'owned-legacy-original-leg',
  ]) {
    assert.throws(
      () => assertTransactionReplacementAvailable({ accountId: 'account', ids: [id] }),
      (error) => error.code === 'TRANSACTION_REPLACEMENT_IN_PROGRESS',
    );
  }
  assert.doesNotThrow(() => assertTransactionReplacementAvailable({
    accountId: 'different-account',
    ids: ['owned-original'],
  }));
  assert.doesNotThrow(() => assertTransactionReplacementAvailable({
    accountId: 'account',
    ids: ['unrelated-id'],
  }));
});

test('unrelated active sagas and terminal sagas permit intentional replacement', async () => {
  resetStores();
  const other = {
    ...original,
    id: 'other-parent',
    amount: -1200,
    imported_id: 'other-bank-import',
    notes: 'other original',
  };
  const api = durableActual({ rows: [original, decoy, unrelated, other] });
  const interruption = faultSchedule([{ point: 'after:initial-saga-write' }]);
  await interruptReplacement(api, intendedSplit(), interruption);
  await replaceActualTransaction(api, {
    accountId: 'account',
    original: other,
    replacement: { ...addableTransaction(other), notes: 'other replacement' },
  });
  assert.equal(Object.keys(readSagaState().sagas).length, 2, 'unrelated active saga is admitted');

  resetStores();
  const terminalApi = durableActual();
  await replaceActualTransaction(terminalApi, {
    accountId: 'account',
    original,
    replacement: intendedSplit(),
  });
  await recoverTransactionSagas(terminalApi);
  const firstReplacement = terminalApi.state.rows.find((row) => row.id.startsWith('actual-'));
  await replaceActualTransaction(terminalApi, {
    accountId: 'account',
    original: firstReplacement,
    replacement: { ...addableTransaction(firstReplacement), notes: 'intentional later edit' },
    requestedLegs: firstReplacement.subtransactions.map((leg) => ({ id: leg.id })),
  });
  assert.equal(Object.keys(readSagaState().sagas).length, 2, 'terminal saga does not retain ownership');
});

test('duplicate original imported identity fails before saga persistence or mutation', async () => {
  resetStores();
  const duplicate = {
    ...decoy,
    id: 'duplicate-import-owner',
    imported_id: original.imported_id,
  };
  const api = durableActual({ rows: [original, duplicate, unrelated] });
  const rowsBefore = structuredClone(api.state.rows);
  const storesBefore = readStores();
  await assert.rejects(
    replaceActualTransaction(api, {
      accountId: 'account',
      original,
      replacement: intendedSplit(),
    }),
    (error) => error.code === 'TRANSACTION_IMPORTED_ID_CONFLICT' && error.status === 409,
  );
  assert.equal(fs.existsSync(process.env.TRANSACTION_SAGAS_PATH), false);
  assert.deepEqual(api.state.rows, rowsBefore);
  assert.deepEqual(actualMutationCounts(api), { add: 0, delete: 0, update: 0, sync: 0 });
  assert.deepEqual(readStores(), storesBefore);
});

test('imported identity collision introduced after admission blocks original deletion', async () => {
  resetStores();
  const api = durableActual();
  const interruption = faultSchedule([{ point: 'after:initial-saga-write' }]);
  await interruptReplacement(api, intendedSplit(), interruption);
  api.state.rows.push({
    ...structuredClone(unrelated),
    id: 'pre-delete-import-owner',
    date: '2026-05-01',
    imported_id: original.imported_id,
  });
  await recoverTransactionSagas(api);
  await recoverTransactionSagas(api);
  assert.equal(activeSaga().phase, 'delete_pending');
  assert.equal(api.state.counts.delete, 0);
  assert.ok(api.state.rows.some((row) => row.id === original.id));
  assert.equal(api.state.rows.filter((row) => row.imported_id === original.imported_id).length, 2);
});

test('metadata restore converges when imported_id read lags behind update until sync', async () => {
  resetStores();
  const manualOriginalLocal = {
    ...original,
    imported_id: null,
    imported_payee: null,
    category: 'cat-1',
    is_parent: false,
    subtransactions: [],
  };
  const api = durableActual({
    rows: [manualOriginalLocal, unrelated],
    deferImportedIdUntilSync: true,
  });
  const replacement = addableTransaction(manualOriginalLocal, {
    category: undefined,
    subtransactions: [
      { amount: -333, category: 'cat-1', notes: 'first leg', payee: 'leg-payee-1' },
      { amount: -667, category: 'cat-2', notes: 'second leg', payee: 'leg-payee-2' },
    ],
  });
  const added = await replaceActualTransaction(api, {
    accountId: 'account',
    original: manualOriginalLocal,
    replacement,
  });
  assert.equal(added.imported_id, null);
  assert.equal(added.subtransactions[0].payee, 'leg-payee-1');
  assert.equal(added.subtransactions[1].payee, 'leg-payee-2');
  assert.ok(api.state.counts.sync >= 1);
  const persisted = api.state.rows.find((row) => row.id === added.id);
  assert.equal(persisted.imported_id, null);
  assert.doesNotMatch(JSON.stringify(persisted), /"imported_id":""/);
});

test('late imported identity collision remains nonterminal without assigning the duplicate ID', async () => {
  resetStores();
  const api = durableActual();
  const interruption = faultSchedule([{ point: 'after:replacement-id-checkpoint' }]);
  await interruptReplacement(api, intendedSplit(), interruption);
  const replacementId = activeSaga().replacementIds.parentId;
  const replacement = api.state.rows.find((row) => row.id === replacementId);
  assert.match(replacement.imported_id, /^df-replace:/);
  api.state.rows.push({
    ...structuredClone(unrelated),
    id: 'late-import-owner',
    date: '2026-06-01',
    imported_id: original.imported_id,
  });
  const storesBefore = readStores();
  const updatesBefore = api.state.counts.update;
  await recoverTransactionSagas(api);
  await recoverTransactionSagas(api);
  assert.equal(activeSaga().phase, 'replacement_metadata_pending');
  assert.equal(
    api.state.rows.find((row) => row.id === replacementId).imported_id,
    activeSaga().identity.value,
  );
  assert.equal(api.state.counts.update, updatesBefore);
  assert.deepEqual(readStores(), storesBefore);
  assert.equal(
    api.state.rows.filter((row) => row.imported_id === original.imported_id).length,
    1,
  );
});

const rollbackBoundaries = [
  'rollback-start-checkpoint',
  'rollback-deletion',
  'original-restoration',
  'restored-reconcile',
  'restored-id-checkpoint',
  'reference-receipts-write',
  'reference-links-write',
  'reference-suggestions-write',
  'reference-reconciliation-write',
  'reference-phantomSeen-write',
  'reference-reviewState-write',
  'sync',
  'saga-terminal-write',
];

test('checkpointed rollback converges across deletion, restoration, references, sync, and terminal faults', async (t) => {
  for (const boundary of rollbackBoundaries) {
    for (const side of ['before', 'after']) {
      await t.test(`${side}:${boundary}`, async () => {
        resetStores();
        const api = durableActual();
        const replacement = intendedSplit();
        const injector = faultSchedule([
          { point: 'before:reference-plan-checkpoint', mode: 'error' },
          { point: `${side}:${boundary}` },
        ]);
        await interruptReplacement(api, replacement, injector);
        await recoverPastFault(api, injector);
        assertConverged(api, replacement);
        const expectedPhase = side === 'before' && boundary === 'rollback-start-checkpoint'
          ? 'completed'
          : 'rolled_back';
        assert.equal(latestSaga().phase, expectedPhase);
      });
    }
  }
});

test('rollback remaps both partially migrated replacement IDs and original IDs', async () => {
  resetStores();
  const api = durableActual();
  const replacement = intendedSplit();
  const injector = faultSchedule([{ point: 'before:reference-links-write', mode: 'error' }]);
  await interruptReplacement(api, replacement, injector);
  await recoverPastFault(api, injector);
  assert.equal(latestSaga().phase, 'rolled_back');
  assertConverged(api, replacement);
});

test('removed-leg rollback after partial migration preserves evidence on live restored IDs', async () => {
  const splitOriginal = {
    ...original,
    id: 'split-original',
    imported_id: 'split-bank-import',
    category: null,
    is_parent: true,
    subtransactions: [
      {
        id: 'split-leg-removed',
        parent_id: 'split-original',
        amount: -400,
        category: 'cat-removed',
        notes: 'removed evidence',
        payee: 'removed-payee',
      },
      {
        id: 'split-leg-retained',
        parent_id: 'split-original',
        amount: -600,
        category: 'cat-retained',
        notes: 'retained evidence',
        payee: 'retained-payee',
      },
    ],
  };
  const replacement = addableTransaction(splitOriginal, {
    category: undefined,
    subtransactions: [
      {
        amount: -600,
        category: 'cat-retained',
        notes: 'retained evidence',
        payee: 'retained-payee',
      },
      {
        amount: -400,
        category: 'cat-new',
        notes: 'new leg',
        payee: 'new-payee',
      },
    ],
  });
  resetStores('split-leg-removed');
  const receiptBefore = fs.readFileSync(path.join(process.env.RECEIPTS_DIR, 'receipt.jpg'));
  const api = durableActual({ rows: [splitOriginal, unrelated] });
  const injector = faultSchedule([{ point: 'before:reference-links-write', mode: 'error' }]);
  await assert.rejects(replaceActualTransaction(api, {
    accountId: 'account',
    original: splitOriginal,
    replacement,
    requestedLegs: [{ id: 'split-leg-retained' }, { id: null }],
    faultInjector: injector,
  }));
  await recoverPastFault(api, injector);

  const saga = latestSaga();
  assert.equal(saga.phase, 'rolled_back');
  const live = liveIds(api);
  assert.ok(referencedIds(readStores()).every((id) => live.has(id)));
  assert.equal(JSON.stringify(readStores()).includes('split-leg-'), false);
  assert.deepEqual(fs.readFileSync(path.join(process.env.RECEIPTS_DIR, 'receipt.jpg')), receiptBefore);
  assert.deepEqual(fs.readdirSync(process.env.RECEIPTS_DIR), ['receipt.jpg']);
});

test('removed linked legs never persist a collapsed reimbursement self-link', async () => {
  const source = collapsedReferenceSource();
  const result = await expectCollapsedReferenceRollback({
    links: [{
      id: 'self-collapse-link',
      inflow: {
        id: source.subtransactions[0].id,
        date: source.date,
        payee: 'Inflow snapshot',
        amount: 4,
      },
      expense: {
        id: source.subtransactions[1].id,
        date: source.date,
        payee: 'Expense snapshot',
        amount: -6,
      },
      amount: 4,
      person: 'sanitized-person',
    }],
    errorPattern: /self-relationship/,
  });
  assert.equal(result.stores.links.links.length, 1);
  assert.notEqual(
    result.stores.links.links[0].inflow.id,
    result.stores.links.links[0].expense.id,
  );
  assert.equal(result.stores.links.links[0].amount, 4);
});

test('distinct reimbursement links never persist as one duplicate mapped pair', async () => {
  const source = collapsedReferenceSource();
  const result = await expectCollapsedReferenceRollback({
    links: [
      {
        id: 'duplicate-collapse-a',
        inflow: {
          id: source.subtransactions[0].id,
          date: source.date,
          payee: 'First inflow snapshot',
          amount: 4,
        },
        expense: {
          id: unrelated.id,
          date: source.date,
          payee: 'Shared expense snapshot',
          amount: -10,
        },
        amount: 4,
      },
      {
        id: 'duplicate-collapse-b',
        inflow: {
          id: source.subtransactions[1].id,
          date: source.date,
          payee: 'Second inflow snapshot',
          amount: 6,
        },
        expense: {
          id: unrelated.id,
          date: source.date,
          payee: 'Shared expense snapshot',
          amount: -10,
        },
        amount: 6,
      },
    ],
    errorPattern: /duplicate relationship/,
  });
  const pairs = result.stores.links.links.map((link) => `${link.inflow.id}:${link.expense.id}`);
  assert.equal(new Set(pairs).size, 2);
  assert.deepEqual(result.stores.links.links.map((link) => link.amount), [4, 6]);
});

test('confirmed suggestion allocation endpoint collapse fails closed without evidence loss', async () => {
  const source = collapsedReferenceSource();
  const result = await expectCollapsedReferenceRollback({
    links: [],
    suggestions: {
      dismissed: [],
      confirmed: {
        [`sg_${source.subtransactions[0].id}`]: {
          at: '2026-07-09T00:00:00.000Z',
          inflowId: source.subtransactions[0].id,
          allocations: [{
            expense: {
              id: source.subtransactions[1].id,
              date: source.date,
              payee: 'Allocation expense snapshot',
              amount: -6,
            },
            amount: 4,
          }],
        },
      },
    },
    errorPattern: /self-relationship/,
  });
  const suggestion = Object.values(result.stores.suggestions.confirmed)[0];
  assert.notEqual(suggestion.inflowId, suggestion.allocations[0].expense.id);
  assert.equal(suggestion.allocations[0].amount, 4);
  assert.equal(suggestion.allocations[0].expense.amount, -6);
});

test('ambiguous retained-leg successor fails closed before reference migration', async () => {
  const splitOriginal = {
    ...original,
    id: 'ambiguous-split',
    imported_id: 'ambiguous-split-import',
    category: null,
    is_parent: true,
    subtransactions: [
      {
        id: 'ambiguous-retained',
        parent_id: 'ambiguous-split',
        amount: -500,
        category: 'same-category',
        notes: 'same notes',
        payee: 'same-payee',
      },
      {
        id: 'ambiguous-removed',
        parent_id: 'ambiguous-split',
        amount: -500,
        category: 'old-category',
        notes: 'old notes',
        payee: 'old-payee',
      },
    ],
  };
  const identicalLeg = {
    amount: -500,
    category: 'same-category',
    notes: 'same notes',
    payee: 'same-payee',
  };
  const replacement = addableTransaction(splitOriginal, {
    category: undefined,
    subtransactions: [identicalLeg, { ...identicalLeg }],
  });
  resetStores('ambiguous-retained');
  const storesBefore = readStores();
  const api = durableActual({ rows: [splitOriginal, unrelated] });
  await assert.rejects(
    replaceActualTransaction(api, {
      accountId: 'account',
      original: splitOriginal,
      replacement,
      requestedLegs: [{ id: 'ambiguous-retained' }, { id: null }],
    }),
    (error) => error.code === 'TRANSACTION_REPLACEMENT_OUTCOME_UNKNOWN',
  );
  assert.equal(activeSaga().phase, 'replacement_add_pending');
  assert.equal(activeSaga().replacementIds, undefined);
  assert.deepEqual(readStores(), storesBefore);
  assert.match(
    api.state.rows.find((row) => row.id.startsWith('actual-')).imported_id,
    /^df-replace:/,
  );
});

test('apply-then-throw rollback deletion and restoration remain restart-safe', async () => {
  resetStores();
  const api = durableActual({
    applyThenThrowRollbackDelete: true,
    applyThenThrowRestoration: true,
  });
  const replacement = intendedSplit();
  const injector = faultSchedule([{ point: 'before:reference-plan-checkpoint', mode: 'error' }]);
  await interruptReplacement(api, replacement, injector);
  await recoverPastFault(api, injector);
  assert.equal(latestSaga().phase, 'rolled_back');
  assertConverged(api, replacement);
});

test('ambiguous immutable identity remains nonterminal without a destructive guess', async () => {
  resetStores();
  const api = durableActual();
  const replacement = intendedSplit();
  const injector = faultSchedule([{ point: 'before:replacement-add' }]);
  await interruptReplacement(api, replacement, injector);
  const saga = activeSaga();
  const payload = addableTransaction(saga.replacement, { imported_id: saga.identity.value });
  await api.addTransactions('account', [payload]);
  await api.addTransactions('account', [payload]);
  const before = actualMutationCounts(api);

  await recoverTransactionSagas(api);
  await recoverTransactionSagas(api);

  assert.deepEqual(actualMutationCounts(api), before);
  assert.equal(activeSaga().phase, 'replacement_add_pending');
  assert.equal(activeSaga().status, 'aborted');
  assert.match(activeSaga().lastError.message, /ambiguous/);
  assert.ok(readStores().receipts.byTxn[original.id], 'references are not guessed onto either candidate');
});

test('terminal pruning retains every nonterminal saga and only the newest 100 terminals', async () => {
  resetStores();
  const sagas = {
    active: {
      id: 'active',
      recordVersion: 2,
      phase: 'legacy_unresolved',
      status: 'aborted',
      updatedAt: '2020-01-01T00:00:00.000Z',
    },
  };
  for (let index = 0; index < 150; index += 1) {
    const id = `terminal-${String(index).padStart(3, '0')}`;
    sagas[id] = {
      id,
      recordVersion: 2,
      phase: 'completed',
      status: 'completed',
      terminalAt: new Date(Date.UTC(2026, 0, 1, 0, 0, index)).toISOString(),
      updatedAt: new Date(Date.UTC(2026, 0, 1, 0, 0, index)).toISOString(),
    };
  }
  writeJson(process.env.TRANSACTION_SAGAS_PATH, { schemaVersion: 1, sagas });
  const api = durableActual();
  const injector = faultSchedule([{ point: 'after:initial-saga-write' }]);
  await interruptReplacement(api, intendedSplit(), injector);

  const stored = Object.values(readSagaState().sagas);
  assert.equal(stored.filter((saga) => ['completed', 'rolled_back'].includes(saga.phase)).length, 100);
  assert.ok(stored.some((saga) => saga.id === 'active'));
  assert.ok(stored.some((saga) => saga.phase === 'prepared'));
});

function legacySaga(overrides = {}) {
  return {
    id: 'legacy',
    status: 'original-deleted',
    accountId: 'account',
    original: structuredClone(original),
    replacement: addableTransaction(original),
    requestedLegs: null,
    beforeIds: [original.id],
    startedAt: '2026-07-09T00:00:00.000Z',
    updatedAt: '2026-07-09T00:00:01.000Z',
    ...overrides,
  };
}

test('schema-v1 active saga without durable identity migrates and fails closed', async () => {
  resetStores();
  writeJson(process.env.TRANSACTION_SAGAS_PATH, {
    schemaVersion: 1,
    sagas: { legacy: legacySaga() },
  });
  const api = durableActual({ rows: [decoy, unrelated] });
  const before = actualMutationCounts(api);

  await recoverTransactionSagas(api);
  await recoverTransactionSagas(api);

  const saga = readSagaState().sagas.legacy;
  assert.equal(saga.recordVersion, 2);
  assert.equal(saga.phase, 'legacy_unresolved');
  assert.equal(saga.status, 'aborted');
  assert.deepEqual(actualMutationCounts(api), before);
  assert.ok(readStores().receipts.byTxn[original.id]);
});

test('schema-v1 completed and recovered records reconcile only exact durable IDs', async (t) => {
  await t.test('completed', async () => {
    resetStores();
    const intended = materializeAdded(addableTransaction(original), 'legacy-intended');
    writeJson(process.env.TRANSACTION_SAGAS_PATH, {
      schemaVersion: 1,
      sagas: {
        legacy: legacySaga({
          status: 'completed',
          replacementId: intended.id,
        }),
      },
    });
    const api = durableActual({ rows: [decoy, unrelated, intended] });
    await recoverPastFault(api);
    assert.equal(readSagaState().sagas.legacy.phase, 'completed');
    assert.ok(readStores().receipts.byTxn[intended.id]);
    assert.equal(readStores().receipts.byTxn[decoy.id], undefined);
  });

  await t.test('recovered', async () => {
    resetStores('legacy-replacement');
    const restored = materializeAdded(addableTransaction(original), 'legacy-restored');
    writeJson(process.env.TRANSACTION_SAGAS_PATH, {
      schemaVersion: 1,
      sagas: {
        legacy: legacySaga({
          status: 'recovered',
          replacementId: 'legacy-replacement',
          recoveryTransactionId: restored.id,
        }),
      },
    });
    const api = durableActual({ rows: [decoy, unrelated, restored] });
    await recoverPastFault(api);
    assert.equal(readSagaState().sagas.legacy.phase, 'rolled_back');
    assert.ok(readStores().receipts.byTxn[restored.id]);
  });
});

test('migrated legacy terminal statuses block until authoritative v2 reconciliation completes', async (t) => {
  await t.test('completed', async () => {
    resetStores();
    const intended = materializeAdded(addableTransaction(original), 'legacy-blocking-intended');
    writeJson(process.env.TRANSACTION_SAGAS_PATH, {
      schemaVersion: 1,
      sagas: {
        legacy: legacySaga({
          status: 'completed',
          replacementId: intended.id,
        }),
      },
    });
    const api = durableActual({ rows: [decoy, unrelated, intended] });
    const interruption = faultSchedule([{ point: 'before:replacement-id-checkpoint' }]);
    await assert.rejects(recoverTransactionSagas(api, { faultInjector: interruption }));
    assert.equal(readSagaState().sagas.legacy.phase, 'legacy_reconcile_forward');
    assert.throws(
      () => assertTransactionReplacementAvailable({ accountId: 'account', ids: [original.id] }),
      (error) => error.code === 'TRANSACTION_REPLACEMENT_IN_PROGRESS',
    );
    await recoverPastFault(api, interruption);
    assert.equal(readSagaState().sagas.legacy.phase, 'completed');
    assert.doesNotThrow(() => assertTransactionReplacementAvailable({
      accountId: 'account',
      ids: [original.id, intended.id],
    }));
  });

  await t.test('recovered', async () => {
    resetStores('legacy-blocking-replacement');
    const restored = materializeAdded(addableTransaction(original), 'legacy-blocking-restored');
    writeJson(process.env.TRANSACTION_SAGAS_PATH, {
      schemaVersion: 1,
      sagas: {
        legacy: legacySaga({
          status: 'recovered',
          replacementId: 'legacy-blocking-replacement',
          recoveryTransactionId: restored.id,
        }),
      },
    });
    const api = durableActual({ rows: [decoy, unrelated, restored] });
    const interruption = faultSchedule([{ point: 'before:restored-id-checkpoint' }]);
    await assert.rejects(recoverTransactionSagas(api, { faultInjector: interruption }));
    assert.equal(readSagaState().sagas.legacy.phase, 'legacy_reconcile_rollback');
    assert.throws(
      () => assertTransactionReplacementAvailable({
        accountId: 'account',
        ids: ['legacy-blocking-replacement', restored.id],
      }),
      (error) => error.code === 'TRANSACTION_REPLACEMENT_IN_PROGRESS',
    );
    await recoverPastFault(api, interruption);
    assert.equal(readSagaState().sagas.legacy.phase, 'rolled_back');
    assert.doesNotThrow(() => assertTransactionReplacementAvailable({
      accountId: 'account',
      ids: [original.id, 'legacy-blocking-replacement', restored.id],
    }));
  });
});

test('failed migrated legacy reconciliation retains transaction ownership', async () => {
  resetStores();
  writeJson(process.env.TRANSACTION_SAGAS_PATH, {
    schemaVersion: 1,
    sagas: {
      legacy: legacySaga({
        status: 'completed',
        replacementId: 'missing-legacy-replacement',
      }),
    },
  });
  const api = durableActual({ rows: [decoy, unrelated] });
  await recoverTransactionSagas(api);
  await recoverTransactionSagas(api);
  assert.equal(readSagaState().sagas.legacy.phase, 'legacy_reconcile_forward');
  assert.match(readSagaState().sagas.legacy.lastError.message, /lacks verifiable durable identity/);
  assert.throws(
    () => assertTransactionReplacementAvailable({
      accountId: 'account',
      ids: [original.id, 'missing-legacy-replacement'],
    }),
    (error) => error.code === 'TRANSACTION_REPLACEMENT_IN_PROGRESS',
  );
});

test('record-v2 rollback compatibility shields active sagas from the legacy recovery loop', async () => {
  resetStores();
  const api = durableActual();
  const injector = faultSchedule([{ point: 'after:initial-saga-write' }]);
  await interruptReplacement(api, intendedSplit(), injector);
  const state = readSagaState();
  const saga = activeSaga();
  assert.equal(state.schemaVersion, 1, 'outer schema remains accepted by the previous server');
  assert.equal(saga.recordVersion, 2);
  assert.equal(saga.status, 'aborted', 'previous recovery treats the active v2 record as terminal');
  const legacyActive = Object.values(state.sagas)
    .filter((record) => !['completed', 'recovered', 'aborted'].includes(record.status));
  assert.deepEqual(legacyActive, []);
});

test('parent and child transfer identity reject reconstruction before any state mutation', async (t) => {
  for (const [name, transaction] of [
    ['parent transfer_id', { ...original, transfer_id: 'paired-transfer' }],
    ['parent transferred_id', { ...original, transferred_id: 'acct-other' }],
    ['child transfer_id', {
      ...original,
      is_parent: true,
      category: null,
      subtransactions: [
        { id: 'old-leg-1', amount: -400, category: 'cat-1', transfer_id: 'paired-transfer' },
        { id: 'old-leg-2', amount: -600, category: 'cat-2' },
      ],
    }],
    ['child transferred_id', {
      ...original,
      is_parent: true,
      category: null,
      subtransactions: [
        { id: 'old-leg-1', amount: -400, category: 'cat-1', transferred_id: 'acct-other' },
        { id: 'old-leg-2', amount: -600, category: 'cat-2' },
      ],
    }],
  ]) {
    await t.test(name, async () => {
      resetStores();
      const api = durableActual({ rows: [transaction, decoy, unrelated] });
      await assert.rejects(replaceActualTransaction(api, {
        accountId: 'account',
        original: transaction,
        replacement: intendedSplit(transaction),
      }), (error) => error.code === 'TRANSFER_RECONSTRUCTION_UNSUPPORTED');
      assert.deepEqual(actualMutationCounts(api), { add: 0, delete: 0, update: 0, sync: 0 });
      assert.equal(fs.existsSync(process.env.TRANSACTION_SAGAS_PATH), false);
    });
  }
});

test('stored saga errors are bounded and redact credentials', async () => {
  resetStores();
  const secret = 'very-secret-credential';
  const api = durableActual({
    addError: new Error(`Authorization: Bearer ${secret} password=${secret} ${'x'.repeat(300)}`),
  });
  await assert.rejects(replaceActualTransaction(api, {
    accountId: 'account',
    original,
    replacement: intendedSplit(),
  }));
  const serialized = fs.readFileSync(process.env.TRANSACTION_SAGAS_PATH, 'utf8');
  assert.ok(!serialized.includes(secret));
  assert.ok(activeSaga().lastError.message.length <= 160);
});
