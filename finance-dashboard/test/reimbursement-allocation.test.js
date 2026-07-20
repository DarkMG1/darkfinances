'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const os = require('os');
const path = require('path');
const {
  assertAllocationFieldsAgree,
  assertLegacyAmbiguityAdmission,
  buildLegacyMigrationReport,
  classifyStoredLink,
  parseRequestedAllocationCents,
  ReimbursementAllocationFieldsError,
  ReimbursementLegacyAmbiguityBlockedError,
  sumTrustedAllocationsForExpense,
  sumTrustedAllocationsForInflow,
  validateLinkCapacity,
} = require('../lib/reimbursement-allocation');
const { createReimbursementLinkSaga } = require('../lib/reimbursement-link-saga');
const {
  revalidateLinkApply,
  revalidateUnlinkApply,
} = require('../lib/reimbursement-link-admission');

function tempDir() {
  return fs.mkdtempSync(path.join(os.tmpdir(), 'reimb-alloc-'));
}

function writeJson(file, value) {
  fs.writeFileSync(file, JSON.stringify(value, null, 2));
}

function fakeApi(transactionsByAccount) {
  return {
    async getAccounts() {
      return Object.keys(transactionsByAccount).map((id) => ({ id, name: id, closed: false }));
    },
    async getTransactions(accountId) {
      return transactionsByAccount[accountId] || [];
    },
  };
}

function liveSnapshot({
  id,
  amountCents,
  date = '2026-07-01',
  category = 'cat-income',
  accountId = 'checking',
  payee = 'Pay',
}) {
  return {
    id,
    date,
    amountCents,
    accountId,
    accountName: accountId,
    payee,
    category,
    imported: false,
    parentId: null,
    isLeg: false,
  };
}

function expenseSnapshot({
  id,
  amountCents,
  date = '2026-07-02',
  category = 'reimb-cat',
  accountId = 'checking',
  payee = 'Exp',
}) {
  return liveSnapshot({ id, amountCents, date, category, accountId, payee });
}

function createTestLinkSaga({ sagaPath, linksPath, reimbCategoryId = 'reimb-cat' }) {
  return createReimbursementLinkSaga({
    sagaPath,
    readLinks: () => JSON.parse(fs.readFileSync(linksPath, 'utf8')),
    writeLinks: (store) => writeJson(linksPath, store),
    assertExternalAvailable: () => {},
    resolveReimbCategoryId: async () => reimbCategoryId,
    resolvePayeeNames: async () => ({}),
    revalidateLinkApply,
    revalidateUnlinkApply,
  });
}

test('allocationCents and amount must agree when both are provided', () => {
  assert.throws(
    () => assertAllocationFieldsAgree({ allocationCents: 1000, amount: 10.01 }),
    ReimbursementAllocationFieldsError,
  );
  assert.equal(parseRequestedAllocationCents({ allocationCents: 1000, amount: 10 }), 1000);
});

test('legacy ambiguity blocks new trusted allocation on touched endpoints', () => {
  const links = [{
    inflow: { id: 'in1' },
    expense: { id: 'ex1' },
    amount: null,
  }];
  assert.throws(
    () => assertLegacyAmbiguityAdmission({
      links,
      inflowId: 'in1',
      expenseId: 'ex2',
      existingLink: null,
      allowSamePairResolution: false,
    }),
    ReimbursementLegacyAmbiguityBlockedError,
  );
});

test('same-pair legacy upgrade is allowed when no other ambiguity touches endpoints', () => {
  const links = [{
    inflow: { id: 'in1' },
    expense: { id: 'ex1' },
    amount: null,
  }];
  assert.doesNotThrow(() => assertLegacyAmbiguityAdmission({
    links,
    inflowId: 'in1',
    expenseId: 'ex1',
    existingLink: links[0],
    allowSamePairResolution: true,
  }));
});

test('different-pair allocation remains blocked when legacy ambiguity exists on endpoint', () => {
  const links = [{
    inflow: { id: 'in1' },
    expense: { id: 'ex1' },
    amount: null,
  }];
  assert.throws(
    () => assertLegacyAmbiguityAdmission({
      links,
      inflowId: 'in1',
      expenseId: 'ex2',
      existingLink: null,
      allowSamePairResolution: false,
    }),
    ReimbursementLegacyAmbiguityBlockedError,
  );
});

