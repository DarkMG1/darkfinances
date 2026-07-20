'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const os = require('os');
const path = require('path');
const {
  createRepaymentConfirmationSaga,
  inflowFingerprint,
} = require('../lib/repayment-confirmation-saga');

const REIMB_CATEGORY = 'reimb-category';
const inflow = Object.freeze({
  id: 'repay-inflow',
  account: 'account',
  date: '2026-07-10',
  amount: 5000,
  payee: 'payee-inflow',
  notes: 'repayment',
  cleared: true,
  imported_id: null,
  category: 'uncategorized',
  is_parent: false,
  subtransactions: [],
});
const expenseA = Object.freeze({
  id: 'repay-expense-a',
  account: 'account',
  date: '2026-07-09',
  amount: -3000,
  payee: 'payee-a',
  notes: 'fronted',
  cleared: true,
  imported_id: null,
  category: REIMB_CATEGORY,
  is_parent: false,
  subtransactions: [],
});
const expenseB = Object.freeze({
  id: 'repay-expense-b',
  account: 'account',
  date: '2026-07-08',
  amount: -2500,
  payee: 'payee-b',
  notes: 'fronted',
  cleared: true,
  imported_id: null,
  category: REIMB_CATEGORY,
  is_parent: false,
  subtransactions: [],
});
const unrelated = Object.freeze({
  id: 'unrelated-txn',
  account: 'account',
  date: inflow.date,
  amount: -1000,
  payee: 'other',
  category: 'other-category',
  is_parent: false,
  subtransactions: [],
});
const splitParent = Object.freeze({
  id: 'split-parent',
  account: 'account',
  date: '2026-07-09',
  amount: -5000,
  payee: 'payee-a',
  notes: 'split expense',
  cleared: true,
  imported_id: null,
  category: null,
  is_parent: true,
  subtransactions: [
    Object.freeze({
      id: 'split-leg-reimb',
      parent_id: 'split-parent',
      date: '2026-07-09',
      amount: -3000,
      payee: 'payee-a',
      notes: 'fronted',
      cleared: true,
      imported_id: null,
      category: REIMB_CATEGORY,
      is_parent: false,
      subtransactions: [],
    }),
    Object.freeze({
      id: 'split-leg-self',
      parent_id: 'split-parent',
      date: '2026-07-09',
      amount: -2000,
      payee: 'payee-a',
      notes: 'self',
      cleared: true,
      imported_id: null,
      category: 'other-category',
      is_parent: false,
      subtransactions: [],
    }),
  ],
});

function writeJson(file, value) {
  fs.writeFileSync(file, `${JSON.stringify(value, null, 2)}\n`);
}

function readJson(file) {
  return JSON.parse(fs.readFileSync(file, 'utf8'));
}

function makeHarness({ applyThenThrowCategory = false, rows = null } = {}) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'darkfinances-repay-faults-'));
  const paths = {
    actual: path.join(dir, 'actual.json'),
    sagas: path.join(dir, 'repayment-confirmation-sagas.json'),
    links: path.join(dir, 'links.json'),
    suggestions: path.join(dir, 'suggestions.json'),
  };
  writeJson(paths.actual, {
    rows: rows || [inflow, expenseA, expenseB, unrelated],
    accounts: [
      { id: 'account', name: 'Account', closed: false, offbudget: false },
      { id: 'closed-account', name: 'Closed', closed: true, offbudget: false },
    ],
    applyThenThrowCategory,
    categoryThrowFired: false,
    counts: { update: 0, sync: 0 },
  });
  writeJson(paths.links, {
    schemaVersion: 1,
    unknown: 'keep',
    links: [{
      inflow: { id: unrelated.id, amount: 10 },
      expense: { id: 'legacy-expense', amount: -10 },
      amount: 10,
      createdAt: 'legacy',
    }],
  });
  writeJson(paths.suggestions, {
    schemaVersion: 1,
    unknown: { keep: true },
    dismissed: [unrelated.id, null],
    confirmed: {
      [`sg_${unrelated.id}`]: { inflowId: unrelated.id, allocations: 0, at: 'keep' },
      legacy: { inflowId: null, at: 'legacy-null' },
    },
  });
  return { dir, paths };
}

