const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const os = require('os');
const path = require('path');

const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'darkfinances-replacement-callers-'));
const stateFiles = {
  ACCOUNT_OVERRIDES_PATH: 'account-overrides.json',
  BILLS_PAID_PATH: 'bills-paid.json',
  BUDGET_SETTINGS_PATH: 'budget-settings.json',
  DEBT_PLANNER_PATH: 'debt-planner.json',
  EVENTS_PATH: 'events.json',
  GOALS_PATH: 'goals.json',
  INVESTMENT_HOLDINGS_PATH: 'investment-holdings.json',
  MANUAL_ASSETS_PATH: 'manual-assets.json',
  OPERATION_JOURNAL_PATH: 'operation-journal.json',
  OWES_CONFIG_PATH: 'owes-config.json',
  OWES_TRUTH_PATH: 'owes-truth.json',
  PERSONAL_CONFIG_PATH: 'personal.json',
  PHANTOM_LOG_PATH: 'phantom-log.json',
  PHANTOM_SEEN_PATH: 'phantom-seen.json',
  RECEIPTS_PATH: 'receipts.json',
  REIMB_LINKS_PATH: 'links.json',
  REIMB_SUGGEST_PATH: 'suggestions.json',
  RECON_PATH: 'reconciliation.json',
  RECURRING_OVERRIDES_PATH: 'recurring-overrides.json',
  REVIEW_STATE_PATH: 'review-state.json',
  RULES_PATH: 'rules.json',
  TRANSACTION_SAGAS_PATH: 'transaction-sagas.json',
  VENMO_TRUTH_PATH: 'venmo-truth.json',
};
for (const [key, file] of Object.entries(stateFiles)) process.env[key] = path.join(dir, file);
process.env.RECEIPTS_DIR = path.join(dir, 'receipts');
process.env.ACTUAL_API_PATH = path.join(__dirname, 'fixtures', 'replacement-actual.js');

const actual = require('./fixtures/replacement-actual');
const {
  removeSplit,
  setPayee,
  setTransactionCategory,
  setTransactionNotes,
  splitTransaction,
  syncNow,
} = require('../dataModule');

test.after(() => fs.rmSync(dir, { recursive: true, force: true }));

const simple = {
  id: 'simple-parent',
  account: 'account',
  date: '2026-07-09',
  amount: -1000,
  payee: 'payee-original',
  notes: 'parent notes',
  cleared: false,
  imported_id: 'bank-import',
  imported_payee: 'Imported merchant',
  category: 'category-original',
  is_parent: false,
  subtransactions: [],
};

function splitParent({ transferChild = false } = {}) {
  return {
    ...simple,
    id: 'split-parent',
    category: null,
    is_parent: true,
    subtransactions: [
      {
        id: 'old-leg-1',
        parent_id: 'split-parent',
        amount: -400,
        category: 'category-1',
        payee: 'payee-leg-1',
        notes: 'leg one',
        ...(transferChild ? { transfer_id: 'paired-transfer' } : {}),
      },
      {
        id: 'old-leg-2',
        parent_id: 'split-parent',
        amount: -600,
        category: 'category-2',
        payee: 'payee-leg-2',
        notes: 'leg two',
      },
    ],
  };
}

function writeJson(file, value) {
  fs.writeFileSync(file, `${JSON.stringify(value, null, 2)}\n`);
}

function configure(transaction, referenceId = transaction.id) {
  fs.rmSync(dir, { recursive: true, force: true });
  fs.mkdirSync(process.env.RECEIPTS_DIR, { recursive: true });
  writeJson(process.env.RECEIPTS_PATH, {
    byTxn: {
      [referenceId]: [{ id: 'receipt', txnId: referenceId, file: 'receipt.jpg' }],
    },
  });
  fs.writeFileSync(path.join(process.env.RECEIPTS_DIR, 'receipt.jpg'), 'sanitized');
  writeJson(process.env.REIMB_LINKS_PATH, { links: [] });
  writeJson(process.env.REIMB_SUGGEST_PATH, {
    dismissed: [referenceId],
    confirmed: { [`sg_${referenceId}`]: { inflowId: referenceId, allocations: [] } },
  });
  writeJson(process.env.RECON_PATH, {
    enabled: true,
    months: { '2026-07': { items: { [referenceId]: 'done' } } },
  });
  writeJson(process.env.PHANTOM_SEEN_PATH, { seen: { [referenceId]: { firstSeen: simple.date } } });
  actual.configure({
    transactions: [transaction],
    payeeRows: [
      { id: 'payee-original', name: 'Original' },
      { id: 'payee-leg-1', name: 'Leg One' },
      { id: 'payee-leg-2', name: 'Leg Two' },
    ],
  });
}