test('property: trusted sums never exceed live capacities for random partials', () => {
  const links = [];
  const capacities = { in1: 5000, ex1: 10000, ex2: 7000 };
  const partials = [1000, 1500, 2500];
  for (const cents of partials) {
    validateLinkCapacity({
      allocationCents: cents,
      inflowAmountCents: capacities.in1,
      expenseAmountCents: -capacities.ex1,
      existingLinks: links,
      inflowId: 'in1',
      expenseId: 'ex1',
    });
    links.push({ inflow: { id: 'in1' }, expense: { id: 'ex1' }, allocationCents: cents, amount: cents / 100 });
  }
  assert.equal(sumTrustedAllocationsForInflow(links, 'in1'), 5000);
  assert.throws(
    () => validateLinkCapacity({
      allocationCents: 1,
      inflowAmountCents: capacities.in1,
      expenseAmountCents: -capacities.ex1,
      existingLinks: links,
      inflowId: 'in1',
      expenseId: 'ex2',
    }),
    /remaining inflow capacity/,
  );
});

test('sequential links on shared expense cannot exceed capacity', async (t) => {
  const dir = tempDir();
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
  const sagaPath = path.join(dir, 'link-sagas.json');
  const linksPath = path.join(dir, 'links.json');
  writeJson(linksPath, { schemaVersion: 2, links: [] });
  const api = fakeApi({
    checking: [
      { id: 'in1', date: '2026-07-01', amount: 10000, category: 'cat-income' },
      { id: 'in2', date: '2026-07-01', amount: 10000, category: 'cat-income' },
      { id: 'ex1', date: '2026-07-02', amount: -5000, category: 'reimb-cat' },
    ],
  });
  const manager = createTestLinkSaga({ sagaPath, linksPath });
  const mkAdmission = (inflowId, cents) => ({
    inflowLive: liveSnapshot({ id: inflowId, amountCents: 10000, category: 'cat-income', date: '2026-07-01' }),
    expenseLive: expenseSnapshot({ id: 'ex1', amountCents: -5000, date: '2026-07-02' }),
    allocationCents: cents,
    person: null,
    expectedVersion: null,
    allowSamePairResolution: false,
  });
  await manager.link(api, mkAdmission('in1', 3000), { operationIdentity: 'op-a' });
  await assert.rejects(
    () => manager.link(api, mkAdmission('in2', 3000), { operationIdentity: 'op-b' }),
    /remaining expense capacity/,
  );
});

test('DELETE same-key replay is idempotent', async (t) => {
  const dir = tempDir();
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
  const sagaPath = path.join(dir, 'link-sagas.json');
  const linksPath = path.join(dir, 'links.json');
  writeJson(linksPath, {
    schemaVersion: 2,
    links: [{
      inflow: { id: 'in1', accountId: 'checking' },
      expense: { id: 'ex1' },
      allocationCents: 1000,
      amount: 10,
      version: 1,
    }],
  });
  const api = fakeApi({
    checking: [
      { id: 'in1', date: '2026-07-01', amount: 10000, category: 'cat-income' },
      { id: 'ex1', date: '2026-07-02', amount: -10000, category: 'reimb-cat' },
    ],
  });
  const manager = createTestLinkSaga({ sagaPath, linksPath });
  const first = await manager.unlink(api, {
    inflowId: 'in1',
    expenseId: 'ex1',
    accountId: 'checking',
    expectedVersion: 1,
    operationIdentity: 'unlink-op',
  });
  assert.equal(first.removed, 1);
  const replay = await manager.unlink(api, {
    inflowId: 'in1',
    expenseId: 'ex1',
    accountId: 'checking',
    expectedVersion: 1,
    operationIdentity: 'unlink-op',
  });
  assert.equal(replay.idempotent, true);
});

