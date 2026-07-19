'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const os = require('os');
const path = require('path');
const { OperationJournal } = require('../lib/operation-journal');
const { executeJournaledOperation } = require('../lib/operation-executor');
const { reconcileOperationJournalFromProof } = require('../lib/operation-reconciliation');
const {
  composeTerminalProofResolver,
  journalProofFromOperation,
} = require('../lib/operation-journal-proof');
const { createReimbursementLinkSaga } = require('../lib/reimbursement-link-saga');
const { createRepaymentConfirmationSaga } = require('../lib/repayment-confirmation-saga');
const { createBulkOperationSaga } = require('../lib/bulk-operation-saga');
const {
  revalidateLinkApply,
  revalidateUnlinkApply,
} = require('../lib/reimbursement-link-admission');

function writeJson(file, value) {
  fs.writeFileSync(file, `${JSON.stringify(value, null, 2)}\n`);
}

function readJson(file) {
  return JSON.parse(fs.readFileSync(file, 'utf8'));
}

function tempDir(prefix) {
  return fs.mkdtempSync(path.join(os.tmpdir(), prefix));
}

function linkBinding(overrides = {}) {
  return {
    fingerprint: 'a'.repeat(64),
    fingerprintVersion: 2,
    method: 'POST',
    route: '/api/v1/reimb-links',
    ...overrides,
  };
}

function unlinkBinding(overrides = {}) {
  return {
    fingerprint: 'b'.repeat(64),
    fingerprintVersion: 2,
    method: 'DELETE',
    route: '/api/v1/reimb-links',
    ...overrides,
  };
}

function repaymentBinding(overrides = {}) {
  return {
    fingerprint: 'c'.repeat(64),
    fingerprintVersion: 2,
    method: 'POST',
    route: '/api/v1/repayments/sg_inflow/confirm',
    ...overrides,
  };
}

function createTestLinkSaga({ sagaPath, linksPath, terminalLimit = 100 }) {
  return createReimbursementLinkSaga({
    sagaPath,
    terminalLimit,
    readLinks: () => readJson(linksPath),
    writeLinks: (store) => writeJson(linksPath, store),
    assertExternalAvailable: () => {},
    resolveReimbCategoryId: async () => 'reimb-cat',
    resolvePayeeNames: async () => ({}),
    revalidateLinkApply,
    revalidateUnlinkApply,
  });
}

function createTestRepaySaga({ sagaPath }) {
  return createRepaymentConfirmationSaga({
    sagaPath,
    readLinks: () => ({ schemaVersion: 2, links: [] }),
    writeLinks: () => {},
    readSuggestions: () => ({ schemaVersion: 1, confirmed: {}, dismissed: [] }),
    writeSuggestions: () => {},
    assertExternalAvailable: () => {},
  });
}

function journalRequest(overrides = {}) {
  return {
    method: 'POST',
    path: '/api/v1/reimb-links',
    url: '/api/v1/reimb-links',
    body: { inflow: { id: 'in1' }, expense: { id: 'ex1' }, allocationCents: 1000 },
    ...overrides,
  };
}

function terminalProofResolverFrom(provers) {
  return composeTerminalProofResolver(Object.entries(provers).map(([, fn]) => fn));
}