function configureRemovedLegEvidence(parent) {
  configure(parent, 'old-leg-1');
  const receipt = {
    id: 'receipt',
    txnId: 'old-leg-1',
    file: 'receipt.jpg',
    amount: 4,
    date: parent.date,
    source: 'upload',
    ocrText: 'sanitized receipt evidence',
  };
  writeJson(process.env.RECEIPTS_PATH, { byTxn: { 'old-leg-1': [receipt] } });
  fs.writeFileSync(
    path.join(process.env.RECEIPTS_DIR, receipt.file),
    Buffer.from([0x52, 0x45, 0x43, 0x45, 0x49, 0x50, 0x54]),
  );
  writeJson(process.env.REIMB_LINKS_PATH, {
    schemaVersion: 2,
    links: [{
      id: 'link-evidence',
      linkKey: 'old-leg-1:old-leg-2',
      inflow: {
        id: 'old-leg-1',
        date: parent.date,
        payee: 'Refund snapshot',
        amount: 4,
      },
      expense: {
        id: 'old-leg-2',
        date: parent.date,
        payee: 'Expense snapshot',
        amount: -6,
      },
      allocationCents: 400,
      amount: 4,
      version: 1,
      person: 'sanitized-person',
    }],
  });
  writeJson(process.env.REIMB_SUGGEST_PATH, {
    dismissed: ['old-leg-1'],
    confirmed: {
      'sg_old-leg-2': {
        at: '2026-07-09T00:00:00.000Z',
        inflowId: 'old-leg-2',
        allocations: [{
          expense: {
            id: 'old-leg-1',
            date: parent.date,
            payee: 'Allocation snapshot',
            amount: -4,
          },
          amount: 4,
        }],
      },
    },
  });
  writeJson(process.env.RECON_PATH, {
    enabled: true,
    months: {
      '2026-07': {
        done: false,
        items: {
          'old-leg-1': 'removed-leg-timestamp',
          'old-leg-2': 'retained-leg-timestamp',
        },
      },
    },
  });
  writeJson(process.env.PHANTOM_SEEN_PATH, {
    seen: {
      'old-leg-1': { firstSeen: parent.date, lastSeen: parent.date, source: 'removed' },
      'old-leg-2': { firstSeen: parent.date, lastSeen: parent.date, source: 'retained' },
    },
  });
}

function assertResponseCompatibility(result, expectedMode) {
  assert.equal(result.ok, true);
  assert.equal(result.mode, expectedMode);
  assert.equal(typeof result.id, 'string');
  assert.equal(typeof result.previousId, 'string');
  assert.equal(typeof result.references, 'object');
  for (const key of ['receipts', 'links', 'suggestions', 'reconciliation', 'phantomSeen']) {
    assert.equal(Number.isInteger(result.references[key]), true);
  }
}

function assertReferenceMoved(id) {
  const receipts = JSON.parse(fs.readFileSync(process.env.RECEIPTS_PATH, 'utf8'));
  assert.equal(receipts.byTxn[id][0].txnId, id);
  assert.equal(receipts.byTxn['simple-parent'], undefined);
  assert.equal(receipts.byTxn['split-parent'], undefined);
  assert.equal(receipts.byTxn['old-leg-1'], undefined);
}