test('apply-time moved endpoint fails closed', async (t) => {
  const dir = tempDir();
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
  const sagaPath = path.join(dir, 'link-sagas.json');
  const linksPath = path.join(dir, 'links.json');
  writeJson(linksPath, { schemaVersion: 2, links: [] });
  const api = fakeApi({
    checking: [
      { id: 'in1', date: '2026-07-01', amount: 10000, category: 'cat-income' },
      { id: 'ex1', date: '2026-07-02', amount: -10000, category: 'reimb-cat' },
    ],
  });
  const manager = createTestLinkSaga({ sagaPath, linksPath });
  const admission = {
    inflowLive: liveSnapshot({ id: 'in1', amountCents: 10000, category: 'cat-income' }),
    expenseLive: expenseSnapshot({ id: 'ex1', amountCents: -10000 }),
    allocationCents: 2000,
    person: null,
    expectedVersion: null,
    allowSamePairResolution: false,
  };
  writeJson(sagaPath, {
    schemaVersion: 1,
    sagas: {
      pending: {
        id: 'pending',
        recordVersion: 1,
        phase: 'prepared',
        action: 'link',
        inflowId: 'in1',
        expenseId: 'ex1',
        allocationCents: 2000,
        inflowLive: admission.inflowLive,
        expenseLive: admission.expenseLive,
        allowSamePairResolution: false,
        linkKey: 'in1:ex1',
        accountId: 'checking',
        startedAt: '2026-07-01T00:00:00.000Z',
        updatedAt: '2026-07-01T00:00:00.000Z',
      },
    },
  });
  const rows = [
    { id: 'in1', date: '2026-07-01', amount: 10000, category: 'cat-income' },
    { id: 'ex1', date: '2026-07-02', amount: -10000, category: 'reimb-cat' },
  ];
  api.getTransactions = async () => rows.map((row) => (
    row.id === 'ex1' ? { ...row, date: '2026-07-03' } : row
  ));
  const result = await manager.recover(api);
  assert.ok(result.errors.length > 0);
  assert.match(String(result.errors[0].error.message), /changed during mutation|no longer valid/);
});

test('parseRequestedAllocationCents requires explicit allocation', () => {
  assert.equal(parseRequestedAllocationCents({ allocationCents: 2000 }), 2000);
  assert.equal(parseRequestedAllocationCents({ amount: 20 }), 2000);
  assert.throws(() => parseRequestedAllocationCents({}), /explicit allocationCents or amount is required/);
  assert.throws(() => parseRequestedAllocationCents({ amount: 0.001 }), /whole cents|decimal places|allocationCents must be positive/);
});

test('legacy null links stay ambiguous and excluded from trusted totals', () => {
  const legacy = {
    inflow: { id: 'in1', amount: 100 },
    expense: { id: 'ex1', amount: -100 },
    amount: null,
  };
  const classified = classifyStoredLink(legacy);
  assert.equal(classified.trusted, false);
  assert.equal(classified.ambiguous, true);
  assert.equal(sumTrustedAllocationsForExpense([legacy], 'ex1'), 0);
  const report = buildLegacyMigrationReport([legacy]);
  assert.equal(report.ambiguousCount, 1);
  assert.equal(report.rows[0].inflowId, 'in1');
});

test('validateLinkCapacity enforces both expense and inflow sides', () => {
  const links = [{
    inflow: { id: 'in1' },
    expense: { id: 'ex1' },
    allocationCents: 3000,
    amount: 30,
  }];
  assert.throws(
    () => validateLinkCapacity({
      allocationCents: 2500,
      inflowAmountCents: 5000,
      expenseAmountCents: -4000,
      existingLinks: links,
      inflowId: 'in2',
      expenseId: 'ex1',
    }),
    /remaining expense capacity/,
  );
  assert.throws(
    () => validateLinkCapacity({
      allocationCents: 2500,
      inflowAmountCents: 5000,
      expenseAmountCents: -10000,
      existingLinks: links,
      inflowId: 'in1',
      expenseId: 'ex2',
    }),
    /remaining inflow capacity/,
  );
  const ok = validateLinkCapacity({
    allocationCents: 2000,
    inflowAmountCents: 5000,
    expenseAmountCents: -10000,
    existingLinks: links,
    inflowId: 'in2',
    expenseId: 'ex1',
  });
  assert.equal(ok.allocationCents, 2000);
  assert.equal(ok.inflowRemainingCents, 3000);
});

