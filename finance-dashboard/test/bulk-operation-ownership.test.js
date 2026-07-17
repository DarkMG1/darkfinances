'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const os = require('os');
const path = require('path');
const { createBulkOperationSaga } = require('../lib/bulk-operation-saga');
const { categoryIdentityFingerprint } = require('../lib/bulk-operation-fingerprint');

const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'darkfinances-bulk-ownership-'));
const stateFiles = {
  BULK_OPERATION_SAGAS_PATH: path.join(dir, 'bulk-operation-sagas.json'),
  RULES_PATH: path.join(dir, 'rules.json'),
  PHANTOM_SEEN_PATH: path.join(dir, 'phantom-seen.json'),
  PHANTOM_LOG_PATH: path.join(dir, 'phantom-log.json'),
};

function writeJson(file, value) {
  fs.writeFileSync(file, `${JSON.stringify(value, null, 2)}\n`);
}

function readJson(file) {
  return JSON.parse(fs.readFileSync(file, 'utf8'));
}

const uncategorized = Object.freeze({
  id: 'overlap-target',
  account: 'account',
  date: '2026-07-10',
  amount: -1200,
  payee: 'payee',
  imported_payee: 'Merchant Cafe',
  cleared: true,
  category: null,
  is_parent: false,
  subtransactions: [],
});

function makeManager() {
  writeJson(stateFiles.RULES_PATH, { rules: [] });
  writeJson(stateFiles.PHANTOM_SEEN_PATH, { seen: {} });
  writeJson(stateFiles.PHANTOM_LOG_PATH, { deleted: [] });
  return createBulkOperationSaga({
    sagaPath: stateFiles.BULK_OPERATION_SAGAS_PATH,
    readRules: () => readJson(stateFiles.RULES_PATH),
    writeRules: (store) => writeJson(stateFiles.RULES_PATH, store),
    readPhantomSeen: () => readJson(stateFiles.PHANTOM_SEEN_PATH),
    writePhantomSeen: (store) => writeJson(stateFiles.PHANTOM_SEEN_PATH, store),
    readPhantomLog: () => readJson(stateFiles.PHANTOM_LOG_PATH),
    writePhantomLog: (store) => writeJson(stateFiles.PHANTOM_LOG_PATH, store),
    deleteTransaction: async () => ({ ok: true }),
    inspectDeletionState: () => ({ schemaVersion: 1, sagas: {} }),
    recoverDeletionSagas: async () => ({ needsSync: false, errors: [] }),
    merchantCatalog: [],
    catalogTypeMatch: {},
    resolveCatalogCategory: () => null,
    buildCatInfo: () => ({}),
    settleUpPayee: /$^/,
    reimbCat: /$^/,
    incomeGroup: /$^/,
    moneyMovementGroup: /$^/,
    todayYMD: () => '2026-07-10',
    addDays: (date, delta) => {
      const next = new Date(`${date}T12:00:00.000Z`);
      next.setUTCDate(next.getUTCDate() + delta);
      return next.toISOString().slice(0, 10);
    },
    assertExternalAvailable: () => {},
  });
}

test('second bulk operation key targeting the same id is rejected at admission', async () => {
  writeJson(stateFiles.BULK_OPERATION_SAGAS_PATH, {
    schemaVersion: 1,
    sagas: {
      active: {
        id: 'active-bulk',
        recordVersion: 1,
        kind: 'rules_apply',
        operationKey: 'first-key',
        phase: 'items_pending',
        plan: {
          items: [{
            globalIndex: 0,
            itemType: 'category_update',
            stageId: 'rule:r1',
            accountId: 'account',
            txnId: uncategorized.id,
            date: uncategorized.date,
            identityFingerprint: categoryIdentityFingerprint(uncategorized),
            intent: { categoryId: 'category' },
          }],
        },
        cursor: { itemIndex: 0 },
        completedIndexes: [],
        itemOutcomes: {},
        delegatedDeletionSagaIds: {},
        createdAt: new Date().toISOString(),
        updatedAt: new Date().toISOString(),
      },
    },
  });
  const manager = makeManager();
  writeJson(stateFiles.RULES_PATH, {
    rules: [{ id: 'r1', match: 'Merchant', categoryId: 'category', categoryName: 'Dining', created: '2026-07-10' }],
  });
  const rows = [structuredClone(uncategorized)];
  const api = {
    getAccounts: async () => [{ id: 'account', name: 'Account', closed: false, offbudget: false }],
    getPayees: async () => [{ id: 'payee', name: 'Merchant' }],
    getCategoryGroups: async () => [{ id: 'group', name: 'Spending', is_income: false, categories: [{ id: 'category', name: 'Dining' }] }],
    getTransactions: async () => rows.map((row) => structuredClone(row)),
    updateTransaction: async (id, fields) => {
      const row = rows.find((entry) => String(entry.id) === String(id));
      if (row) Object.assign(row, fields);
    },
    sync: async () => {},
  };
  await assert.rejects(
    manager.run(api, { kind: 'rules_apply', operationKey: 'second-key', deferSync: true }),
    (error) => error.code === 'BULK_OPERATION_IN_PROGRESS',
  );
});