test('reimbursement link terminal proof requires exact bound fingerprint and rejects corrupt records', () => {
  const dir = tempDir('darkfinances-reimb-proof-');
  const sagaPath = path.join(dir, 'reimb-link-sagas.json');
  const linksPath = path.join(dir, 'links.json');
  writeJson(linksPath, { schemaVersion: 2, links: [] });
  const binding = linkBinding();
  writeJson(sagaPath, {
    schemaVersion: 1,
    sagas: {
      bound: {
        id: 'bound',
        recordVersion: 1,
        action: 'link',
        operationIdentity: 'proof-key',
        operationJournalFingerprint: binding.fingerprint,
        operationJournalFingerprintVersion: 2,
        operationJournalMethod: 'POST',
        operationJournalRoute: '/api/v1/reimb-links',
        phase: 'completed',
        status: 'completed',
        terminalAt: '2026-07-10T00:00:00.000Z',
        updatedAt: '2026-07-10T00:00:00.000Z',
        inflowId: 'in1',
        expenseId: 'ex1',
        allocationCents: 1000,
        linkKey: 'in1:ex1',
        resultVersion: 1,
      },
      corrupt: {
        id: 'corrupt',
        recordVersion: 1,
        action: 'link',
        operationIdentity: 'corrupt-key',
        operationJournalFingerprint: binding.fingerprint,
        operationJournalFingerprintVersion: 2,
        operationJournalMethod: 'POST',
        operationJournalRoute: '/api/v1/reimb-links',
        phase: 'completed',
        status: 'completed',
        updatedAt: '2026-07-10T00:00:00.000Z',
        inflowId: 'in1',
        expenseId: 'ex1',
      },
      incomplete: {
        id: 'incomplete',
        recordVersion: 1,
        action: 'link',
        operationIdentity: 'incomplete-key',
        operationJournalFingerprint: binding.fingerprint,
        operationJournalFingerprintVersion: 2,
        operationJournalMethod: 'POST',
        operationJournalRoute: '/api/v1/reimb-links',
        phase: 'links-pending',
        status: 'started',
        updatedAt: '2026-07-10T00:00:00.000Z',
        inflowId: 'in1',
        expenseId: 'ex1',
      },
    },
  });
  const manager = createTestLinkSaga({ sagaPath, linksPath });
  const journalOperation = {
    fingerprint: binding.fingerprint,
    fingerprintVersion: 2,
    method: 'POST',
    route: '/api/v1/reimb-links',
  };
  const proven = manager.proveTerminalJournalCompletion('proof-key', journalOperation);
  assert.equal(proven?.ok, true);
  assert.equal(proven?.inflowId, 'in1');
  assert.equal(manager.proveTerminalJournalCompletion('proof-key', {
    ...journalOperation,
    fingerprint: 'd'.repeat(64),
  }), null);
  assert.equal(manager.proveTerminalJournalCompletion('proof-key', {
    ...journalOperation,
    method: 'DELETE',
  }), null);
  assert.equal(manager.proveTerminalJournalCompletion('corrupt-key', journalOperation), null);
  assert.equal(manager.proveTerminalJournalCompletion('incomplete-key', journalOperation), null);
  assert.equal(manager.proveTerminalJournalCompletion('proof-key', null), null);
});

test('repayment confirmation terminal proof rejects sync_pending and corrupt terminal records', () => {
  const dir = tempDir('darkfinances-repay-proof-');
  const sagaPath = path.join(dir, 'repayment-confirmation-sagas.json');
  const binding = repaymentBinding();
  writeJson(sagaPath, {
    schemaVersion: 1,
    sagas: {
      bound: {
        id: 'bound',
        recordVersion: 1,
        operationIdentity: 'proof-key',
        operationJournalFingerprint: binding.fingerprint,
        operationJournalFingerprintVersion: 2,
        operationJournalMethod: 'POST',
        operationJournalRoute: '/api/v1/repayments/sg_inflow/confirm',
        phase: 'completed',
        status: 'completed',
        terminalAt: '2026-07-10T00:00:00.000Z',
        updatedAt: '2026-07-10T00:00:00.000Z',
        suggestionId: 'sg_inflow',
        inflow: { id: 'inflow' },
        allocations: [{ expenseId: 'exp1' }],
        auditOutcome: { outcome: 'confirmed' },
      },
      pending: {
        id: 'pending',
        recordVersion: 1,
        operationIdentity: 'pending-key',
        operationJournalFingerprint: binding.fingerprint,
        operationJournalFingerprintVersion: 2,
        operationJournalMethod: 'POST',
        operationJournalRoute: '/api/v1/repayments/sg_inflow/confirm',
        phase: 'sync_pending',
        status: 'started',
        updatedAt: '2026-07-10T00:00:00.000Z',
        suggestionId: 'sg_inflow',
        inflow: { id: 'inflow' },
        allocations: [],
      },
    },
  });
  const manager = createTestRepaySaga({ sagaPath });
  const journalOperation = {
    fingerprint: binding.fingerprint,
    fingerprintVersion: 2,
    method: 'POST',
    route: '/api/v1/repayments/sg_inflow/confirm',
  };
  const proven = manager.proveTerminalJournalCompletion('proof-key', journalOperation);
  assert.equal(proven?.ok, true);
  assert.equal(proven?.inflowId, 'inflow');
  assert.equal(manager.proveTerminalJournalCompletion('pending-key', journalOperation), null);
  assert.equal(manager.proveTerminalJournalCompletion('proof-key', {
    ...journalOperation,
    route: '/api/v1/repayments/other/confirm',
  }), null);
});

