const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const os = require('os');
const path = require('path');
const { AppError, RequestValidationError } = require('../lib/errors');
const { writeJsonFile } = require('../lib/json-store');
const {
  OperationJournal,
  legacyRequestFingerprint,
} = require('../lib/operation-journal');
const { executeJournaledOperation } = require('../lib/operation-executor');

function request(overrides = {}) {
  return {
    method: 'POST',
    path: '/api/v1/test',
    url: '/api/v1/test?a=1',
    body: { value: 1 },
    ...overrides,
  };
}

function fixture(t, { failWrites = [] } = {}) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'darkfinances-executor-'));
  const file = path.join(dir, 'operations.json');
  let writeCount = 0;
  const journal = new OperationJournal(file, {
    writeState(target, state) {
      writeCount += 1;
      if (failWrites.includes(writeCount)) {
        const error = new Error(`injected journal write failure ${writeCount}`);
        error.code = 'INJECTED_WRITE_FAILURE';
        throw error;
      }
      writeJsonFile(target, state);
    },
  });
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
  return { journal, file, writes: () => writeCount };
}

async function expectCode(promise, code) {
  await assert.rejects(promise, (error) => error.code === code);
}

test('a failure reading journal state prevents admission and handler execution', async (t) => {
  const { file } = fixture(t);
  let calls = 0;
  const error = new Error('injected read failure');
  error.code = 'INJECTED_READ_FAILURE';
  const journal = new OperationJournal(file, {
    readState() { throw error; },
  });
  await expectCode(
    executeJournaledOperation({
      journal,
      key: 'read-failure-001',
      request: request(),
      handler: async () => { calls += 1; },
    }),
    'INJECTED_READ_FAILURE',
  );
  assert.equal(calls, 0);
});

test('journal-start write failure prevents handler execution', async (t) => {
  const { journal } = fixture(t, { failWrites: [1] });
  let calls = 0;
  await expectCode(
    executeJournaledOperation({
      journal,
      key: 'start-failure-01',
      request: request(),
      handler: async () => { calls += 1; },
    }),
    'INJECTED_WRITE_FAILURE',
  );
  assert.equal(calls, 0);
});

test('known validation failure before effects is terminal and replayable after restart', async (t) => {
  const { journal, file } = fixture(t);
  let calls = 0;
  const run = (activeJournal) => executeJournaledOperation({
    journal: activeJournal,
    key: 'validation-fail-1',
    request: request(),
    handler: async () => {
      calls += 1;
      throw new RequestValidationError('bounded invalid request');
    },
  });

  await expectCode(run(journal), 'INVALID_REQUEST');
  assert.equal(journal.get('validation-fail-1').phase, 'failed');
  await expectCode(run(journal), 'INVALID_REQUEST');
  await expectCode(run(new OperationJournal(file)), 'INVALID_REQUEST');
  assert.equal(calls, 1);
});

test('plain and generic AppError failures are never inferred to be pre-apply safe', async (t) => {
  const { journal } = fixture(t);
  for (const [key, error] of [
    ['generic-error-001', new Error('generic failure')],
    ['generic-app-404', new AppError('lookup failed', {
      code: 'NOT_FOUND',
      status: 404,
      expose: true,
    })],
  ]) {
    await expectCode(
      executeJournaledOperation({
        journal,
        key,
        request: request(),
        handler: async () => { throw error; },
      }),
      'OUTCOME_UNKNOWN',
    );
    assert.equal(journal.get(key).phase, 'started');
  }
});

test('failure immediately after local mutation remains started and blocks retry', async (t) => {
  const { journal } = fixture(t);
  let mutations = 0;
  const run = () => executeJournaledOperation({
    journal,
    key: 'after-mutation-01',
    request: request(),
    handler: async (operation) => {
      operation.effectsMayExist();
      mutations += 1;
      throw new Error('crash after mutation before checkpoint');
    },
  });
  await expectCode(run(), 'OUTCOME_UNKNOWN');
  assert.equal(journal.get('after-mutation-01').phase, 'started');
  await expectCode(run(), 'OUTCOME_UNKNOWN');
  assert.equal(mutations, 1);
});

test('failure persisting local_applied preserves started and blocks retry', async (t) => {
  const { journal } = fixture(t, { failWrites: [2] });
  let mutations = 0;
  const run = () => executeJournaledOperation({
    journal,
    key: 'local-write-fail',
    request: request(),
    handler: (operation) => operation.applyLocal(async () => {
      mutations += 1;
      return { id: 'local-result' };
    }),
  });
  await expectCode(run(), 'OUTCOME_UNKNOWN');
  assert.equal(journal.get('local-write-fail').phase, 'started');
  await expectCode(run(), 'OUTCOME_UNKNOWN');
  assert.equal(mutations, 1);
});

test('failure persisting sync_unknown prevents sync and preserves local_applied', async (t) => {
  const { journal } = fixture(t, { failWrites: [3] });
  let syncCalls = 0;
  await expectCode(
    executeJournaledOperation({
      journal,
      key: 'sync-write-fail1',
      request: request(),
      handler: async (operation) => {
        const result = await operation.applyLocal(async () => ({ id: 'local-result' }));
        await operation.sync(async () => { syncCalls += 1; });
        return result;
      },
    }),
    'OUTCOME_UNKNOWN',
  );
  assert.equal(journal.get('sync-write-fail1').phase, 'local_applied');
  assert.equal(syncCalls, 0);
});

test('failure persisting terminal validation failure stays outcome-unknown', async (t) => {
  const { journal } = fixture(t, { failWrites: [2] });
  await expectCode(
    executeJournaledOperation({
      journal,
      key: 'failed-write-fail',
      request: request(),
      handler: async () => { throw new RequestValidationError('invalid request'); },
    }),
    'OUTCOME_UNKNOWN',
  );
  assert.equal(journal.get('failed-write-fail').phase, 'started');
});