test('partial $20/$100 link conserves capacity on both sides', () => {
  const capacity = validateLinkCapacity({
    allocationCents: 2000,
    inflowAmountCents: 2000,
    expenseAmountCents: -10000,
    existingLinks: [],
    inflowId: 'pay',
    expenseId: 'exp',
  });
  assert.equal(capacity.expenseRemainingCents, 8000);
  assert.equal(capacity.inflowRemainingCents, 0);
});

test('one-to-many and many-to-one allocations sum under each capacity', () => {
  const links = [
    { inflow: { id: 'in1' }, expense: { id: 'ex1' }, allocationCents: 2000, amount: 20 },
    { inflow: { id: 'in1' }, expense: { id: 'ex2' }, allocationCents: 3000, amount: 30 },
    { inflow: { id: 'in2' }, expense: { id: 'ex3' }, allocationCents: 1500, amount: 15 },
  ];
  assert.equal(sumTrustedAllocationsForInflow(links, 'in1'), 5000);
  assert.equal(sumTrustedAllocationsForExpense(links, 'ex1'), 2000);
  assert.throws(
    () => validateLinkCapacity({
      allocationCents: 100,
      inflowAmountCents: 5000,
      expenseAmountCents: -2000,
      existingLinks: links,
      inflowId: 'in3',
      expenseId: 'ex1',
    }),
    /remaining expense capacity/,
  );
});

test('reimbursement link saga converges after injected restart', async (t) => {
  const dir = tempDir();
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
  const sagaPath = path.join(dir, 'link-sagas.json');
  const linksPath = path.join(dir, 'links.json');
  writeJson(linksPath, { schemaVersion: 2, links: [] });

  const api = fakeApi({
    checking: [
      { id: 'in1', date: '2026-07-01', amount: 10000, category: 'cat-income' },
      { id: 'ex1', date: '2026-07-02', amount: -10000, category: 'reimb-cat' },
    ],
  });

  const manager = createTestLinkSaga({ sagaPath, linksPath });

  const admission = {
    inflowLive: liveSnapshot({ id: 'in1', amountCents: 10000, category: 'cat-income' }),
    expenseLive: expenseSnapshot({ id: 'ex1', amountCents: -10000 }),
    allocationCents: 2000,
    person: null,
    expectedVersion: null,
    allowSamePairResolution: false,
  };

  const faults = new Set(['after:links-write']);
  const faultInjector = async (point) => {
    if (faults.has(point)) throw new Error(`injected fault at ${point}`);
  };

  await assert.rejects(
    () => manager.link(api, admission, { operationIdentity: 'op-1', faultInjector }),
    /injected fault at after:links-write/,
  );
  await manager.recover(api);
  const store = JSON.parse(fs.readFileSync(linksPath, 'utf8'));
  assert.equal(store.links.length, 1);
  assert.equal(store.links[0].allocationCents, 2000);

  const replay = await manager.link(api, admission, { operationIdentity: 'op-1' });
  assert.equal(replay.idempotent, true);
});

test('same-key replay is idempotent without duplicate links', async (t) => {
  const dir = tempDir();
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
  const sagaPath = path.join(dir, 'link-sagas.json');
  const linksPath = path.join(dir, 'links.json');
  writeJson(linksPath, { schemaVersion: 2, links: [] });
  const api = fakeApi({
    checking: [
      { id: 'in1', date: '2026-07-01', amount: 5000, category: 'cat-income' },
      { id: 'ex1', date: '2026-07-01', amount: -5000, category: 'reimb-cat' },
    ],
  });
  const manager = createTestLinkSaga({ sagaPath, linksPath });
  const admission = {
    inflowLive: liveSnapshot({ id: 'in1', amountCents: 5000, category: 'cat-income' }),
    expenseLive: expenseSnapshot({ id: 'ex1', amountCents: -5000, date: '2026-07-01' }),
    allocationCents: 5000,
    person: null,
    expectedVersion: null,
    allowSamePairResolution: false,
  };
  await manager.link(api, admission, { operationIdentity: 'same-key' });
  await manager.link(api, admission, { operationIdentity: 'same-key' });
  const store = JSON.parse(fs.readFileSync(linksPath, 'utf8'));
  assert.equal(store.links.length, 1);
});
