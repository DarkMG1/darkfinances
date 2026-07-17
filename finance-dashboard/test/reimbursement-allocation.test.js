'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const os = require('os');
const path = require('path');
const {
  buildLegacyMigrationReport,
  classifyStoredLink,
  parseRequestedAllocationCents,
  sumTrustedAllocationsForExpense,
  sumTrustedAllocationsForInflow,
  validateLinkCapacity,
} = require('../lib/reimbursement-allocation');
const { createReimbursementLinkSaga } = require('../lib/reimbursement-link-saga');

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

  const manager = createReimbursementLinkSaga({
    sagaPath,
    readLinks: () => JSON.parse(fs.readFileSync(linksPath, 'utf8')),
    writeLinks: (store) => writeJson(linksPath, store),
    assertExternalAvailable: () => {},
  });

  const admission = {
    inflowLive: {
      id: 'in1', date: '2026-07-01', amountCents: 10000, accountId: 'checking', accountName: 'checking', payee: 'Pay',
    },
    expenseLive: {
      id: 'ex1', date: '2026-07-02', amountCents: -10000, accountId: 'checking', accountName: 'checking', payee: 'Exp', category: 'reimb-cat',
    },
    allocationCents: 2000,
    person: null,
    expectedVersion: null,
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
  const api = fakeApi({});
  const manager = createReimbursementLinkSaga({
    sagaPath,
    readLinks: () => JSON.parse(fs.readFileSync(linksPath, 'utf8')),
    writeLinks: (store) => writeJson(linksPath, store),
    assertExternalAvailable: () => {},
  });
  const admission = {
    inflowLive: { id: 'in1', amountCents: 5000, accountId: 'a', accountName: 'a', payee: 'p', date: '2026-07-01' },
    expenseLive: { id: 'ex1', amountCents: -5000, accountId: 'a', accountName: 'a', payee: 'e', date: '2026-07-01', category: 'reimb-cat' },
    allocationCents: 5000,
    person: null,
    expectedVersion: null,
  };
  await manager.link(api, admission, { operationIdentity: 'same-key' });
  await manager.link(api, admission, { operationIdentity: 'same-key' });
  const store = JSON.parse(fs.readFileSync(linksPath, 'utf8'));
  assert.equal(store.links.length, 1);
});
