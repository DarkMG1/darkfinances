const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const os = require('os');
const path = require('path');
const {
  MAX_NONTERMINAL_ENTRIES,
  MAX_TERMINAL_ENTRIES,
  OperationJournal,
  OperationJournalCapacityError,
  legacyRequestFingerprint,
  requestFingerprint,
} = require('../lib/operation-journal');
const { executeJournaledOperation } = require('../lib/operation-executor');

function fixture(t, options) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'darkfinances-operations-'));
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
  return new OperationJournal(path.join(dir, 'operations.json'), options);
}

function request(overrides = {}) {
  return {
    method: 'POST',
    path: '/api/v1/transactions',
    url: '/api/v1/transactions',
    body: { amount: 12.34 },
    ...overrides,
  };
}

function legacyRecord(key, req, status, extra = {}) {
  return {
    key,
    fingerprint: legacyRequestFingerprint(req.method, req.path, req.body),
    method: req.method,
    route: req.path,
    status,
    startedAt: '2025-01-01T00:00:00.000Z',
    ...extra,
  };
}

function versionedRecord(key, phase, timestamp, extra = {}) {
  const status = phase === 'completed' ? 'completed' : phase === 'failed' ? 'failed' : 'started';
  return {
    key,
    recordVersion: 2,
    fingerprint: 'a'.repeat(64),
    fingerprintVersion: 2,
    method: 'POST',
    route: '/api/v1/test',
    status,
    phase,
    startedAt: timestamp,
    updatedAt: timestamp,
    ...(['local_applied', 'sync_unknown', 'completed'].includes(phase)
      ? { provisionalResult: null, localAppliedAt: timestamp }
      : {}),
    ...(phase === 'sync_unknown' ? { syncStartedAt: timestamp } : {}),
    ...(phase === 'failed'
      ? { knownBeforeApply: true, error: { code: 'INVALID_REQUEST', message: 'invalid', status: 400 } }
      : {}),
    ...extra,
  };
}

test('completed operations replay one durable result', (t) => {
  const journal = fixture(t);
  const req = request();
  assert.equal(journal.start('test-operation-0001', req).existing, null);
  journal.localApplied('test-operation-0001', { id: 'txn-1' });
  journal.complete('test-operation-0001', { id: 'txn-1' });

  const replay = journal.start('test-operation-0001', req).existing;
  assert.equal(replay.status, 'completed');
  assert.equal(replay.phase, 'completed');
  assert.deepEqual(replay.result, { id: 'txn-1' });
});

test('fingerprint v2 canonicalizes top-level and nested object key order', () => {
  const first = request({
    body: { z: 1, nested: { beta: 2, alpha: 1 }, a: true },
  });
  const second = request({
    body: { a: true, nested: { alpha: 1, beta: 2 }, z: 1 },
  });
  assert.equal(requestFingerprint(first), requestFingerprint(second));
});

test('fingerprint v2 preserves array order', () => {
  assert.notEqual(
    requestFingerprint(request({ body: { values: [1, 2, 3] } })),
    requestFingerprint(request({ body: { values: [3, 2, 1] } })),
  );
});

test('fingerprint v2 normalizes query order and preserves repeated values', () => {
  const first = request({ url: '/api/v1/transactions?b=2&a=1&tag=z&tag=a' });
  const reordered = request({ url: '/api/v1/transactions?tag=z&a=1&tag=a&b=2' });
  const reversedRepeats = request({ url: '/api/v1/transactions?b=2&a=1&tag=a&tag=z' });
  const changedValue = request({ url: '/api/v1/transactions?b=3&a=1&tag=z&tag=a' });
  const missingRepeat = request({ url: '/api/v1/transactions?b=2&a=1&tag=a' });
  assert.equal(requestFingerprint(first), requestFingerprint(reordered));
  assert.notEqual(requestFingerprint(first), requestFingerprint(reversedRepeats));
  assert.notEqual(requestFingerprint(first), requestFingerprint(changedValue));
  assert.notEqual(requestFingerprint(first), requestFingerprint(missingRepeat));
});