function readStores(harness) {
  return {
    links: readJson(harness.paths.links),
    suggestions: readJson(harness.paths.suggestions),
  };
}

function actualAdapter(harness) {
  const { paths } = harness;
  return {
    async getAccounts() {
      return structuredClone(readJson(paths.actual).accounts);
    },
    async getTransactions(accountId, start, end) {
      return readJson(paths.actual).rows
        .filter((row) => row.account === accountId && row.date >= start && row.date <= end)
        .map((row) => structuredClone(row));
    },
    async updateTransaction(id, patch) {
      const state = readJson(paths.actual);
      state.counts.update += 1;
      const row = state.rows.find((item) => String(item.id) === String(id));
      if (!row) throw new Error('transaction not found');
      Object.assign(row, patch);
      const shouldThrow = state.applyThenThrowCategory && !state.categoryThrowFired;
      if (shouldThrow) state.categoryThrowFired = true;
      writeJson(paths.actual, state);
      if (shouldThrow) throw new Error('Actual category response lost');
    },
    async sync() {
      const state = readJson(paths.actual);
      state.counts.sync += 1;
      writeJson(paths.actual, state);
    },
  };
}

function makeManager(harness) {
  const { paths } = harness;
  return createRepaymentConfirmationSaga({
    sagaPath: paths.sagas,
    readLinks: () => readJson(paths.links),
    writeLinks: (store) => writeJson(paths.links, store),
    readSuggestions: () => readJson(paths.suggestions),
    writeSuggestions: (store) => writeJson(paths.suggestions, store),
  });
}

function admissionInput(existingLinks = []) {
  return {
    accountId: 'account',
    suggestionId: `sg_${inflow.id}`,
    operationIdentity: 'op-test-1',
    reimbCategoryId: REIMB_CATEGORY,
    person: 'alex',
    inflowTransaction: { ...inflow, payeeName: 'Alex Zelle' },
    expenseTransactions: {
      [expenseA.id]: { ...expenseA, payeeName: 'Expense A' },
      [expenseB.id]: { ...expenseB, payeeName: 'Expense B' },
    },
    allocations: [
      {
        expenseId: expenseA.id,
        expenseAccountId: 'account',
        amountCents: 3000,
        expensePayeeName: 'Expense A',
      },
      {
        expenseId: expenseB.id,
        expenseAccountId: 'account',
        amountCents: 2000,
        expensePayeeName: 'Expense B',
      },
    ],
    existingLinks,
  };
}

function splitAdmissionInput(existingLinks = []) {
  return {
    accountId: 'account',
    suggestionId: `sg_${inflow.id}`,
    operationIdentity: 'op-split-test',
    reimbCategoryId: REIMB_CATEGORY,
    person: 'alex',
    inflowTransaction: { ...inflow, payeeName: 'Alex Zelle' },
    expenseTransactions: {
      'split-leg-reimb': {
        ...splitParent.subtransactions[0],
        payeeName: 'Split Leg',
      },
      [expenseB.id]: { ...expenseB, payeeName: 'Expense B' },
    },
    allocations: [
      {
        expenseId: 'split-leg-reimb',
        expenseAccountId: 'account',
        parentId: 'split-parent',
        amountCents: 3000,
        expensePayeeName: 'Split Leg',
      },
      {
        expenseId: expenseB.id,
        expenseAccountId: 'account',
        parentId: null,
        amountCents: 2000,
        expensePayeeName: 'Expense B',
      },
    ],
    existingLinks,
  };
}

