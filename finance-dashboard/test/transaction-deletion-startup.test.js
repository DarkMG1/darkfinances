'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const os = require('os');
const path = require('path');
const { spawnSync } = require('child_process');
const {
  canonicalTransactionSnapshot,
  transactionDeletionFingerprint,
} = require('../lib/transaction-deletion-saga');

function writeJson(file, value) {
  fs.writeFileSync(file, `${JSON.stringify(value, null, 2)}\n`);
}

test('existing startup recovery completes deletion and terminal restart performs no work', (t) => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'darkfinances-delete-startup-'));
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
  const dashboardRoot = path.resolve(__dirname, '..');
  const actualPath = path.join(dir, 'actual.json');
  const sagaPath = path.join(dir, 'transaction-deletion-sagas.json');
  const receiptDir = path.join(dir, 'receipts');
  const actualModule = path.join(dir, 'durable-actual.js');
  fs.mkdirSync(receiptDir);
  fs.writeFileSync(path.join(receiptDir, 'deleted.jpg'), 'planned receipt bytes');

  const deleted = {
    id: 'deleted-parent',
    account: 'account',
    date: '2026-07-10',
    amount: -500,
    payee: 'payee',
    notes: 'deleted',
    cleared: true,
    imported_id: null,
    category: 'category',
    is_parent: false,
    subtransactions: [],
  };
  const snapshot = canonicalTransactionSnapshot(deleted);
  writeJson(actualPath, {
    accounts: [
      { id: 'account', name: 'Account', closed: false, offbudget: false },
      { id: 'closed-account', name: 'Closed', closed: true, offbudget: false },
    ],
    rows: [{
      ...deleted,
      id: 'unrelated',
      amount: -700,
      notes: 'unrelated',
    }],
    counts: { delete: 0, sync: 0 },
  });
  writeJson(sagaPath, {
    schemaVersion: 1,
    sagas: {
      pending: {
        id: 'pending',
        recordVersion: 1,
        status: 'started',
        phase: 'sync_pending',
        accountId: 'account',
        date: deleted.date,
        target: {
          parentId: deleted.id,
          legIds: [],
          ids: [deleted.id],
          snapshot,
          fingerprint: transactionDeletionFingerprint(deleted),
        },
        referencePlan: {
          version: 1,
          targetIds: [deleted.id],
          steps: ['receipts', 'links', 'suggestions', 'reconciliation', 'phantomSeen'],
          completedSteps: ['receipts', 'links', 'suggestions', 'reconciliation', 'phantomSeen'],
          stats: {
            receipts: 1,
            links: 0,
            suggestions: 0,
            reconciliation: 0,
            phantomSeen: 0,
          },
          receiptFiles: ['deleted.jpg'],
        },
        startedAt: '2026-07-10T00:00:00.000Z',
        updatedAt: '2026-07-10T00:00:01.000Z',
      },
    },
  });
  const state = {
    PERSONAL_CONFIG_PATH: path.join(dir, 'personal.json'),
    RECEIPTS_PATH: path.join(dir, 'receipts.json'),
    RECEIPTS_DIR: receiptDir,
    REIMB_LINKS_PATH: path.join(dir, 'links.json'),
    REIMB_SUGGEST_PATH: path.join(dir, 'suggestions.json'),
    RECON_PATH: path.join(dir, 'reconciliation.json'),
    PHANTOM_SEEN_PATH: path.join(dir, 'phantom-seen.json'),
    TRANSACTION_SAGAS_PATH: path.join(dir, 'transaction-sagas.json'),
    TRANSACTION_DELETION_SAGAS_PATH: sagaPath,
  };
  writeJson(state.PERSONAL_CONFIG_PATH, { people: [], nameMap: {} });
  writeJson(state.RECEIPTS_PATH, { byTxn: {} });
  writeJson(state.REIMB_LINKS_PATH, { links: [] });
  writeJson(state.REIMB_SUGGEST_PATH, { confirmed: {}, dismissed: [] });
  writeJson(state.RECON_PATH, { enabled: false, months: {} });
  writeJson(state.PHANTOM_SEEN_PATH, { seen: {} });
  fs.writeFileSync(actualModule, `
    const fs = require('fs');
    const file = process.env.TEST_ACTUAL_STATE;
    const read = () => JSON.parse(fs.readFileSync(file, 'utf8'));
    const write = (value) => fs.writeFileSync(file, JSON.stringify(value, null, 2) + '\\n');
    exports.init = async () => {};
    exports.downloadBudget = async () => {};
    exports.shutdown = async () => {};
    exports.getAccounts = async () => read().accounts;
    exports.getTransactions = async (accountId, start, end) => read().rows
      .filter((row) => row.account === accountId && row.date >= start && row.date <= end);
    exports.deleteTransaction = async (id) => {
      const state = read();
      state.counts.delete += 1;
      state.rows = state.rows.filter((row) => String(row.id) !== String(id));
      write(state);
    };
    exports.sync = async () => {
      const state = read();
      state.counts.sync += 1;
      write(state);
    };
  `);

  const runStartup = () => spawnSync(
    process.execPath,
    ['-e', `
      require(${JSON.stringify(path.join(dashboardRoot, 'dataModule.js'))})
        .initApi()
        .then(() => process.stdout.write('ready'))
        .catch((error) => { console.error(error.stack || error); process.exit(1); });
    `],
    {
      cwd: dashboardRoot,
      env: {
        ...process.env,
        ...state,
        ACTUAL_API_PATH: actualModule,
        ACTUAL_DATA_DIR: path.join(dir, 'actual-cache'),
        ACTUAL_SERVER_URL: 'http://127.0.0.1:1',
        ACTUAL_SYNC_ID: 'fake',
        TEST_ACTUAL_STATE: actualPath,
      },
      encoding: 'utf8',
    },
  );

  let result = runStartup();
  assert.equal(result.status, 0, result.stderr);
  assert.equal(result.stdout, 'ready');
  assert.equal(JSON.parse(fs.readFileSync(actualPath, 'utf8')).counts.sync, 1);
  assert.equal(JSON.parse(fs.readFileSync(actualPath, 'utf8')).counts.delete, 0);
  assert.equal(JSON.parse(fs.readFileSync(sagaPath, 'utf8')).sagas.pending.phase, 'completed');
  assert.equal(fs.existsSync(path.join(receiptDir, 'deleted.jpg')), false);

  const terminalState = fs.readFileSync(sagaPath, 'utf8');
  result = runStartup();
  assert.equal(result.status, 0, result.stderr);
  assert.equal(JSON.parse(fs.readFileSync(actualPath, 'utf8')).counts.sync, 1);
  assert.equal(JSON.parse(fs.readFileSync(actualPath, 'utf8')).counts.delete, 0);
  assert.equal(fs.readFileSync(sagaPath, 'utf8'), terminalState);
});