test('fingerprint v2 distinguishes path, body, and query but uppercases methods', () => {
  const base = request({ url: '/api/v1/transactions?a=1#ignored' });
  assert.equal(
    requestFingerprint(base),
    requestFingerprint({ ...base, method: 'post', url: '/api/v1/transactions?a=1' }),
  );
  assert.notEqual(requestFingerprint(base), requestFingerprint({ ...base, method: 'DELETE' }));
  assert.notEqual(requestFingerprint(base), requestFingerprint({ ...base, path: '/api/v1/budgets' }));
  assert.notEqual(requestFingerprint(base), requestFingerprint({ ...base, body: { amount: 12.35 } }));
  assert.notEqual(requestFingerprint(base), requestFingerprint({ ...base, url: '/api/v1/transactions?a=2' }));
});

test('fingerprint v2 preserves canonical JSON string and Unicode values exactly', () => {
  const composed = request({ body: { emoji: '💰', label: 'café', escaped: 'line\nbreak' } });
  const same = request({ body: { escaped: 'line\nbreak', label: 'café', emoji: '💰' } });
  const decomposed = request({ body: { emoji: '💰', label: 'cafe\u0301', escaped: 'line\nbreak' } });
  assert.equal(requestFingerprint(composed), requestFingerprint(same));
  assert.notEqual(requestFingerprint(composed), requestFingerprint(decomposed));
});

test('new records store only a versioned hash, not raw request bodies', (t) => {
  const journal = fixture(t);
  const secret = 'do-not-store-this-body';
  journal.start('test-operation-0002', request({ body: { secret } }));
  const raw = fs.readFileSync(journal.file, 'utf8');
  const operation = journal.get('test-operation-0002');
  assert.equal(raw.includes(secret), false);
  assert.equal(operation.recordVersion, 2);
  assert.equal(operation.fingerprintVersion, 2);
  assert.match(operation.fingerprint, /^[a-f0-9]{64}$/);
});

test('prototype-named keys and JSON properties are fingerprinted and journaled safely', (t) => {
  const journal = fixture(t);
  const withPrototypeProperty = JSON.parse('{"__proto__":{"allowed":true},"value":1}');
  const changedPrototypeProperty = JSON.parse('{"__proto__":{"allowed":false},"value":1}');
  assert.notEqual(
    requestFingerprint(request({ body: withPrototypeProperty })),
    requestFingerprint(request({ body: changedPrototypeProperty })),
  );

  assert.equal(journal.start('__proto__', request({ body: withPrototypeProperty })).existing, null);
  assert.equal(journal.get('__proto__').phase, 'started');
  journal.localApplied('__proto__', { ok: true });
  journal.complete('__proto__', { ok: true });
  assert.equal(journal.start('__proto__', request({ body: withPrototypeProperty })).existing.status, 'completed');
});

test('same-key conflicts include query, method, path, and body differences', (t) => {
  const variants = [
    request({ url: '/api/v1/transactions?a=2' }),
    request({ method: 'DELETE' }),
    request({ path: '/api/v1/budgets', url: '/api/v1/budgets?a=1' }),
    request({ body: { amount: 99 } }),
  ];
  for (const [index, different] of variants.entries()) {
    const journal = fixture(t);
    const key = `test-conflict-${String(index).padStart(4, '0')}`;
    journal.start(key, request({ url: '/api/v1/transactions?a=1' }));
    assert.throws(
      () => journal.start(key, different),
      (error) => error.code === 'IDEMPOTENCY_KEY_REUSED',
    );
  }
});

test('started, local_applied, and sync_unknown survive restart with provisional result', (t) => {
  const journal = fixture(t);
  const req = request({ method: 'DELETE', body: null });
  journal.start('test-operation-0003', req);
  journal.localApplied('test-operation-0003', { deleted: 'txn-1' });

  let restarted = new OperationJournal(journal.file);
  assert.equal(restarted.get('test-operation-0003').phase, 'local_applied');
  assert.deepEqual(restarted.get('test-operation-0003').provisionalResult, { deleted: 'txn-1' });
  restarted.syncUnknown('test-operation-0003');

  restarted = new OperationJournal(journal.file);
  assert.equal(restarted.get('test-operation-0003').status, 'started');
  assert.equal(restarted.get('test-operation-0003').phase, 'sync_unknown');
  assert.deepEqual(restarted.status('test-operation-0003').provisionalResult, { deleted: 'txn-1' });
});