test('composed terminal proof resolver prefers first strictly bound match and never fabricates success', async () => {
  const bulkResult = { ok: true, status: 'completed', applied: 1 };
  const reimbResult = { ok: true, inflowId: 'in1', expenseId: 'ex1', version: 1 };
  const repaymentResult = { ok: true, categorized: true, linked: 1, inflowId: 'inflow' };
  const operation = {
    fingerprint: 'f'.repeat(64),
    fingerprintVersion: 2,
    method: 'POST',
    route: '/api/v1/reimb-links',
  };
  const resolver = terminalProofResolverFrom({
    bulk: async (key) => (key === 'bulk-key' ? bulkResult : null),
    reimb: async (key, journalOperation) => (
      key === 'reimb-key' && journalOperation.fingerprint === operation.fingerprint ? reimbResult : null
    ),
    repay: async (key) => (key === 'repay-key' ? repaymentResult : null),
  });
  const bulkProof = await resolver({
    key: 'bulk-key',
    operation,
  });
  assert.deepEqual(bulkProof?.result, bulkResult);
  const reimbProof = await resolver({
    key: 'reimb-key',
    operation,
  });
  assert.deepEqual(reimbProof?.result, reimbResult);
  assert.equal(await resolver({ key: 'missing-key', operation }), null);
  assert.equal(await resolver({
    key: 'reimb-key',
    operation: { ...operation, fingerprint: 'x'.repeat(64) },
  }), null);
});

test('crash after terminal reimbursement link saga reconciles orphan journal without re-executing handler', async (t) => {
  const dir = tempDir('darkfinances-reimb-orphan-');
  const journalFile = path.join(dir, 'journal.json');
  const sagaPath = path.join(dir, 'reimb-link-sagas.json');
  const linksPath = path.join(dir, 'links.json');
  writeJson(linksPath, { schemaVersion: 2, links: [{ inflow: { id: 'in1' }, expense: { id: 'ex1' }, allocationCents: 1000, version: 1 }] });
  const key = 'reimb-link-crash-key';
  const req = journalRequest();
  const journal = new OperationJournal(journalFile);
  journal.start(key, req);
  const record = journal.get(key);
  const binding = journalProofFromOperation(record);
  writeJson(sagaPath, {
    schemaVersion: 1,
    sagas: {
      [key]: {
        id: key,
        recordVersion: 1,
        action: 'link',
        operationIdentity: key,
        operationJournalFingerprint: binding.fingerprint,
        operationJournalFingerprintVersion: binding.fingerprintVersion,
        operationJournalMethod: binding.method,
        operationJournalRoute: binding.route,
        phase: 'completed',
        status: 'completed',
        terminalAt: '2026-07-10T00:00:00.000Z',
        updatedAt: '2026-07-10T00:00:00.000Z',
        inflowId: 'in1',
        expenseId: 'ex1',
        allocationCents: 1000,
        linkKey: 'in1:ex1',
        resultVersion: 1,
      },
    },
  });
  const manager = createTestLinkSaga({ sagaPath, linksPath });
  const resolver = composeTerminalProofResolver([
    (operationKey, journalOperation) => manager.proveTerminalJournalCompletion(operationKey, journalOperation),
  ]);
  let calls = 0;
  const replay = await executeJournaledOperation({
    journal,
    key,
    request: req,
    terminalProofResolver: resolver,
    handler: async () => { calls += 1; return { shouldNotRun: true }; },
  });
  assert.equal(calls, 0);
  assert.equal(replay.operation.reconciled, true);
  assert.equal(replay.result.ok, true);
  assert.equal(journal.get(key).phase, 'completed');
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
});