function faultSchedule(rules) {
  const entries = rules.map((rule) => ({ mode: 'crash', ...rule, fired: false }));
  const injector = async (point) => {
    const entry = entries.find((candidate) => !candidate.fired && candidate.point === point);
    if (!entry) return;
    entry.fired = true;
    const error = new Error(entry.message || `injected fault at ${point}`);
    if (entry.mode === 'crash') error.sagaInterruption = true;
    throw error;
  };
  injector.entries = entries;
  return injector;
}

function sagaState(harness) {
  if (!fs.existsSync(harness.paths.sagas)) return { schemaVersion: 1, sagas: {} };
  return readJson(harness.paths.sagas);
}

function latestSaga(harness) {
  return Object.values(sagaState(harness).sagas)
    .sort((left, right) => String(right.updatedAt).localeCompare(String(left.updatedAt)))[0] || null;
}

function actualState(harness) {
  return readJson(harness.paths.actual);
}

function assertUnrelatedEvidence(stores) {
  assert.deepEqual(stores.links.unknown, 'keep');
  assert.equal(stores.links.links.length, 3);
  assert.deepEqual(stores.suggestions.dismissed, [unrelated.id, null]);
  assert.deepEqual(stores.suggestions.confirmed[`sg_${unrelated.id}`], {
    inflowId: unrelated.id,
    allocations: 0,
    at: 'keep',
  });
  assert.deepEqual(stores.suggestions.confirmed.legacy, { inflowId: null, at: 'legacy-null' });
  assert.deepEqual(stores.suggestions.unknown, { keep: true });
}

function assertCompleted(harness) {
  const inflowRow = actualState(harness).rows.find((row) => row.id === inflow.id);
  assert.equal(inflowRow.category, REIMB_CATEGORY);
  const stores = readStores(harness);
  assert.equal(stores.links.links.filter((link) => link.inflow?.id === inflow.id).length, 2);
  assert.deepEqual(stores.suggestions.confirmed[`sg_${inflow.id}`], {
    at: latestSaga(harness).startedAt,
    inflowId: inflow.id,
    allocations: 2,
  });
  assertUnrelatedEvidence(stores);
  const saga = latestSaga(harness);
  assert.equal(saga.phase, 'completed');
  assert.equal(saga.auditOutcome.outcome, 'confirmed');
  assert.equal(saga.auditOutcome.inflowId, inflow.id);
  assert.equal(saga.lastError, null);
}

async function beginConfirm(harness, faultInjector) {
  const harnessFresh = harness;
  return makeManager(harnessFresh).confirm(actualAdapter(harnessFresh), {
    ...admissionInput(),
    existingLinks: readStores(harnessFresh).links.links,
    faultInjector,
  });
}

async function recoverRepeatedly(harness, faultInjector) {
  for (let attempt = 0; attempt < 3; attempt += 1) {
    try {
      await makeManager(harness).recover(actualAdapter(harness), { faultInjector });
    } catch (_) {}
  }
  await makeManager(harness).recover(actualAdapter(harness));
  const before = {
    actual: actualState(harness),
    saga: sagaState(harness),
    stores: readStores(harness),
  };
  await makeManager(harness).recover(actualAdapter(harness));
  await makeManager(harness).recover(actualAdapter(harness));
  assert.deepEqual(actualState(harness), before.actual);
  assert.deepEqual(sagaState(harness), before.saga);
  assert.deepEqual(readStores(harness), before.stores);
}

const localBoundaries = [
  'initial-saga-write',
  'category-intent-checkpoint',
  'inflow-revalidation',
  'category-update',
  'category-verification',
  'category-applied-checkpoint',
  'pre-links-verification',
  'links-pending-checkpoint',
  'link-0-pending-checkpoint',
  'link-0-write',
  'link-0-checkpoint',
  'link-1-pending-checkpoint',
  'link-1-write',
  'link-1-checkpoint',
  'links-applied-checkpoint',
  'confirmation-pending-checkpoint',
  'confirmation-write',
  'confirmation-checkpoint',
  'pre-sync-verification',
  'sync-pending-checkpoint',
];