test('nonterminal capacity counts every unresolved phase and rejects a new key without writing', (t) => {
  const journal = fixture(t, { maxNonterminalEntries: 3 });
  const req = request();
  journal.start('capacity-started-01', req);
  journal.start('capacity-applied-01', req);
  journal.localApplied('capacity-applied-01', { id: 'applied' });
  journal.start('capacity-sync-0001', req);
  journal.localApplied('capacity-sync-0001', { id: 'syncing' });
  journal.syncUnknown('capacity-sync-0001');
  const before = fs.readFileSync(journal.file, 'utf8');

  assert.throws(
    () => journal.start('capacity-rejected-1', req),
    (error) => {
      assert.ok(error instanceof OperationJournalCapacityError);
      assert.equal(error.code, 'OPERATION_JOURNAL_CAPACITY_EXCEEDED');
      assert.equal(error.status, 503);
      assert.equal(error.expose, true);
      assert.equal(error.capacity, 3);
      assert.equal(error.nonterminalCount, 3);
      return true;
    },
  );
  assert.equal(journal.get('capacity-rejected-1'), null);
  assert.equal(fs.readFileSync(journal.file, 'utf8'), before);
});

test('nonterminal capacity survives restart while existing keys remain replayable and recoverable', (t) => {
  const journal = fixture(t, { maxNonterminalEntries: 2 });
  const req = request();
  journal.start('capacity-recover-01', req);
  journal.localApplied('capacity-recover-01', { state: 'locally-applied' });
  journal.start('capacity-existing-1', req);

  const restarted = new OperationJournal(journal.file, { maxNonterminalEntries: 2 });
  assert.equal(restarted.status('capacity-existing-1').phase, 'started');
  assert.equal(restarted.start('capacity-existing-1', req).existing.phase, 'started');
  assert.throws(
    () => restarted.start('capacity-restart-new', req),
    (error) => error instanceof OperationJournalCapacityError,
  );

  restarted.syncUnknown('capacity-recover-01');
  restarted.complete('capacity-recover-01', { state: 'completed' });
  const replay = restarted.start('capacity-recover-01', req).existing;
  assert.equal(replay.phase, 'completed');
  assert.deepEqual(replay.result, { state: 'completed' });
  assert.equal(restarted.start('capacity-after-recovery', req).existing, null);
});

test('capacity rejection occurs before executor handler invocation or effect boundary', async (t) => {
  const journal = fixture(t, { maxNonterminalEntries: 1 });
  journal.start('capacity-held-0001', request());
  const before = fs.readFileSync(journal.file, 'utf8');
  let handlerRuns = 0;

  await assert.rejects(
    () => executeJournaledOperation({
      journal,
      key: 'capacity-zero-effect',
      request: request(),
      handler: async (operation) => {
        handlerRuns += 1;
        operation.effectsMayExist();
        return { ok: true };
      },
    }),
    (error) => error instanceof OperationJournalCapacityError
      && error.code === 'OPERATION_JOURNAL_CAPACITY_EXCEEDED'
      && error.status === 503,
  );
  assert.equal(handlerRuns, 0);
  assert.equal(journal.get('capacity-zero-effect'), null);
  assert.equal(fs.readFileSync(journal.file, 'utf8'), before);
});