test('split caller clears temporary imported identity for manual transactions', async () => {
  const manual = {
    ...simple,
    imported_id: null,
    imported_payee: null,
  };
  configure(manual);
  const result = await splitTransaction({
    id: manual.id,
    accountId: 'account',
    date: manual.date,
    legs: [
      { amount: -4, categoryId: 'category-1', name: 'Leg One', notes: 'leg one' },
      { amount: -6, categoryId: 'category-2', name: 'Leg Two', notes: 'leg two' },
    ],
  });
  assertResponseCompatibility(result, 'create');
  const parent = actual.inspect().rows[0];
  assert.equal(parent.imported_id, null);
  await syncNow();
  const persisted = actual.inspect().rows[0];
  assert.equal(persisted.imported_id, null);
  assert.doesNotMatch(JSON.stringify(persisted), /"imported_id":""/);
  const saga = Object.values(JSON.parse(fs.readFileSync(process.env.TRANSACTION_SAGAS_PATH, 'utf8')).sagas)[0];
  assert.equal(saga.phase, 'completed');
});

test('split caller converges when Actual reverses split leg order after sync', async () => {
  const manual = {
    ...simple,
    imported_id: null,
    imported_payee: null,
  };
  configure(manual);
  actual.setReverseSplitLegOrderOnSync(true);
  try {
    const result = await splitTransaction({
      id: manual.id,
      accountId: 'account',
      date: manual.date,
      legs: [
        { amount: -4, categoryId: 'category-1', notes: 'first' },
        { amount: -6, categoryId: 'category-2', notes: 'second' },
      ],
    });
    assertResponseCompatibility(result, 'create');
    const parent = actual.inspect().rows[0];
    assert.equal(parent.imported_id, null);
    assert.deepEqual(
      parent.subtransactions.map((leg) => ({ amount: leg.amount, notes: leg.notes })).sort((a, b) => a.notes.localeCompare(b.notes)),
      [{ amount: -400, notes: 'first' }, { amount: -600, notes: 'second' }],
    );
    const saga = Object.values(JSON.parse(fs.readFileSync(process.env.TRANSACTION_SAGAS_PATH, 'utf8')).sagas)[0];
    assert.equal(saga.phase, 'sync_pending');
    await syncNow();
    assert.equal(
      Object.values(JSON.parse(fs.readFileSync(process.env.TRANSACTION_SAGAS_PATH, 'utf8')).sagas)[0].phase,
      'completed',
    );
  } finally {
    actual.setReverseSplitLegOrderOnSync(false);
  }
});

test('split caller returns replacement IDs and preserves response shape', async () => {
  configure(simple);
  const result = await splitTransaction({
    id: simple.id,
    accountId: 'account',
    date: simple.date,
    legs: [
      { amount: -4, categoryId: 'category-1', name: 'Leg One', notes: 'leg one' },
      { amount: -6, categoryId: 'category-2', name: 'Leg Two', notes: 'leg two' },
    ],
  });
  assertResponseCompatibility(result, 'create');
  assert.equal(result.legIds.length, 2);
  const parent = actual.inspect().rows[0];
  assert.equal(parent.id, result.id);
  assert.equal(parent.subtransactions.reduce((sum, leg) => sum + leg.amount, 0), parent.amount);
  assert.equal(parent.imported_id, simple.imported_id);
  assert.equal(actual.inspect().rows[0].imported_id, 'bank-import');
  assertReferenceMoved(parent.id);
  let saga = Object.values(JSON.parse(fs.readFileSync(process.env.TRANSACTION_SAGAS_PATH, 'utf8')).sagas)[0];
  assert.equal(saga.phase, 'sync_pending');
  await syncNow();
  saga = Object.values(JSON.parse(fs.readFileSync(process.env.TRANSACTION_SAGAS_PATH, 'utf8')).sagas)[0];
  assert.equal(saga.phase, 'completed');
});

test('duplicate imported identity rejects before split payee creation or saga write', async () => {
  configure(simple);
  actual.configure({
    transactions: [
      simple,
      {
        ...simple,
        id: 'duplicate-import-owner',
        date: '2026-06-01',
      },
    ],
    payeeRows: [{ id: 'payee-original', name: 'Original' }],
  });
  await assert.rejects(
    splitTransaction({
      id: simple.id,
      accountId: 'account',
      date: simple.date,
      legs: [
        { amount: -4, categoryId: 'category-1', name: 'Would Be Created' },
        { amount: -6, categoryId: 'category-2' },
      ],
    }),
    (error) => error.code === 'TRANSACTION_IMPORTED_ID_CONFLICT',
  );
  assert.equal(actual.inspect().createPayeeCalls, 0);
  assert.equal(actual.inspect().rows.length, 2);
  assert.equal(fs.existsSync(process.env.TRANSACTION_SAGAS_PATH), false);
});