test('terminal bulk records do not block unrelated work', async () => {
  writeJson(stateFiles.BULK_OPERATION_SAGAS_PATH, {
    schemaVersion: 1,
    sagas: {
      done: {
        id: 'done',
        recordVersion: 1,
        kind: 'rules_apply',
        operationKey: 'done-key',
        phase: 'completed',
        plan: { items: [] },
        cursor: { itemIndex: 0 },
        completedIndexes: [],
        itemOutcomes: {},
        delegatedDeletionSagaIds: {},
        createdAt: new Date().toISOString(),
        updatedAt: new Date().toISOString(),
      },
    },
  });
  const manager = makeManager();
  const rows = [structuredClone(uncategorized)];
  const api = {
    getAccounts: async () => [{ id: 'account', name: 'Account', closed: false, offbudget: false }],
    getPayees: async () => [{ id: 'payee', name: 'Merchant' }],
    getCategoryGroups: async () => [{
      id: 'group',
      name: 'Spending',
      is_income: false,
      categories: [{ id: 'category', name: 'Dining' }],
    }],
    getTransactions: async () => rows.map((row) => structuredClone(row)),
    updateTransaction: async (id, fields) => {
      const row = rows.find((entry) => String(entry.id) === String(id));
      if (row) Object.assign(row, fields);
    },
    sync: async () => {},
  };
  writeJson(stateFiles.RULES_PATH, {
    rules: [{ id: 'r1', match: 'Merchant', categoryId: 'category', categoryName: 'Dining', created: '2026-07-10' }],
  });
  const result = await manager.run(api, { kind: 'rules_apply', operationKey: 'fresh-key', deferSync: true });
  assert.equal(result.applied, 1);
});

test('bulk blocks replacement ownership on the same transaction id', () => {
  writeJson(stateFiles.BULK_OPERATION_SAGAS_PATH, {
    schemaVersion: 1,
    sagas: {
      active: {
        id: 'active-bulk',
        recordVersion: 1,
        kind: 'rules_apply',
        operationKey: 'bulk-key',
        phase: 'items_pending',
        plan: {
          items: [{
            globalIndex: 0,
            itemType: 'category_update',
            stageId: 'rule:r1',
            accountId: 'account',
            txnId: uncategorized.id,
            date: uncategorized.date,
            identityFingerprint: categoryIdentityFingerprint(uncategorized),
            intent: { categoryId: 'category' },
          }],
        },
        cursor: { itemIndex: 0 },
        completedIndexes: [],
        itemOutcomes: {},
        delegatedDeletionSagaIds: {},
        createdAt: new Date().toISOString(),
        updatedAt: new Date().toISOString(),
      },
    },
  });
  const manager = makeManager();
  assert.throws(
    () => manager.assertAvailable({ ids: [uncategorized.id] }),
    (error) => error.code === 'BULK_OPERATION_IN_PROGRESS',
  );
});

test('phantom sidecars_pending retains seen ownership until terminal', async () => {
  const manager = makeManager();
  const txnId = 'phantom-owned';
  writeJson(stateFiles.BULK_OPERATION_SAGAS_PATH, {
    schemaVersion: 1,
    sagas: {
      active: {
        id: 'active-phantom',
        recordVersion: 1,
        kind: 'phantom_cleanup',
        operationKey: 'first-phantom',
        phase: 'sidecars_pending',
        plan: {
          items: [
            {
              globalIndex: 0,
              itemType: 'phantom_seen',
              stageId: 'phantom_seen',
              accountId: 'account',
              txnId,
              date: '2026-06-01',
              identityFingerprint: 'abc',
              intent: {},
            },
            {
              globalIndex: 1,
              itemType: 'phantom_delete',
              stageId: 'phantom_delete',
              accountId: 'account',
              txnId,
              date: '2026-06-01',
              identityFingerprint: 'abc',
              intent: { reason: 'test' },
            },
          ],
        },
        cursor: { itemIndex: 1 },
        completedIndexes: [0, 1],
        itemOutcomes: {
          0: { status: 'completed' },
          1: { status: 'completed' },
        },
        delegatedDeletionSagaIds: { [txnId]: 'del-1' },
        createdAt: new Date().toISOString(),
        updatedAt: new Date().toISOString(),
      },
    },
  });
  assert.throws(
    () => manager.assertAvailable({ ids: [txnId] }),
    (error) => error.code === 'BULK_OPERATION_IN_PROGRESS',
  );

  const terminal = readJson(stateFiles.BULK_OPERATION_SAGAS_PATH);
  terminal.sagas.active.phase = 'sync_pending';
  writeJson(stateFiles.BULK_OPERATION_SAGAS_PATH, terminal);
  assert.doesNotThrow(() => manager.assertAvailable({ ids: [txnId] }));
});