test('legal transitions are forward-only and equivalent repeats are idempotent', (t) => {
  const journal = fixture(t);
  journal.start('test-operation-0004', request());
  journal.localApplied('test-operation-0004', { id: 'one', nested: { b: 2, a: 1 } });
  journal.localApplied('test-operation-0004', { nested: { a: 1, b: 2 }, id: 'one' });
  journal.syncUnknown('test-operation-0004');
  journal.syncUnknown('test-operation-0004');
  journal.complete('test-operation-0004', { ok: true });
  journal.complete('test-operation-0004', { ok: true });

  assert.throws(
    () => journal.localApplied('test-operation-0004', { id: 'two' }),
    (error) => error.code === 'OPERATION_TRANSITION_INVALID',
  );
  assert.throws(
    () => journal.complete('test-operation-0004', { ok: false }),
    (error) => error.code === 'OPERATION_TRANSITION_CONFLICT',
  );
});

test('failed is legal only from started and stores bounded sanitized errors', (t) => {
  const journal = fixture(t);
  journal.start('test-operation-0005', request());
  journal.failBeforeApply('test-operation-0005', {
    code: `invalid request ${'x'.repeat(100)}`,
    message: `bad\u0000\n\trequest ${'m'.repeat(300)}`,
    status: 422,
  });
  const failed = journal.get('test-operation-0005');
  assert.equal(failed.status, 'failed');
  assert.equal(failed.phase, 'failed');
  assert.equal(failed.knownBeforeApply, true);
  assert.ok(failed.error.code.length <= 64);
  assert.match(failed.error.code, /^[A-Z0-9_:-]+$/);
  assert.ok(failed.error.message.length <= 240);
  assert.equal(
    [...failed.error.message].some((character) => character.codePointAt(0) <= 0x1f),
    false,
  );
  assert.equal(failed.error.status, 422);
  journal.failBeforeApply('test-operation-0005', failed.error);
  assert.throws(
    () => journal.localApplied('test-operation-0005', { ok: true }),
    (error) => error.code === 'OPERATION_TRANSITION_INVALID',
  );
});

test('an applied operation can never transition to failed', (t) => {
  const journal = fixture(t);
  journal.start('test-operation-0006', request());
  journal.localApplied('test-operation-0006', { ok: true });
  assert.throws(
    () => journal.failBeforeApply('test-operation-0006', new Error('too late')),
    (error) => error.code === 'OPERATION_TRANSITION_INVALID',
  );
  assert.equal(journal.get('test-operation-0006').phase, 'local_applied');
});

test('started cannot complete without a durable local checkpoint', (t) => {
  const journal = fixture(t);
  journal.start('test-operation-0007', request());
  assert.throws(
    () => journal.complete('test-operation-0007', { ok: true }),
    (error) => error.code === 'OPERATION_TRANSITION_INVALID',
  );
  assert.equal(journal.get('test-operation-0007').phase, 'started');
});

test('legacy v1 completed records remain replayable', (t) => {
  const journal = fixture(t);
  const req = request({ method: 'POST', path: '/api/v1/legacy', url: '/api/v1/legacy?old=1', body: { z: 1, a: 2 } });
  fs.writeFileSync(journal.file, JSON.stringify({
    schemaVersion: 1,
    operations: {
      'legacy-completed': legacyRecord('legacy-completed', req, 'completed', {
        completedAt: '2025-01-01T00:01:00.000Z',
        result: { id: 'legacy-result' },
      }),
    },
  }));
  const replay = journal.start('legacy-completed', { ...req, url: '/api/v1/legacy?different=2' }).existing;
  assert.equal(replay.status, 'completed');
  assert.deepEqual(replay.result, { id: 'legacy-result' });
  assert.equal(journal.status('legacy-completed').phase, 'completed');
});

test('legacy started and failed records remain unresolved and query-insensitive', (t) => {
  const journal = fixture(t);
  const req = request({ method: 'DELETE', path: '/api/v1/legacy', body: null });
  fs.writeFileSync(journal.file, JSON.stringify({
    schemaVersion: 1,
    operations: {
      'legacy-started-1': legacyRecord('legacy-started-1', req, 'started'),
      'legacy-failed-01': legacyRecord('legacy-failed-01', req, 'failed', {
        completedAt: '2025-01-01T00:01:00.000Z',
        error: { code: 'INTERNAL_ERROR', message: 'old ambiguous failure' },
      }),
    },
  }));
  for (const key of ['legacy-started-1', 'legacy-failed-01']) {
    assert.ok(journal.start(key, { ...req, url: '/api/v1/legacy?unknown=1' }).existing);
    const status = journal.status(key);
    assert.equal(status.status, 'started');
    assert.equal(status.phase, 'started');
    assert.equal(status.outcome, 'unknown');
    assert.equal(status.legacyAmbiguous, true);
  }
});