test('crash after terminal unlink saga reconciles journal on GET status poll', async (t) => {
  const dir = tempDir('darkfinances-unlink-orphan-');
  const journalFile = path.join(dir, 'journal.json');
  const sagaPath = path.join(dir, 'reimb-link-sagas.json');
  const linksPath = path.join(dir, 'links.json');
  writeJson(linksPath, { schemaVersion: 2, links: [] });
  const key = 'reimb-unlink-crash-key';
  const req = journalRequest({
    method: 'DELETE',
    path: '/api/v1/reimb-links',
    url: '/api/v1/reimb-links?inflowId=in1&expenseId=ex1',
    body: { inflowId: 'in1', expenseId: 'ex1' },
  });
  const journal = new OperationJournal(journalFile);
  journal.start(key, req);
  const record = journal.get(key);
  const binding = journalProofFromOperation(record);
  writeJson(sagaPath, {
    schemaVersion: 1,
    sagas: {
      [key]: {
        id: key,
        recordVersion: 1,
        action: 'unlink',
        operationIdentity: key,
        operationJournalFingerprint: binding.fingerprint,
        operationJournalFingerprintVersion: binding.fingerprintVersion,
        operationJournalMethod: binding.method,
        operationJournalRoute: binding.route,
        phase: 'completed',
        status: 'completed',
        terminalAt: '2026-07-10T00:00:00.000Z',
        updatedAt: '2026-07-10T00:00:00.000Z',
        inflowId: 'in1',
        expenseId: 'ex1',
        removed: 1,
      },
    },
  });
  const manager = createTestLinkSaga({ sagaPath, linksPath });
  const resolver = composeTerminalProofResolver([
    (operationKey, journalOperation) => manager.proveTerminalJournalCompletion(operationKey, journalOperation),
  ]);
  const status = await reconcileOperationJournalFromProof(journal, key, { proofResolver: resolver });
  assert.equal(status.phase, 'completed');
  assert.equal(status.result.removed, 1);
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
});

test('crash after terminal repayment saga reconciles orphan journal before localApplied', async (t) => {
  const dir = tempDir('darkfinances-repay-orphan-');
  const journalFile = path.join(dir, 'journal.json');
  const sagaPath = path.join(dir, 'repayment-confirmation-sagas.json');
  const key = 'repay-crash-key';
  const req = journalRequest({
    method: 'POST',
    path: '/api/v1/repayments/sg_inflow/confirm',
    url: '/api/v1/repayments/sg_inflow/confirm',
    body: {},
  });
  const journal = new OperationJournal(journalFile);
  journal.start(key, req);
  const record = journal.get(key);
  const binding = journalProofFromOperation(record);
  writeJson(sagaPath, {
    schemaVersion: 1,
    sagas: {
      [key]: {
        id: key,
        recordVersion: 1,
        operationIdentity: key,
        operationJournalFingerprint: binding.fingerprint,
        operationJournalFingerprintVersion: binding.fingerprintVersion,
        operationJournalMethod: binding.method,
        operationJournalRoute: binding.route,
        phase: 'completed',
        status: 'completed',
        terminalAt: '2026-07-10T00:00:00.000Z',
        updatedAt: '2026-07-10T00:00:00.000Z',
        suggestionId: 'sg_inflow',
        inflow: { id: 'inflow' },
        allocations: [{ expenseId: 'exp1' }],
        auditOutcome: { outcome: 'confirmed' },
      },
    },
  });
  const manager = createTestRepaySaga({ sagaPath });
  const resolver = composeTerminalProofResolver([
    (operationKey, journalOperation) => manager.proveTerminalJournalCompletion(operationKey, journalOperation),
  ]);
  let calls = 0;
  const replay = await executeJournaledOperation({
    journal,
    key,
    request: req,
    terminalProofResolver: resolver,
    handler: async () => { calls += 1; return { shouldNotRun: true }; },
  });
  assert.equal(calls, 0);
  assert.equal(replay.operation.reconciled, true);
  assert.equal(replay.result.inflowId, 'inflow');
  assert.equal(journal.get(key).phase, 'completed');
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
});

test('deterministic crash at saga-terminal-write before localApplied for add link converges on retry', async (t) => {
  const dir = tempDir('darkfinances-reimb-fault-');
  const sagaPath = path.join(dir, 'reimb-link-sagas.json');
  const linksPath = path.join(dir, 'links.json');
  writeJson(linksPath, { schemaVersion: 2, links: [] });
  const manager = createTestLinkSaga({ sagaPath, linksPath });
  const api = {
    async getAccounts() { return [{ id: 'checking', name: 'checking', closed: false }]; },
    async getTransactions() {
      return [
        { id: 'in1', date: '2026-07-01', amount: 10000, category: 'cat-income' },
        { id: 'ex1', date: '2026-07-02', amount: -10000, category: 'reimb-cat' },
      ];
    },
  };
  const admission = {
    inflowLive: {
      id: 'in1', date: '2026-07-01', amountCents: 10000, category: 'cat-income', accountId: 'checking',
    },
    expenseLive: {
      id: 'ex1', date: '2026-07-02', amountCents: -10000, category: 'reimb-cat', accountId: 'checking',
    },
    allocationCents: 2000,
    person: null,
    expectedVersion: null,
    allowSamePairResolution: false,
  };
  const binding = linkBinding();
  const faultInjector = async (point) => {
    if (point === 'after:saga-terminal-write') throw new Error('crash before localApplied');
  };
  await assert.rejects(
    () => manager.link(api, admission, {
      operationIdentity: 'fault-link-key',
      journalBinding: binding,
      faultInjector,
    }),
    /crash before localApplied/,
  );
  const state = readJson(sagaPath);
  assert.equal(state.sagas['fault-link-key'].phase, 'completed');
  const proof = manager.proveTerminalJournalCompletion('fault-link-key', binding);
  assert.equal(proof?.ok, true);
  assert.equal(readJson(linksPath).links.length, 1);
  const replay = await manager.link(api, admission, {
    operationIdentity: 'fault-link-key',
    journalBinding: binding,
  });
  assert.equal(replay.idempotent, true);
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
});