test('sync failure keeps a successful replacement nonterminal until same-state recovery', async () => {
  configure(simple);
  await splitTransaction({
    id: simple.id,
    accountId: 'account',
    date: simple.date,
    legs: [
      { amount: -4, categoryId: 'category-1' },
      { amount: -6, categoryId: 'category-2' },
    ],
  });
  actual.setSyncError(new Error('simulated sync uncertainty'));
  await assert.rejects(syncNow(), /simulated sync uncertainty/);
  let saga = Object.values(JSON.parse(fs.readFileSync(process.env.TRANSACTION_SAGAS_PATH, 'utf8')).sagas)[0];
  assert.equal(saga.phase, 'sync_pending');
  actual.setSyncError(null);
  await syncNow();
  saga = Object.values(JSON.parse(fs.readFileSync(process.env.TRANSACTION_SAGAS_PATH, 'utf8')).sagas)[0];
  assert.equal(saga.phase, 'completed');
});

test('split edit maps a retained leg to its proven successor when a new leg is inserted', async () => {
  const parent = splitParent();
  configure(parent, 'old-leg-1');
  const result = await splitTransaction({
    id: parent.id,
    accountId: 'account',
    date: parent.date,
    legs: [
      { amount: -2, categoryId: 'category-new' },
      { id: 'old-leg-1', amount: -8, categoryId: 'category-1' },
    ],
  });
  assertResponseCompatibility(result, 'edit');
  const rebuilt = actual.inspect().rows[0];
  assertReferenceMoved(rebuilt.subtransactions[1].id);
});

test('removed-leg replacement preserves every reference and receipt byte', async () => {
  const parent = splitParent();
  configureRemovedLegEvidence(parent);
  const receiptBytes = fs.readFileSync(path.join(process.env.RECEIPTS_DIR, 'receipt.jpg'));
  const result = await splitTransaction({
    id: parent.id,
    accountId: 'account',
    date: parent.date,
    legs: [
      {
        id: 'old-leg-2',
        amount: -6,
        categoryId: 'category-2',
        name: 'Leg Two',
        notes: 'leg two',
      },
      { amount: -4, categoryId: 'category-new', notes: 'new replacement leg' },
    ],
  });
  assertResponseCompatibility(result, 'edit');
  const rebuilt = actual.inspect().rows[0];
  const retainedId = rebuilt.subtransactions[0].id;

  const receipts = JSON.parse(fs.readFileSync(process.env.RECEIPTS_PATH, 'utf8'));
  assert.deepEqual(receipts.byTxn[rebuilt.id], [{
    id: 'receipt',
    txnId: rebuilt.id,
    file: 'receipt.jpg',
    amount: 4,
    date: parent.date,
    source: 'upload',
    ocrText: 'sanitized receipt evidence',
  }]);
  assert.deepEqual(fs.readFileSync(path.join(process.env.RECEIPTS_DIR, 'receipt.jpg')), receiptBytes);

  const links = JSON.parse(fs.readFileSync(process.env.REIMB_LINKS_PATH, 'utf8')).links;
  assert.deepEqual(links, [{
    id: 'link-evidence',
    linkKey: `${rebuilt.id}:${retainedId}`,
    inflow: {
      id: rebuilt.id,
      date: parent.date,
      payee: 'Refund snapshot',
      amount: 4,
    },
    expense: {
      id: retainedId,
      date: parent.date,
      payee: 'Expense snapshot',
      amount: -6,
    },
    allocationCents: 400,
    amount: 4,
    version: 1,
    person: 'sanitized-person',
  }]);

  const suggestions = JSON.parse(fs.readFileSync(process.env.REIMB_SUGGEST_PATH, 'utf8'));
  assert.deepEqual(suggestions.dismissed, [rebuilt.id]);
  assert.deepEqual(suggestions.confirmed[`sg_${retainedId}`], {
    at: '2026-07-09T00:00:00.000Z',
    inflowId: retainedId,
    allocations: [{
      expense: {
        id: rebuilt.id,
        date: parent.date,
        payee: 'Allocation snapshot',
        amount: -4,
      },
      amount: 4,
    }],
  });

  const reconciliation = JSON.parse(fs.readFileSync(process.env.RECON_PATH, 'utf8'));
  assert.deepEqual(reconciliation.months['2026-07'].items, {
    [rebuilt.id]: 'removed-leg-timestamp',
    [retainedId]: 'retained-leg-timestamp',
  });
  const phantomSeen = JSON.parse(fs.readFileSync(process.env.PHANTOM_SEEN_PATH, 'utf8'));
  assert.deepEqual(phantomSeen.seen, {
    [rebuilt.id]: { firstSeen: parent.date, lastSeen: parent.date, source: 'removed' },
    [retainedId]: { firstSeen: parent.date, lastSeen: parent.date, source: 'retained' },
  });
  assert.equal(JSON.stringify({
    receipts,
    links,
    suggestions,
    reconciliation,
    phantomSeen,
  }).includes('old-leg-'), false);
  assert.deepEqual(fs.readdirSync(process.env.RECEIPTS_DIR), ['receipt.jpg']);
});