const syncedBoundaries = [
  'sync',
  'post-sync-verification',
  'saga-terminal-write',
];

test('repayment confirmation converges across every local durable boundary', async (t) => {
  for (const boundary of localBoundaries) {
    for (const side of ['before', 'after']) {
      await t.test(`${side}:${boundary}`, async () => {
        const harness = makeHarness();
        t.after(() => fs.rmSync(harness.dir, { recursive: true, force: true }));
        const before = {
          actual: actualState(harness),
          stores: readStores(harness),
        };
        const injector = faultSchedule([{ point: `${side}:${boundary}` }]);
        await assert.rejects(beginConfirm(harness, injector));
        assert.ok(injector.entries.every((entry) => entry.fired));
        if (boundary === 'initial-saga-write' && side === 'before') {
          assert.deepEqual(actualState(harness), before.actual);
          assert.deepEqual(readStores(harness), before.stores);
          assert.equal(Object.keys(sagaState(harness).sagas).length, 0);
          return;
        }
        await recoverRepeatedly(harness, injector);
        assertCompleted(harness);
      });
    }
  }
});

test('repayment confirmation converges across sync and terminal boundaries', async (t) => {
  for (const boundary of syncedBoundaries) {
    for (const side of ['before', 'after']) {
      await t.test(`${side}:${boundary}`, async () => {
        const harness = makeHarness();
        t.after(() => fs.rmSync(harness.dir, { recursive: true, force: true }));
        await beginConfirm(harness);
        assert.equal(latestSaga(harness).phase, 'sync_pending');
        const injector = faultSchedule([{ point: `${side}:${boundary}` }]);
        await assert.rejects(
          makeManager(harness).recover(actualAdapter(harness), { faultInjector: injector }),
        );
        assert.ok(injector.entries.every((entry) => entry.fired));
        await recoverRepeatedly(harness, injector);
        assertCompleted(harness);
      });
    }
  }
});

test('apply-then-throw category update is verified by exact id and not repeated', async (t) => {
  const harness = makeHarness({ applyThenThrowCategory: true });
  t.after(() => fs.rmSync(harness.dir, { recursive: true, force: true }));
  await assert.rejects(beginConfirm(harness), /response lost/);
  assert.equal(actualState(harness).counts.update, 1);
  assert.equal(latestSaga(harness).phase, 'category_pending');
  await recoverRepeatedly(harness);
  assert.equal(actualState(harness).counts.update, 1);
  assertCompleted(harness);
});

test('a failed sync leaves sync_pending and converges on retry', async (t) => {
  const harness = makeHarness();
  t.after(() => fs.rmSync(harness.dir, { recursive: true, force: true }));
  await beginConfirm(harness);
  const api = actualAdapter(harness);
  api.sync = async () => {
    const state = readJson(harness.paths.actual);
    state.counts.sync += 1;
    writeJson(harness.paths.actual, state);
    throw new Error('sync unavailable');
  };
  await assert.rejects(makeManager(harness).recover(api), /sync unavailable/);
  assert.equal(latestSaga(harness).phase, 'sync_pending');
  await recoverRepeatedly(harness);
  assertCompleted(harness);
});

test('one failed saga does not strand an independent sync-ready confirmation', async (t) => {
  const harness = makeHarness();
  t.after(() => fs.rmSync(harness.dir, { recursive: true, force: true }));
  await beginConfirm(harness);

  const state = sagaState(harness);
  const ready = Object.values(state.sagas)[0];
  const stale = structuredClone(ready);
  stale.id = 'stale-saga';
  stale.inflow = {
    ...stale.inflow,
    amountCents: 9999,
    fingerprint: inflowFingerprint({ ...inflow, amount: 9999 }),
  };
  stale.phase = 'category_pending';
  state.sagas[stale.id] = stale;
  writeJson(harness.paths.sagas, state);

  await assert.rejects(
    makeManager(harness).recover(actualAdapter(harness)),
    /financial shape changed/,
  );

  const recovered = sagaState(harness).sagas;
  assert.equal(recovered[ready.id].phase, 'completed');
  assert.equal(recovered[stale.id].phase, 'category_pending');
  assert.equal(actualState(harness).counts.sync, 1);
  assertCompleted(harness);
});