test('reimbursement link saga store prunes terminal records to bounded 100 while preserving active sagas', async () => {
  const dir = tempDir('darkfinances-reimb-prune-');
  const sagaPath = path.join(dir, 'reimb-link-sagas.json');
  const linksPath = path.join(dir, 'links.json');
  writeJson(linksPath, { schemaVersion: 2, links: [] });
  const sagas = {};
  for (let index = 0; index < 120; index += 1) {
    const stamp = String(index).padStart(3, '0');
    sagas[`terminal-${stamp}`] = {
      id: `terminal-${stamp}`,
      recordVersion: 1,
      action: 'link',
      phase: 'completed',
      status: 'completed',
      terminalAt: `2026-07-10T00:00:${stamp}.000Z`,
      updatedAt: `2026-07-10T00:00:${stamp}.000Z`,
      inflowId: 'in1',
      expenseId: `ex-${stamp}`,
      resultVersion: 1,
    };
  }
  writeJson(sagaPath, { schemaVersion: 1, sagas });
  const manager = createTestLinkSaga({ sagaPath, linksPath, terminalLimit: 100 });
  const api = {
    async getAccounts() { return [{ id: 'checking', name: 'checking', closed: false }]; },
    async getTransactions() {
      return [
        { id: 'in2', date: '2026-07-01', amount: 10000, category: 'cat-income' },
        { id: 'ex-new', date: '2026-07-02', amount: -10000, category: 'reimb-cat' },
      ];
    },
  };
  const admission = {
    inflowLive: {
      id: 'in2', date: '2026-07-01', amountCents: 10000, category: 'cat-income', accountId: 'checking',
    },
    expenseLive: {
      id: 'ex-new', date: '2026-07-02', amountCents: -10000, category: 'reimb-cat', accountId: 'checking',
    },
    allocationCents: 1000,
    person: null,
    expectedVersion: null,
    allowSamePairResolution: false,
  };
  await manager.link(api, admission, {
    operationIdentity: 'prune-trigger',
    journalBinding: linkBinding({ fingerprint: 'p'.repeat(64) }),
  });
  const state = readJson(sagaPath);
  assert.equal(Object.keys(state.sagas).length, 100);
  assert.ok(state.sagas['prune-trigger']);
  assert.ok(!state.sagas['terminal-000']);
  assert.ok(state.sagas['terminal-119']);
});

test('reimbursement link journal admission rejects fingerprint mismatch on same key', () => {
  const dir = tempDir('darkfinances-reimb-admission-');
  const sagaPath = path.join(dir, 'reimb-link-sagas.json');
  const linksPath = path.join(dir, 'links.json');
  writeJson(linksPath, { schemaVersion: 2, links: [] });
  const bindingA = linkBinding({ fingerprint: 'e'.repeat(64) });
  const bindingB = linkBinding({ fingerprint: 'f'.repeat(64) });
  writeJson(sagaPath, {
    schemaVersion: 1,
    sagas: {
      same: {
        id: 'same',
        recordVersion: 1,
        action: 'link',
        operationIdentity: 'same-key',
        operationJournalFingerprint: bindingA.fingerprint,
        operationJournalFingerprintVersion: 2,
        operationJournalMethod: 'POST',
        operationJournalRoute: '/api/v1/reimb-links',
        phase: 'prepared',
        status: 'started',
        updatedAt: '2026-07-10T00:00:00.000Z',
        inflowId: 'in1',
        expenseId: 'ex1',
      },
    },
  });
  const manager = createTestLinkSaga({ sagaPath, linksPath });
  assert.throws(
    () => manager.assertJournalAdmission({
      operationKey: 'same-key',
      journalBinding: bindingB,
      action: 'link',
    }),
    (error) => error.code === 'IDEMPOTENCY_KEY_REUSED',
  );
});