test('retained legs map by proven content across insertion and request reordering', async () => {
  const parent = splitParent();
  configure(parent, 'old-leg-1');
  writeJson(process.env.RECEIPTS_PATH, {
    byTxn: {
      'old-leg-1': [{ id: 'receipt-one', txnId: 'old-leg-1', file: 'one.jpg' }],
      'old-leg-2': [{ id: 'receipt-two', txnId: 'old-leg-2', file: 'two.jpg' }],
    },
  });
  fs.rmSync(path.join(process.env.RECEIPTS_DIR, 'receipt.jpg'), { force: true });
  fs.writeFileSync(path.join(process.env.RECEIPTS_DIR, 'one.jpg'), 'one');
  fs.writeFileSync(path.join(process.env.RECEIPTS_DIR, 'two.jpg'), 'two');

  await splitTransaction({
    id: parent.id,
    accountId: 'account',
    date: parent.date,
    legs: [
      {
        id: 'old-leg-2',
        amount: -6,
        categoryId: 'category-2',
        name: 'Leg Two',
        notes: 'leg two',
      },
      { amount: -1, categoryId: 'category-new', notes: 'inserted' },
      {
        id: 'old-leg-1',
        amount: -3,
        categoryId: 'category-1',
        name: 'Leg One',
        notes: 'leg one',
      },
    ],
  });
  const rebuilt = actual.inspect().rows[0];
  const receipts = JSON.parse(fs.readFileSync(process.env.RECEIPTS_PATH, 'utf8'));
  assert.equal(receipts.byTxn[rebuilt.subtransactions[0].id][0].id, 'receipt-two');
  assert.equal(receipts.byTxn[rebuilt.subtransactions[2].id][0].id, 'receipt-one');
  assert.equal(receipts.byTxn[rebuilt.id], undefined);
});

test('unsplit caller maps parent and leg references to one live parent', async () => {
  const parent = splitParent();
  configure(parent, parent.subtransactions[0].id);
  const result = await removeSplit({
    id: parent.id,
    accountId: 'account',
    date: parent.date,
    categoryId: 'category-final',
  });
  assertResponseCompatibility(result, 'unsplit');
  const restored = actual.inspect().rows[0];
  assert.equal(restored.subtransactions.length, 0);
  assert.equal(restored.category, 'category-final');
  assertReferenceMoved(restored.id);
});

test('category leg rebuild follows the generated parent and leg IDs', async () => {
  const parent = splitParent();
  configure(parent, parent.subtransactions[0].id);
  const result = await setTransactionCategory({
    id: 'old-leg-1',
    categoryId: 'category-new',
    isLeg: true,
    parentId: parent.id,
    accountId: 'account',
    date: parent.date,
  });
  assertResponseCompatibility(result, 'rebuild-split');
  const rebuilt = actual.inspect().rows[0];
  assert.equal(result.parentId, rebuilt.id);
  assert.equal(result.id, rebuilt.subtransactions[0].id);
  assert.equal(rebuilt.subtransactions[0].category, 'category-new');
  assertReferenceMoved(result.id);
});