test('active repayment ownership blocks conflicting ids but terminal records do not', () => {
  const harness = makeHarness();
  try {
    writeJson(harness.paths.sagas, {
      schemaVersion: 1,
      sagas: {
        active: {
          id: 'active',
          recordVersion: 1,
          phase: 'links_pending',
          accountId: 'account',
          inflow: { id: inflow.id },
          allocations: [{ expenseId: expenseA.id }],
        },
        terminal: {
          id: 'terminal',
          recordVersion: 1,
          phase: 'completed',
          accountId: 'account',
          inflow: { id: 'terminal-inflow' },
          allocations: [],
        },
      },
    });
    const manager = makeManager(harness);
    for (const id of [inflow.id, expenseA.id]) {
      assert.throws(
        () => manager.assertAvailable({ accountId: 'account', ids: [id] }),
        (error) => error.code === 'REPAYMENT_CONFIRMATION_IN_PROGRESS' && error.status === 409,
      );
    }
    assert.doesNotThrow(() => manager.assertAvailable({ accountId: 'account', ids: ['terminal-inflow'] }));
    assert.doesNotThrow(() => manager.assertAvailable({ accountId: 'account', ids: ['unrelated-txn'] }));
  } finally {
    fs.rmSync(harness.dir, { recursive: true, force: true });
  }
});

test('pre-admission cent validation rejects over-allocation before any saga write', async () => {
  const harness = makeHarness();
  try {
  await assert.rejects(
    makeManager(harness).confirm(actualAdapter(harness), {
      ...admissionInput(),
      allocations: [
        { expenseId: expenseA.id, expenseAccountId: 'account', amountCents: 3000 },
        { expenseId: expenseB.id, expenseAccountId: 'account', amountCents: 3000 },
      ],
      existingLinks: [],
    }),
    (error) => error.code === 'REPAYMENT_ALLOCATION_PLAN_INVALID',
  );
  assert.equal(Object.keys(sagaState(harness).sagas).length, 0);
  assert.equal(actualState(harness).counts.update, 0);
  } finally {
    fs.rmSync(harness.dir, { recursive: true, force: true });
  }
});

test('split reimbursement leg confirmation converges after injected restart', async (t) => {
  const harness = makeHarness({ rows: [inflow, splitParent, expenseB, unrelated] });
  t.after(() => fs.rmSync(harness.dir, { recursive: true, force: true }));
  const injector = faultSchedule([{ point: 'after:link-0-write' }]);
  await assert.rejects(
    makeManager(harness).confirm(actualAdapter(harness), {
      ...splitAdmissionInput(),
      existingLinks: readStores(harness).links.links,
      faultInjector: injector,
    }),
  );
  assert.ok(injector.entries.every((entry) => entry.fired));
  const saga = latestSaga(harness);
  assert.equal(saga.allocations[0].expenseId, 'split-leg-reimb');
  assert.equal(saga.allocations[0].parentId, 'split-parent');
  await recoverRepeatedly(harness, injector);
  const inflowRow = actualState(harness).rows.find((row) => row.id === inflow.id);
  assert.equal(inflowRow.category, REIMB_CATEGORY);
  assert.equal(latestSaga(harness).phase, 'completed');
  const links = readStores(harness).links.links.filter((link) => link.inflow?.id === inflow.id);
  assert.ok(links.some((link) => link.expense?.id === 'split-leg-reimb'));
});