test('terminal reimbursement link admission validates bound fingerprint and action before replay', () => {
  const dir = tempDir('darkfinances-reimb-terminal-admission-');
  const sagaPath = path.join(dir, 'reimb-link-sagas.json');
  const linksPath = path.join(dir, 'links.json');
  writeJson(linksPath, { schemaVersion: 2, links: [] });
  const binding = linkBinding({ fingerprint: 't'.repeat(64) });
  writeJson(sagaPath, {
    schemaVersion: 1,
    sagas: {
      done: {
        id: 'done',
        recordVersion: 1,
        action: 'link',
        operationIdentity: 'terminal-key',
        operationJournalFingerprint: binding.fingerprint,
        operationJournalFingerprintVersion: 2,
        operationJournalMethod: 'POST',
        operationJournalRoute: '/api/v1/reimb-links',
        phase: 'completed',
        status: 'completed',
        terminalAt: '2026-07-10T00:00:00.000Z',
        updatedAt: '2026-07-10T00:00:00.000Z',
        inflowId: 'in1',
        expenseId: 'ex1',
        resultVersion: 1,
      },
    },
  });
  const manager = createTestLinkSaga({ sagaPath, linksPath });
  assert.doesNotThrow(() => manager.assertJournalAdmission({
    operationKey: 'terminal-key',
    journalBinding: binding,
    action: 'link',
  }));
  assert.throws(
    () => manager.assertJournalAdmission({
      operationKey: 'terminal-key',
      journalBinding: linkBinding({ fingerprint: 'u'.repeat(64) }),
      action: 'link',
    }),
    (error) => error.code === 'IDEMPOTENCY_KEY_REUSED',
  );
  assert.throws(
    () => manager.assertJournalAdmission({
      operationKey: 'terminal-key',
      journalBinding: binding,
      action: 'unlink',
    }),
    (error) => error.code === 'IDEMPOTENCY_KEY_REUSED',
  );
});

test('duplicate terminal reimbursement link records fail closed without choosing a winner', async (t) => {
  const dir = tempDir('darkfinances-reimb-dup-terminal-');
  const journalFile = path.join(dir, 'journal.json');
  const sagaPath = path.join(dir, 'reimb-link-sagas.json');
  const linksPath = path.join(dir, 'links.json');
  writeJson(linksPath, { schemaVersion: 2, links: [] });
  const key = 'dup-terminal-key';
  const req = journalRequest();
  const journal = new OperationJournal(journalFile);
  journal.start(key, req);
  const record = journal.get(key);
  const binding = journalProofFromOperation(record);
  writeJson(sagaPath, {
    schemaVersion: 1,
    sagas: {
      first: {
        id: 'first',
        recordVersion: 1,
        action: 'link',
        operationIdentity: key,
        operationJournalFingerprint: binding.fingerprint,
        operationJournalFingerprintVersion: binding.fingerprintVersion,
        operationJournalMethod: binding.method,
        operationJournalRoute: binding.route,
        phase: 'completed',
        status: 'completed',
        terminalAt: '2026-07-10T00:00:00.000Z',
        updatedAt: '2026-07-10T00:00:00.000Z',
        inflowId: 'in1',
        expenseId: 'ex1',
        allocationCents: 1000,
        linkKey: 'in1:ex1',
        resultVersion: 1,
      },
      second: {
        id: 'second',
        recordVersion: 1,
        action: 'link',
        operationIdentity: key,
        operationJournalFingerprint: binding.fingerprint,
        operationJournalFingerprintVersion: binding.fingerprintVersion,
        operationJournalMethod: binding.method,
        operationJournalRoute: binding.route,
        phase: 'completed',
        status: 'completed',
        terminalAt: '2026-07-10T00:00:01.000Z',
        updatedAt: '2026-07-10T00:00:01.000Z',
        inflowId: 'in2',
        expenseId: 'ex2',
        allocationCents: 2000,
        linkKey: 'in2:ex2',
        resultVersion: 1,
      },
    },
  });
  const manager = createTestLinkSaga({ sagaPath, linksPath });
  assert.throws(
    () => manager.assertJournalAdmission({
      operationKey: key,
      journalBinding: binding,
      action: 'link',
    }),
    (error) => error.code === 'IDEMPOTENCY_KEY_REUSED',
  );
  assert.equal(manager.proveTerminalJournalCompletion(key, binding), null);
  const resolver = composeTerminalProofResolver([
    (operationKey, journalOperation) => manager.proveTerminalJournalCompletion(operationKey, journalOperation),
  ]);
  let calls = 0;
  await assert.rejects(
    () => executeJournaledOperation({
      journal,
      key,
      request: req,
      terminalProofResolver: resolver,
      handler: async () => { calls += 1; return { shouldNotRun: true }; },
    }),
    (error) => error.code === 'OUTCOME_UNKNOWN',
  );
  assert.equal(calls, 0);
  assert.equal(journal.get(key).phase, 'started');
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
});