test('legacy records cannot be advanced by the new journal', (t) => {
  const journal = fixture(t);
  const req = request({ path: '/api/v1/legacy' });
  fs.writeFileSync(journal.file, JSON.stringify({
    schemaVersion: 1,
    operations: {
      'legacy-started-2': legacyRecord('legacy-started-2', req, 'started'),
    },
  }));
  assert.throws(
    () => journal.localApplied('legacy-started-2', { ok: true }),
    (error) => error.code === 'OPERATION_TRANSITION_INVALID',
  );
});

test('pruning keeps 1,000 terminal records and every unresolved record', (t) => {
  const journal = fixture(t, { maxNonterminalEntries: 5 });
  const operations = {};
  const unresolved = [
    ['keep-started-01', 'started'],
    ['keep-applied-01', 'local_applied'],
    ['keep-sync-unknown', 'sync_unknown'],
  ];
  for (const [key, phase] of unresolved) {
    operations[key] = versionedRecord(key, phase, 'not-a-timestamp', phase === 'started'
      ? {}
      : { provisionalResult: { key } });
  }
  delete operations['keep-started-01'].startedAt;
  delete operations['keep-started-01'].updatedAt;
  const legacyReq = request({ path: '/api/v1/legacy' });
  operations['keep-legacy-fail'] = legacyRecord('keep-legacy-fail', legacyReq, 'failed', {
    completedAt: 'invalid',
    error: { code: 'OLD', message: 'ambiguous' },
  });
  for (let index = 0; index < MAX_TERMINAL_ENTRIES + 7; index += 1) {
    const key = `terminal-${String(index).padStart(4, '0')}`;
    const stamp = index < 2 ? 'invalid' : new Date(Date.UTC(2025, 0, 1, 0, 0, index)).toISOString();
    operations[key] = versionedRecord(key, 'completed', stamp, {
      completedAt: stamp,
      result: { index },
    });
  }
  journal.writePruned({ schemaVersion: 1, operations });
  const saved = journal.read().operations;
  assert.equal(Object.values(saved).filter((operation) => operation.status === 'completed').length, MAX_TERMINAL_ENTRIES);
  for (const [key] of unresolved) assert.ok(saved[key]);
  assert.ok(saved['keep-legacy-fail']);
  assert.equal(saved['terminal-0000'], undefined);
  assert.equal(saved['terminal-0001'], undefined);
  assert.equal(journal.start('post-prune-capacity-1', request()).existing, null);
  assert.throws(
    () => journal.start('post-prune-capacity-2', request()),
    (error) => error instanceof OperationJournalCapacityError,
  );
  assert.equal(MAX_NONTERMINAL_ENTRIES, 1000);
});

test('malformed journal state is quarantined and fails closed', (t) => {
  const journal = fixture(t);
  const malformed = JSON.stringify({
    schemaVersion: 1,
    operations: {
      'malformed-record': {
        key: 'malformed-record',
        fingerprint: 'not-a-hash',
        method: 'POST',
        route: '/api/v1/test',
        status: 'started',
      },
    },
  });
  fs.writeFileSync(journal.file, malformed);
  assert.throws(
    () => journal.read(),
    (error) => error.code === 'JSON_INVALID_SHAPE',
  );
  assert.equal(fs.readFileSync(journal.file, 'utf8'), malformed);
  assert.ok(fs.readdirSync(path.dirname(journal.file)).some((name) => name.includes('.corrupt-')));
});