test('sync rejection and timeout remain sync_unknown', async (t) => {
  for (const [suffix, syncError] of [
    ['reject', new Error('sync rejected')],
    ['timeout', new AppError('sync timed out', { code: 'TIMEOUT', status: 504, expose: true })],
  ]) {
    const { journal } = fixture(t);
    const key = `sync-${suffix}-0001`;
    await expectCode(
      executeJournaledOperation({
        journal,
        key,
        request: request(),
        handler: async (operation) => {
          const result = await operation.applyLocal(async () => ({ id: suffix }));
          await operation.sync(async () => { throw syncError; });
          return result;
        },
      }),
      'OUTCOME_UNKNOWN',
    );
    assert.equal(journal.get(key).phase, 'sync_unknown');
  }
});

test('sync succeeds but completion write failure remains sync_unknown', async (t) => {
  const { journal } = fixture(t, { failWrites: [4] });
  let syncCalls = 0;
  await expectCode(
    executeJournaledOperation({
      journal,
      key: 'completion-fail-1',
      request: request(),
      handler: async (operation) => {
        const result = await operation.applyLocal(async () => ({ id: 'done-locally' }));
        await operation.sync(async () => { syncCalls += 1; });
        return result;
      },
    }),
    'OUTCOME_UNKNOWN',
  );
  const record = journal.get('completion-fail-1');
  assert.equal(record.phase, 'sync_unknown');
  assert.deepEqual(record.provisionalResult, { id: 'done-locally' });
  assert.equal(syncCalls, 1);
});

test('sidecar completion write failure remains local_applied', async (t) => {
  const { journal } = fixture(t, { failWrites: [3] });
  await expectCode(
    executeJournaledOperation({
      journal,
      key: 'sidecar-complete-fail',
      request: request(),
      handler: (operation) => operation.applyLocal(async () => ({ id: 'sidecar-result' })),
    }),
    'OUTCOME_UNKNOWN',
  );
  const record = journal.get('sidecar-complete-fail');
  assert.equal(record.phase, 'local_applied');
  assert.deepEqual(record.provisionalResult, { id: 'sidecar-result' });
});

test('completed result replays without invoking handler before and after restart', async (t) => {
  const { journal, file } = fixture(t);
  let calls = 0;
  const run = (activeJournal) => executeJournaledOperation({
    journal: activeJournal,
    key: 'completed-replay',
    request: request(),
    handler: (operation) => operation.applyLocal(async () => {
      calls += 1;
      return { id: 'durable-result' };
    }),
  });
  const initial = await run(journal);
  const inProcess = await run(journal);
  const restarted = await run(new OperationJournal(file));
  assert.equal(initial.operation.replayed, false);
  assert.equal(inProcess.operation.replayed, true);
  assert.equal(restarted.operation.replayed, true);
  assert.deepEqual(restarted.result, { id: 'durable-result' });
  assert.equal(calls, 1);
});

test('same-key request conflict never invokes the second handler', async (t) => {
  const { journal } = fixture(t);
  let calls = 0;
  await executeJournaledOperation({
    journal,
    key: 'conflicting-key1',
    request: request(),
    handler: (operation) => operation.applyLocal(async () => {
      calls += 1;
      return { ok: true };
    }),
  });
  await expectCode(
    executeJournaledOperation({
      journal,
      key: 'conflicting-key1',
      request: request({ url: '/api/v1/test?a=2' }),
      handler: async () => { calls += 1; },
    }),
    'IDEMPOTENCY_KEY_REUSED',
  );
  assert.equal(calls, 1);
});

test('every nonterminal phase blocks repeated execution after restart', async (t) => {
  const phases = ['started', 'local_applied', 'sync_unknown'];
  for (const [index, phase] of phases.entries()) {
    const { journal, file } = fixture(t);
    const key = `blocked-phase-${index}`;
    const req = request();
    journal.start(key, req);
    if (phase !== 'started') journal.localApplied(key, { phase });
    if (phase === 'sync_unknown') journal.syncUnknown(key);
    let calls = 0;
    for (const activeJournal of [journal, new OperationJournal(file)]) {
      await expectCode(
        executeJournaledOperation({
          journal: activeJournal,
          key,
          request: req,
          handler: async () => { calls += 1; },
        }),
        'OUTCOME_UNKNOWN',
      );
    }
    assert.equal(calls, 0);
  }
});

test('legacy started and failed records block handler execution', async (t) => {
  const { journal, file } = fixture(t);
  const req = request({ path: '/api/v1/legacy', url: '/api/v1/legacy?ignored=1' });
  const operations = {};
  for (const status of ['started', 'failed']) {
    const key = `legacy-${status}-01`;
    operations[key] = {
      key,
      fingerprint: legacyRequestFingerprint(req.method, req.path, req.body),
      method: req.method,
      route: req.path,
      status,
      startedAt: '2025-01-01T00:00:00.000Z',
      ...(status === 'failed'
        ? { completedAt: '2025-01-01T00:01:00.000Z', error: { code: 'OLD', message: 'ambiguous' } }
        : {}),
    };
  }
  fs.writeFileSync(file, JSON.stringify({ schemaVersion: 1, operations }));
  let calls = 0;
  for (const key of Object.keys(operations)) {
    await expectCode(
      executeJournaledOperation({
        journal,
        key,
        request: req,
        handler: async () => { calls += 1; },
      }),
      'OUTCOME_UNKNOWN',
    );
  }
  assert.equal(calls, 0);
});
