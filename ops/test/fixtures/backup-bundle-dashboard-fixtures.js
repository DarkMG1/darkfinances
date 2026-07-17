'use strict';

const fs = require('fs');
const path = require('path');
const { STATE_REGISTRY } = require('../../../finance-dashboard/lib/state-registry');

const PRODUCTION_SHAPED = {
  accountOverrides: {
    schemaVersion: 2,
    accounts: { '00000000-0000-4000-8000-000000000001': { name: 'Cash', role: 'operating_cash' } },
  },
  billsPaid: { '2026-07': true },
  budgetSettings: { cat1: { rollover: true } },
  debtPlanner: { debts: [{ id: 'd1', name: 'Card' }] },
  events: { events: [{ slug: 'trip', name: 'Trip' }] },
  goals: [{ id: 'g1', name: 'Emergency', target: 1000 }],
  investmentHoldings: { holdings: [{ id: 'h1', symbol: 'VTI' }] },
  manualAssets: { items: [{ id: 'm1', name: 'Car', value: 10000 }] },
  operationJournal: {
    schemaVersion: 1,
    operations: {
      'idem-key-12345678': {
        recordVersion: 2,
        fingerprintVersion: 2,
        key: 'idem-key-12345678',
        fingerprint: 'a'.repeat(64),
        method: 'POST',
        route: '/api/v1/rules/apply',
        phase: 'completed',
        status: 'completed',
        startedAt: '2026-07-13T00:00:00.000Z',
        updatedAt: '2026-07-13T00:00:00.000Z',
        completedAt: '2026-07-13T00:00:00.000Z',
        localAppliedAt: '2026-07-13T00:00:00.000Z',
        provisionalResult: { ok: true },
        result: { ok: true },
      },
    },
  },
  owesConfig: { debtors: [{ slug: 'alex', name: 'Alex' }] },
  owesTruth: {
    schemaVersion: 2,
    bySlug: { alex: [{ event: 'trip', amount: 25 }] },
    source: 'splitwise-pairwise',
    generatedAt: '2026-07-13T00:00:00.000Z',
    manifest: {
      complete: true,
      itemizedComplete: true,
      resolvedEvents: 1,
      expectedEvents: 1,
      failedEvents: [],
      currency: 'USD',
    },
  },
  personalConfig: { ownerName: 'Owner' },
  phantomLog: { deleted: [{ importedId: 'x', at: '2026-07-13T00:00:00.000Z' }] },
  phantomSeen: { seen: { abc: { count: 1 } } },
  receipts: {
    schemaVersion: 1,
    byTxn: {
      t1: [{ id: 'r1', txnId: 't1', file: 'r1.jpg' }],
    },
  },
  reimbursementLinks: { links: [{ id: 'l1', inflowId: 'i1', expenseIds: ['e1'] }] },
  reimbursementSuggestions: { confirmed: {}, dismissed: ['s1'] },
  reconciliation: { enabled: true, months: { '2026-07': { closed: false, txns: {} } } },
  recurringOverrides: { netflix: { amount: 1599 } },
  reviewState: {
    schemaVersion: 1,
    dispositions: { 'task:1': { disposition: 'snooze', at: '2026-07-13T00:00:00.000Z' } },
  },
  rules: { rules: [{ id: 'r1', payee: 'Coffee', category: 'c1' }] },
  transactionDeletionSagas: {
    schemaVersion: 1,
    sagas: {
      s1: {
        id: 's1',
        recordVersion: 1,
        phase: 'completed',
        status: 'completed',
        updatedAt: '2026-07-13T00:00:00.000Z',
        terminalAt: '2026-07-13T00:00:00.000Z',
        target: { parentId: 'txn-1', ids: ['txn-1'], legIds: [] },
      },
    },
  },
  bulkOperationSagas: {
    schemaVersion: 1,
    sagas: {
      b1: {
        id: 'b1',
        recordVersion: 1,
        kind: 'rules_apply',
        phase: 'planning',
        status: 'started',
        updatedAt: '2026-07-13T00:00:00.000Z',
      },
    },
  },
  splitwiseMirrorResolutions: {
    schemaVersion: 1,
    resolutions: [{
      sourceId: '123',
      keepTxnId: 't1',
      dropTxnIds: ['t2'],
      observed: [
        { id: 't1', fingerprint: 'a'.repeat(64) },
        { id: 't2', fingerprint: 'b'.repeat(64) },
      ],
      reviewedAt: '2026-07-13T00:00:00.000Z',
      note: null,
    }],
  },
  repaymentConfirmationSagas: {
    schemaVersion: 1,
    sagas: {
      r1: {
        id: 'r1',
        recordVersion: 1,
        phase: 'completed',
        status: 'completed',
        updatedAt: '2026-07-13T00:00:00.000Z',
        terminalAt: '2026-07-13T00:00:00.000Z',
        inflow: { id: 'in-1' },
      },
    },
  },
  transactionSagas: {
    schemaVersion: 1,
    sagas: {
      t1: {
        id: 't1',
        recordVersion: 2,
        phase: 'completed',
        status: 'completed',
        updatedAt: '2026-07-13T00:00:00.000Z',
        terminalAt: '2026-07-13T00:00:00.000Z',
        original: { id: 'txn-1' },
      },
    },
  },
  venmoTruth: {
    schemaVersion: 2,
    bySlug: { alex: [{ event: 'venmo', amount: 10 }] },
  },
  passkeyCredentials: [{
    credentialID: 'cred-1',
    credentialPublicKey: Buffer.from('public-key-bytes').toString('base64'),
    counter: 0,
    transports: ['internal'],
    createdAt: '2026-07-13T00:00:00.000Z',
    lastUsedAt: null,
  }],
};

function writeProductionDashboard(root, options = {}) {
  fs.mkdirSync(path.join(root, 'receipts'), { recursive: true, mode: 0o700 });
  for (const [name, definition] of Object.entries(STATE_REGISTRY)) {
    if (!definition.backup) continue;
    const payload = options.overrides?.[name] ?? PRODUCTION_SHAPED[name];
    if (payload == null) continue;
    fs.writeFileSync(
      path.join(root, definition.filename),
      `${JSON.stringify(payload, null, 2)}\n`,
      { mode: 0o600 },
    );
  }
  fs.writeFileSync(path.join(root, 'receipts', 'r1.jpg'), options.receiptBytes || 'image-bytes', { mode: 0o600 });
  if (options.includeSecrets !== false) {
    fs.writeFileSync(path.join(root, '.env'), 'SESSION_SECRET=must-not-back-up\n', { mode: 0o600 });
  }
  if (options.includeLastGood) {
    fs.writeFileSync(
      path.join(root, 'goals.json.last-good'),
      `${JSON.stringify([{ id: 'g0', name: 'Legacy', target: 500 }], null, 2)}\n`,
      { mode: 0o600 },
    );
  }
  if (options.includeCorrupt) {
    fs.writeFileSync(path.join(root, 'rules.json.corrupt-2026-07-13T00-00-00-000Z'), '{broken', { mode: 0o600 });
  }
  return root;
}

module.exports = {
  PRODUCTION_SHAPED,
  writeProductionDashboard,
};