test('malformed terminal layouts cannot bypass legal transitions', (t) => {
  const journal = fixture(t);
  const malformedFailure = versionedRecord(
    'malformed-failed',
    'failed',
    '2025-01-01T00:00:00.000Z',
    {
      provisionalResult: { effect: true },
      error: { code: 'INVALID_REQUEST', message: 'invalid', status: 200 },
    },
  );
  fs.writeFileSync(journal.file, JSON.stringify({
    schemaVersion: 1,
    operations: { 'malformed-failed': malformedFailure },
  }));
  assert.throws(
    () => journal.read(),
    (error) => error.code === 'JSON_INVALID_SHAPE',
  );

  const malformedCompleted = versionedRecord(
    'malformed-complete',
    'completed',
    '2025-01-01T00:00:00.000Z',
    { result: { ok: true } },
  );
  delete malformedCompleted.provisionalResult;
  delete malformedCompleted.localAppliedAt;
  fs.writeFileSync(journal.file, JSON.stringify({
    schemaVersion: 1,
    operations: { 'malformed-complete': malformedCompleted },
  }));
  assert.throws(
    () => journal.read(),
    (error) => error.code === 'JSON_INVALID_SHAPE',
  );

  const failedWithResult = versionedRecord(
    'failed-with-result',
    'failed',
    '2025-01-01T00:00:00.000Z',
    { result: { shouldNotExist: true } },
  );
  fs.writeFileSync(journal.file, JSON.stringify({
    schemaVersion: 1,
    operations: { 'failed-with-result': failedWithResult },
  }));
  assert.throws(
    () => journal.read(),
    (error) => error.code === 'JSON_INVALID_SHAPE',
  );
});

test('reconcileFromTerminalProof completes started local_applied and sync_unknown records', (t) => {
  const journal = fixture(t);
  const terminal = { ok: true, status: 'completed', applied: 2 };
  const reqA = request();
  journal.start('reconcile-started', reqA);
  const started = journal.get('reconcile-started');
  journal.reconcileFromTerminalProof('reconcile-started', {
    result: terminal,
    fingerprint: started.fingerprint,
    fingerprintVersion: started.fingerprintVersion,
  });
  assert.equal(journal.get('reconcile-started').phase, 'completed');
  assert.deepEqual(journal.get('reconcile-started').result, terminal);

  journal.start('reconcile-local', request());
  journal.localApplied('reconcile-local', { ok: false, status: 'in_progress' });
  const local = journal.get('reconcile-local');
  journal.reconcileFromTerminalProof('reconcile-local', {
    result: terminal,
    fingerprint: local.fingerprint,
    fingerprintVersion: local.fingerprintVersion,
  });
  assert.equal(journal.get('reconcile-local').phase, 'completed');
  assert.deepEqual(journal.get('reconcile-local').result, terminal);

  journal.start('reconcile-sync', request());
  journal.localApplied('reconcile-sync', { ok: false, status: 'in_progress' });
  journal.syncUnknown('reconcile-sync');
  const sync = journal.get('reconcile-sync');
  journal.reconcileFromTerminalProof('reconcile-sync', {
    result: terminal,
    fingerprint: sync.fingerprint,
    fingerprintVersion: sync.fingerprintVersion,
  });
  assert.equal(journal.get('reconcile-sync').phase, 'completed');

  journal.reconcileFromTerminalProof('reconcile-sync', {
    result: terminal,
    fingerprint: sync.fingerprint,
    fingerprintVersion: sync.fingerprintVersion,
  });
  assert.throws(
    () => journal.reconcileFromTerminalProof('reconcile-started', {
      result: { ok: false },
      fingerprint: started.fingerprint,
      fingerprintVersion: started.fingerprintVersion,
    }),
    (error) => error.code === 'OPERATION_TRANSITION_CONFLICT',
  );
  assert.throws(
    () => journal.reconcileFromTerminalProof('reconcile-started', {
      result: terminal,
      fingerprint: 'deadbeef'.repeat(8),
      fingerprintVersion: started.fingerprintVersion,
    }),
    (error) => error.code === 'OPERATION_RECONCILE_PROOF_INVALID',
  );
});