test('payee leg rebuild creates the payee once and preserves import metadata', async () => {
  const parent = splitParent();
  configure(parent, parent.subtransactions[0].id);
  const result = await setPayee({
    id: 'old-leg-1',
    payee: 'Replacement Payee',
    isLeg: true,
    parentId: parent.id,
    accountId: 'account',
    date: parent.date,
  });
  assertResponseCompatibility(result, 'rebuild-split');
  const state = actual.inspect();
  assert.equal(state.createPayeeCalls, 1);
  assert.equal(state.rows[0].subtransactions[0].payee, state.payees.at(-1).id);
  assert.equal(state.rows[0].imported_id, parent.imported_id);
  assertReferenceMoved(result.id);
});

test('notes leg rebuild preserves all unchanged parent and sibling fields', async () => {
  const parent = splitParent();
  configure(parent, parent.subtransactions[0].id);
  const result = await setTransactionNotes({
    id: 'old-leg-1',
    notes: 'updated notes',
    isLeg: true,
    parentId: parent.id,
    accountId: 'account',
    date: parent.date,
  });
  assertResponseCompatibility(result, 'rebuild-split');
  const rebuilt = actual.inspect().rows[0];
  assert.equal(rebuilt.subtransactions[0].notes, 'updated notes');
  assert.equal(rebuilt.subtransactions[1].notes, parent.subtransactions[1].notes);
  assert.equal(rebuilt.notes, parent.notes);
  assert.equal(rebuilt.imported_payee, parent.imported_payee);
  assertReferenceMoved(result.id);
});

test('manual split leg note rebuild omits inherited payee and preserves SQL null imported_id', async () => {
  const manual = {
    ...simple,
    id: 'manual-split-parent',
    amount: -1234,
    imported_id: null,
    imported_payee: null,
    category: null,
    is_parent: true,
    subtransactions: [
      {
        id: 'manual-leg-1',
        parent_id: 'manual-split-parent',
        amount: -500,
        category: 'category-1',
        notes: 'first',
        payee: 'payee-original',
      },
      {
        id: 'manual-leg-2',
        parent_id: 'manual-split-parent',
        amount: -734,
        category: 'category-2',
        notes: 'second',
        payee: 'payee-original',
      },
    ],
  };
  configure(manual, 'manual-leg-1');
  const result = await setTransactionNotes({
    id: 'manual-leg-1',
    notes: 'updated',
    isLeg: true,
    parentId: manual.id,
    accountId: 'account',
    date: manual.date,
  });
  assertResponseCompatibility(result, 'rebuild-split');
  const rebuilt = actual.inspect().rows[0];
  assert.equal(rebuilt.imported_id, null);
  assert.equal(rebuilt.subtransactions[0].notes, 'updated');
  assert.equal(rebuilt.subtransactions[0].payee, 'payee-original');
  assert.equal(rebuilt.subtransactions[1].notes, 'second');
  assert.equal(rebuilt.subtransactions[1].payee, 'payee-original');
  await syncNow();
  const persisted = actual.inspect().rows[0];
  assert.equal(persisted.imported_id, null);
  assert.doesNotMatch(JSON.stringify(persisted), /"imported_id":""/);
  const saga = Object.values(JSON.parse(fs.readFileSync(process.env.TRANSACTION_SAGAS_PATH, 'utf8')).sagas).pop();
  assert.equal(saga.phase, 'completed');
  assert.equal(saga.replacement.subtransactions[0].payee, undefined);
  assert.equal(saga.replacement.subtransactions[1].payee, undefined);
});

test('child transfer rejection precedes payee creation, saga writes, and Actual mutation', async () => {
  const parent = splitParent({ transferChild: true });
  configure(parent, parent.subtransactions[0].id);
  await assert.rejects(setPayee({
    id: 'old-leg-1',
    payee: 'Must Not Be Created',
    isLeg: true,
    parentId: parent.id,
    accountId: 'account',
    date: parent.date,
  }), (error) => error.code === 'TRANSFER_RECONSTRUCTION_UNSUPPORTED');
  assert.equal(actual.inspect().createPayeeCalls, 0);
  assert.equal(actual.inspect().rows[0].id, parent.id);
  assert.equal(fs.existsSync(process.env.TRANSACTION_SAGAS_PATH), false);
});