test('bulk proof still wins in composed resolver when both bulk and reimbursement sagas exist', async () => {
  const dir = tempDir('darkfinances-compose-bulk-');
  const bulkSagaPath = path.join(dir, 'bulk-sagas.json');
  const reimbSagaPath = path.join(dir, 'reimb-sagas.json');
  const linksPath = path.join(dir, 'links.json');
  writeJson(linksPath, { schemaVersion: 2, links: [] });
  writeJson(path.join(dir, 'rules.json'), { rules: [] });
  writeJson(path.join(dir, 'phantom-seen.json'), { seen: {} });
  writeJson(path.join(dir, 'phantom-log.json'), { deleted: [] });
  const binding = {
    fingerprint: 'g'.repeat(64),
    fingerprintVersion: 2,
    method: 'POST',
    route: '/api/v1/rules/apply',
  };
  writeJson(bulkSagaPath, {
    schemaVersion: 1,
    sagas: {
      bulk1: {
        id: 'bulk1',
        recordVersion: 1,
        kind: 'rules_apply',
        operationKey: 'shared-key',
        operationJournalFingerprint: binding.fingerprint,
        operationJournalFingerprintVersion: 2,
        operationJournalMethod: 'POST',
        operationJournalRoute: '/api/v1/rules/apply',
        phase: 'completed',
        terminalAt: '2026-07-10T00:00:00.000Z',
        updatedAt: '2026-07-10T00:00:00.000Z',
        plan: { items: [] },
        itemOutcomes: {},
        auditOutcome: { status: 'completed', applied: 0, failed: 0, skipped: 0, failedItems: [] },
        createdAt: '2026-07-10T00:00:00.000Z',
      },
    },
  });
  writeJson(reimbSagaPath, {
    schemaVersion: 1,
    sagas: {
      reimb1: {
        id: 'reimb1',
        recordVersion: 1,
        action: 'link',
        operationIdentity: 'shared-key',
        operationJournalFingerprint: binding.fingerprint,
        operationJournalFingerprintVersion: 2,
        operationJournalMethod: 'POST',
        operationJournalRoute: '/api/v1/reimb-links',
        phase: 'completed',
        terminalAt: '2026-07-10T00:00:00.000Z',
        updatedAt: '2026-07-10T00:00:00.000Z',
        inflowId: 'in1',
        expenseId: 'ex1',
        resultVersion: 1,
      },
    },
  });
  const bulkManager = createBulkOperationSaga({
    sagaPath: bulkSagaPath,
    readRules: () => readJson(path.join(dir, 'rules.json')),
    writeRules: () => {},
    readPhantomSeen: () => readJson(path.join(dir, 'phantom-seen.json')),
    writePhantomSeen: () => {},
    readPhantomLog: () => readJson(path.join(dir, 'phantom-log.json')),
    writePhantomLog: () => {},
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
  });
  const reimbManager = createTestLinkSaga({ sagaPath: reimbSagaPath, linksPath });
  const resolver = composeTerminalProofResolver([
    (key, journalOperation) => bulkManager.proveTerminalJournalCompletion(key, journalOperation),
    (key, journalOperation) => reimbManager.proveTerminalJournalCompletion(key, journalOperation),
  ]);
  const proof = await resolver({
    key: 'shared-key',
    operation: {
      fingerprint: binding.fingerprint,
      fingerprintVersion: 2,
      method: 'POST',
      route: '/api/v1/rules/apply',
    },
  });
  assert.equal(proof?.result?.status, 'completed');
  assert.equal(proof?.result?.applied, 0);
});
