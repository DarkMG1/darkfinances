const test = require('node:test');
const assert = require('node:assert/strict');
const crypto = require('node:crypto');
const fs = require('node:fs');
const path = require('node:path');
const {
  OPERATION_STATES,
  REACT_QUERY_MUTATION_RETRY,
  createReconciliationDiagnosticStore,
  createRedactedReconciliationDiagnostic,
  createRequestOperationMachine,
  executeMutationWithIdempotency,
} = require('../src/lib/request-operation-state');

const clone = (value) => value == null ? value : JSON.parse(JSON.stringify(value));
const sha256 = (value) => crypto.createHash('sha256').update(value).digest('hex');
const scope = (name) => sha256(`profile:${name}`);

function memoryStore(initial = null, options = {}) {
  let value = clone(initial);
  let writes = 0;
  const history = [];
  return {
    read() {
      if (options.failRead) throw new Error('read failed');
      return clone(value);
    },
    write(next) {
      writes += 1;
      if (options.failWriteAt === writes) throw new Error('write failed');
      value = clone(next);
      history.push(clone(next));
    },
    snapshot: () => clone(value),
    history,
  };
}

function machine(store, options = {}) {
  let sequence = options.startSequence ?? 0;
  let now = options.startTime ?? 1_700_000_000_000;
  return createRequestOperationMachine({
    store,
    hash: sha256,
    keyFactory: options.keyFactory ?? (() => {
      sequence += 1;
      return `ios-test-${sequence.toString().padStart(8, '0')}`;
    }),
    now: () => {
      now += 1;
      return now;
    },
  });
}

function memoryDiagnosticStore(timestamp = 1_700_000_000_123) {
  let value = null;
  const diagnostics = createReconciliationDiagnosticStore({
    read: () => value,
    write: (next) => {
      value = next;
    },
  }, () => timestamp);
  return { diagnostics, raw: () => value };
}

function request(overrides = {}) {
  return {
    scopeDigest: scope('primary'),
    method: 'POST',
    endpoint: '/api/v1/budgets?month=2026-07&mode=replace',
    body: { categoryId: 'category-1', amount: 125 },
    dispatch: async () => ({ kind: 'completed', result: { ok: true } }),
    queryStatus: async () => ({ status: 'started', phase: 'started' }),
    ...overrides,
  };
}

function recordFrom(store) {
  const records = Object.values(store.snapshot()?.operations ?? {});
  assert.equal(records.length, 1);
  return records[0];
}

test('new mutation persists prepared and dispatching before one network dispatch', async () => {
  const store = memoryStore();
  const state = machine(store);
  let dispatches = 0;
  let dispatchedKey;
  const result = await state.execute(request({
    dispatch: async (key) => {
      dispatches += 1;
      dispatchedKey = key;
      const pending = recordFrom(store);
      assert.equal(pending.idempotencyKey, key);
      assert.equal(pending.state, OPERATION_STATES.DISPATCHING);
      return { kind: 'completed', result: { saved: true } };
    },
  }));

  assert.deepEqual(result, { saved: true });
  assert.equal(dispatches, 1);
  assert.equal(store.history[0].operations[Object.keys(store.history[0].operations)[0]].state, 'prepared');
  assert.equal(store.history[1].operations[Object.keys(store.history[1].operations)[0]].state, 'dispatching');
  assert.equal(store.history[1].operations[Object.keys(store.history[1].operations)[0]].idempotencyKey, dispatchedKey);
  assert.deepEqual(store.snapshot().operations, {});
});

test('same in-memory retry reuses the original key and only queries status', async () => {
  const store = memoryStore();
  const state = machine(store);
  let dispatches = 0;
  let statusChecks = 0;
  let originalKey;
  const input = request({
    dispatch: async (key) => {
      dispatches += 1;
      originalKey = key;
      return { kind: 'outcome_unknown' };
    },
    queryStatus: async (key) => {
      statusChecks += 1;
      assert.equal(key, originalKey);
      return statusChecks === 1
        ? { status: 'started', phase: 'started' }
        : { status: 'completed', result: { recovered: true } };
    },
  });

  await assert.rejects(state.execute(input), (error) => error.code === 'OUTCOME_UNKNOWN');
  assert.deepEqual(await state.execute(input), { recovered: true });
  assert.equal(dispatches, 1);
  assert.equal(statusChecks, 2);
});

test('same mutation after restart reuses the persisted key', async () => {
  const store = memoryStore();
  const first = machine(store);
  let originalKey;
  await assert.rejects(first.execute(request({
    dispatch: async (key) => {
      originalKey = key;
      throw new Error('connection reset');
    },
    queryStatus: async () => {
      throw new Error('offline');
    },
  })), (error) => error.code === 'OUTCOME_UNKNOWN');

  const restarted = machine(store, { startSequence: 100 });
  let redispatches = 0;
  const result = await restarted.execute(request({
    dispatch: async () => {
      redispatches += 1;
      return { kind: 'completed', result: { wrong: true } };
    },
    queryStatus: async (key) => {
      assert.equal(key, originalKey);
      return { status: 'completed', result: { afterRestart: true } };
    },
  }));
  assert.deepEqual(result, { afterRestart: true });
  assert.equal(redispatches, 0);
});

test('reordered equivalent JSON maps and query ordering reuse one operation', async () => {
  const store = memoryStore();
  const state = machine(store);
  let dispatches = 0;
  let checks = 0;
  await assert.rejects(state.execute(request({
    endpoint: '/api/v1/example?z=last&a=first',
    body: { z: 1, nested: { b: 2, a: 1 }, items: [{ y: 2, x: 1 }] },
    dispatch: async () => {
      dispatches += 1;
      return { kind: 'outcome_unknown' };
    },
    queryStatus: async () => ({ status: 'started', phase: 'started' }),
  })), (error) => error.code === 'OUTCOME_UNKNOWN');

  const result = await state.execute(request({
    endpoint: '/api/v1/example?a=first&z=last',
    body: { items: [{ x: 1, y: 2 }], nested: { a: 1, b: 2 }, z: 1 },
    dispatch: async () => {
      dispatches += 1;
      return { kind: 'completed', result: { wrong: true } };
    },
    queryStatus: async () => {
      checks += 1;
      return { status: 'completed', result: { same: true } };
    },
  }));
  assert.deepEqual(result, { same: true });
  assert.equal(dispatches, 1);
  assert.equal(checks, 1);
});

test('body, endpoint, method, query, profile, and array order change identity', () => {
  const state = machine(memoryStore());
  const base = request({
    endpoint: '/api/v1/example?a=1&b=2',
    body: { value: 1, items: ['a', 'b'] },
  });
  const digest = state.deriveRequestDigest(base);
  assert.equal(state.deriveRequestDigest({ ...base, endpoint: '/api/v1/example?b=2&a=1' }), digest);
  const variants = [
    { ...base, body: { value: 2, items: ['a', 'b'] } },
    { ...base, endpoint: '/api/v1/other?a=1&b=2' },
    { ...base, method: 'DELETE' },
    { ...base, endpoint: '/api/v1/example?a=1&b=3' },
    { ...base, scopeDigest: scope('other') },
    { ...base, body: { value: 1, items: ['b', 'a'] } },
  ];
  for (const variant of variants) assert.notEqual(state.deriveRequestDigest(variant), digest);
});

test('timeout followed by completed status returns result without redispatch', async () => {
  const store = memoryStore();
  const state = machine(store);
  let dispatches = 0;
  const result = await state.execute(request({
    dispatch: async () => {
      dispatches += 1;
      throw Object.assign(new Error('timed out'), { status: 408, code: 'TIMEOUT' });
    },
    queryStatus: async () => ({ status: 'completed', result: { durable: true } }),
  }));
  assert.deepEqual(result, { durable: true });
  assert.equal(dispatches, 1);
  assert.deepEqual(store.snapshot().operations, {});
});

test('timeout followed by failed status reconstructs stored terminal error', async () => {
  const store = memoryStore();
  const state = machine(store);
  let dispatches = 0;
  await assert.rejects(state.execute(request({
    dispatch: async () => {
      dispatches += 1;
      throw Object.assign(new Error('timed out'), { status: 408, code: 'TIMEOUT' });
    },
    queryStatus: async () => ({
      status: 'failed',
      phase: 'failed',
      error: { status: 422, code: 'INVALID_AMOUNT', message: 'Amount is invalid' },
    }),
  })), (error) => (
    error.status === 422
    && error.code === 'INVALID_AMOUNT'
    && error.message === 'Amount is invalid'
  ));
  assert.equal(dispatches, 1);
  assert.deepEqual(store.snapshot().operations, {});
});

test('started, local_applied, and sync_unknown retain the same key without replay', async (t) => {
  for (const phase of ['started', 'local_applied', 'sync_unknown']) {
    await t.test(phase, async () => {
      const store = memoryStore();
      const state = machine(store);
      let dispatches = 0;
      let key;
      await assert.rejects(state.execute(request({
        dispatch: async (value) => {
          key = value;
          dispatches += 1;
          return { kind: 'outcome_unknown' };
        },
        queryStatus: async () => ({
          status: 'started',
          phase,
          provisionalResult: { mustNotBeReturned: true },
        }),
      })), (error) => error.code === 'OUTCOME_UNKNOWN');
      const pending = recordFrom(store);
      assert.equal(pending.idempotencyKey, key);
      assert.equal(pending.state, 'outcome_unknown');
      assert.equal(dispatches, 1);
    });
  }
});

test('status-query network failure retains the key', async () => {
  const store = memoryStore();
  const state = machine(store);
  let key;
  await assert.rejects(state.execute(request({
    dispatch: async (value) => {
      key = value;
      return { kind: 'outcome_unknown' };
    },
    queryStatus: async () => {
      throw new Error('network unavailable');
    },
  })), (error) => error.code === 'OUTCOME_UNKNOWN');
  assert.equal(recordFrom(store).idempotencyKey, key);
});

test('malformed or unclassified direct responses retain the key', async (t) => {
  for (const responseError of [
    Object.assign(new Error('invalid envelope'), { status: 200, code: 'MALFORMED_RESPONSE' }),
    Object.assign(new Error('non-JSON client error'), { status: 400 }),
  ]) {
    await t.test(responseError.message, async () => {
      const store = memoryStore();
      const state = machine(store);
      let key;
      await assert.rejects(state.execute(request({
        dispatch: async (value) => {
          key = value;
          throw responseError;
        },
        queryStatus: async () => ({ status: 'started', phase: 'started' }),
      })), (error) => error.code === 'OUTCOME_UNKNOWN');
      assert.equal(recordFrom(store).idempotencyKey, key);
    });
  }
});

test('malformed terminal status and corrupt storage both fail closed', async (t) => {
  await t.test('malformed failed status', async () => {
    const store = memoryStore();
    const state = machine(store);
    await assert.rejects(state.execute(request({
      dispatch: async () => ({ kind: 'outcome_unknown' }),
      queryStatus: async () => ({
        status: 'failed',
        phase: 'failed',
        error: { status: 400, code: 'lowercase-code', message: 'Malformed error code' },
      }),
    })), (error) => error.code === 'OUTCOME_UNKNOWN');
    assert.equal(recordFrom(store).state, 'outcome_unknown');
  });

  await t.test('corrupt snapshot', async () => {
    const store = memoryStore({
      version: 1,
      generation: 0,
      operations: { invalid: { state: 'dispatching' } },
    });
    const state = machine(store);
    let dispatches = 0;
    await assert.rejects(state.execute(request({
      dispatch: async () => {
        dispatches += 1;
        return { kind: 'completed', result: { wrong: true } };
      },
    })), (error) => error.code === 'LOCAL_OPERATION_STORAGE_ERROR');
    assert.equal(dispatches, 0);
  });
});

test('OPERATION_NOT_FOUND after dispatch remains ambiguous and never resends', async () => {
  const store = memoryStore();
  const state = machine(store);
  let dispatches = 0;
  let originalKey;
  const input = request({
    dispatch: async (key) => {
      originalKey = key;
      dispatches += 1;
      return { kind: 'outcome_unknown' };
    },
    queryStatus: async (key) => {
      assert.equal(key, originalKey);
      throw Object.assign(new Error('not found'), { status: 404, code: 'OPERATION_NOT_FOUND' });
    },
  });
  await assert.rejects(state.execute(input), (error) => error.code === 'OUTCOME_UNKNOWN');
  await assert.rejects(state.execute(input), (error) => error.code === 'OUTCOME_UNKNOWN');
  assert.equal(dispatches, 1);
  assert.equal(recordFrom(store).idempotencyKey, originalKey);
});

test('crash after prepared can safely dispatch once with the persisted key', async () => {
  const store = memoryStore();
  const first = machine(store);
  const prepared = first.prepare(request());
  assert.equal(prepared.state, 'prepared');

  const restarted = machine(store, { startSequence: 50 });
  let dispatches = 0;
  const result = await restarted.execute(request({
    dispatch: async (key) => {
      dispatches += 1;
      assert.equal(key, prepared.idempotencyKey);
      return { kind: 'completed', result: { sent: true } };
    },
    queryStatus: async () => {
      throw new Error('prepared must dispatch, not query');
    },
  }));
  assert.deepEqual(result, { sent: true });
  assert.equal(dispatches, 1);
});

test('crash after dispatching but before fetch can only query status', async () => {
  const store = memoryStore();
  const first = machine(store);
  const prepared = first.prepare(request());
  first.markDispatching(prepared.requestDigest);

  const restarted = machine(store);
  let dispatches = 0;
  await assert.rejects(restarted.execute(request({
    dispatch: async () => {
      dispatches += 1;
      return { kind: 'completed', result: { wrong: true } };
    },
    queryStatus: async (key) => {
      assert.equal(key, prepared.idempotencyKey);
      throw Object.assign(new Error('not found'), { status: 404, code: 'OPERATION_NOT_FOUND' });
    },
  })), (error) => error.code === 'OUTCOME_UNKNOWN');
  assert.equal(dispatches, 0);
  assert.equal(recordFrom(store).state, 'outcome_unknown');
});

test('persistence failure before prepared or dispatching prevents network activity', async (t) => {
  await t.test('prepared write', async () => {
    const store = memoryStore(null, { failWriteAt: 1 });
    const state = machine(store);
    let dispatches = 0;
    await assert.rejects(state.execute(request({
      dispatch: async () => {
        dispatches += 1;
        return { kind: 'completed', result: null };
      },
    })), (error) => error.code === 'LOCAL_OPERATION_STORAGE_ERROR');
    assert.equal(dispatches, 0);
  });

  await t.test('dispatching write', async () => {
    const store = memoryStore(null, { failWriteAt: 2 });
    const state = machine(store);
    let dispatches = 0;
    await assert.rejects(state.execute(request({
      dispatch: async () => {
        dispatches += 1;
        return { kind: 'completed', result: null };
      },
    })), (error) => error.code === 'LOCAL_OPERATION_STORAGE_ERROR');
    assert.equal(dispatches, 0);
    assert.equal(recordFrom(store).state, 'prepared');
  });
});

test('concurrent identical calls share one mutation dispatch', async () => {
  const store = memoryStore();
  const state = machine(store);
  let dispatches = 0;
  let finish;
  const barrier = new Promise((resolve) => {
    finish = resolve;
  });
  const input = request({
    dispatch: async () => {
      dispatches += 1;
      await barrier;
      return { kind: 'completed', result: { once: true } };
    },
  });
  const first = state.execute(input);
  const second = state.execute(input);
  assert.equal(first, second);
  assert.equal(dispatches, 1);
  finish();
  assert.deepEqual(await first, { once: true });
  assert.deepEqual(await second, { once: true });
});

test('terminal operation clears and a later intentional identical mutation gets a new key', async () => {
  const store = memoryStore();
  const state = machine(store);
  const keys = [];
  const input = request({
    dispatch: async (key) => {
      keys.push(key);
      return { kind: 'completed', result: { invocation: keys.length } };
    },
  });
  assert.deepEqual(await state.execute(input), { invocation: 1 });
  assert.deepEqual(store.snapshot().operations, {});
  assert.deepEqual(await state.execute(input), { invocation: 2 });
  assert.equal(keys.length, 2);
  assert.notEqual(keys[0], keys[1]);
});

test('corrected variables after terminal validation failure receive a new key', async () => {
  const store = memoryStore();
  const state = machine(store);
  const keys = [];
  await assert.rejects(state.execute(request({
    body: { amount: 'invalid' },
    dispatch: async (key) => {
      keys.push(key);
      return {
        kind: 'failed',
        error: { status: 400, code: 'INVALID_REQUEST', message: 'amount must be numeric' },
      };
    },
  })), (error) => error.code === 'INVALID_REQUEST');

  await state.execute(request({
    body: { amount: 10 },
    dispatch: async (key) => {
      keys.push(key);
      return { kind: 'completed', result: { ok: true } };
    },
  }));
  assert.equal(keys.length, 2);
  assert.notEqual(keys[0], keys[1]);
});

test('profile scope changes never reuse an old operation key', async () => {
  const store = memoryStore();
  const state = machine(store);
  const keys = [];
  await assert.rejects(state.execute(request({
    scopeDigest: scope('first'),
    dispatch: async (key) => {
      keys.push(key);
      return { kind: 'outcome_unknown' };
    },
    queryStatus: async () => ({ status: 'started', phase: 'started' }),
  })), (error) => error.code === 'OUTCOME_UNKNOWN');

  await state.execute(request({
    scopeDigest: scope('second'),
    dispatch: async (key) => {
      keys.push(key);
      return { kind: 'completed', result: { ok: true } };
    },
  }));
  assert.equal(keys.length, 2);
  assert.notEqual(keys[0], keys[1]);
  assert.equal(state.listRecords(scope('first')).length, 1);
});

test('profile purge clears only prepared records and blocks unresolved dispatched records', async () => {
  const store = memoryStore();
  const state = machine(store);
  state.prepare(request());
  state.prepareProfilePurge(scope('primary'));
  assert.equal(state.listRecords(scope('primary')).length, 0);

  await assert.rejects(state.execute(request({
    dispatch: async () => ({ kind: 'outcome_unknown' }),
    queryStatus: async () => ({ status: 'started', phase: 'started' }),
  })), (error) => error.code === 'OUTCOME_UNKNOWN');
  assert.throws(
    () => state.prepareProfilePurge(scope('primary')),
    (error) => error.code === 'UNRESOLVED_OPERATION_PROFILE_LOCK',
  );
  assert.equal(state.listRecords(scope('primary')).length, 1);

  const serverSource = fs.readFileSync(
    path.join(__dirname, '../src/state/server.tsx'),
    'utf8',
  );
  const purgeSource = fs.readFileSync(
    path.join(__dirname, '../src/lib/profile-purge.ts'),
    'utf8',
  );
  assert.match(serverSource, /purgeFinanceProfile\(oldScope,\s*oldOperationScope\)/);
  assert.ok(
    purgeSource.indexOf('prepareFinanceOperationProfilePurge(operationScope)')
      < purgeSource.indexOf('abortFinanceRequests()'),
  );
});

test('demo mutation bypasses operation identity and persistence', async () => {
  const store = memoryStore();
  const state = machine(store);
  let demoDispatches = 0;
  const result = await executeMutationWithIdempotency({
    demo: true,
    machine: state,
    demoDispatch: async () => {
      demoDispatches += 1;
      return { demo: true };
    },
    operation: request({
      scopeDigest: '',
      dispatch: async () => {
        throw new Error('live dispatch must not run');
      },
    }),
  });
  assert.deepEqual(result, { demo: true });
  assert.equal(demoDispatches, 1);
  assert.equal(store.snapshot(), null);
  assert.equal(store.history.length, 0);
});

test('foreground reconciliation performs status reads only', async () => {
  const store = memoryStore();
  const state = machine(store);
  const first = state.prepare(request({ body: { id: 1 } }));
  state.markDispatching(first.requestDigest);
  const second = state.prepare(request({ body: { id: 2 } }));
  state.markDispatching(second.requestDigest);
  let getRequests = 0;
  let mutationRequests = 0;

  const summary = await state.reconcileProfile(scope('primary'), async (key) => {
    getRequests += 1;
    if (key === first.idempotencyKey) return { status: 'completed', result: { ok: true } };
    return { status: 'started', phase: 'sync_unknown', provisionalResult: { ignored: true } };
  });
  assert.deepEqual(summary, { checked: 2, completed: 1, failed: 0, unresolved: 1 });
  assert.equal(getRequests, 2);
  assert.equal(mutationRequests, 0);
  assert.equal(state.listRecords(scope('primary')).length, 1);
});

test('foreground terminal failure clears pending state and permits a later new key', async () => {
  const store = memoryStore();
  const state = machine(store);
  const dispatched = state.prepare(request());
  state.markDispatching(dispatched.requestDigest);
  let statusChecks = 0;
  let mutationRequests = 0;

  const summary = await state.reconcileProfile(scope('primary'), async (key) => {
    statusChecks += 1;
    assert.equal(key, dispatched.idempotencyKey);
    return {
      status: 'failed',
      phase: 'failed',
      error: { status: 422, code: 'INVALID_AMOUNT', message: 'Amount is invalid' },
    };
  });

  assert.deepEqual(summary, { checked: 1, completed: 0, failed: 1, unresolved: 0 });
  assert.equal(statusChecks, 1);
  assert.equal(mutationRequests, 0);
  assert.deepEqual(store.snapshot().operations, {});

  let laterKey;
  await state.execute(request({
    dispatch: async (key) => {
      mutationRequests += 1;
      laterKey = key;
      return { kind: 'completed', result: { intentional: true } };
    },
  }));
  assert.equal(mutationRequests, 1);
  assert.notEqual(laterKey, dispatched.idempotencyKey);
});

test('foreground and user recovery share one status result without losing terminal data', async () => {
  const store = memoryStore();
  const state = machine(store);
  const prepared = state.prepare(request());
  state.markDispatching(prepared.requestDigest);
  let releaseStatus;
  const statusResult = new Promise((resolve) => {
    releaseStatus = resolve;
  });
  let statusChecks = 0;
  let mutationRequests = 0;
  const queryStatus = async () => {
    statusChecks += 1;
    return statusResult;
  };

  const foreground = state.reconcileProfile(scope('primary'), queryStatus);
  const userRecovery = state.execute(request({
    dispatch: async () => {
      mutationRequests += 1;
      return { kind: 'completed', result: { wrong: true } };
    },
    queryStatus,
  }));
  releaseStatus({ status: 'completed', result: { shared: true } });

  assert.deepEqual(await userRecovery, { shared: true });
  assert.deepEqual(await foreground, { checked: 1, completed: 1, failed: 0, unresolved: 0 });
  assert.equal(statusChecks, 1);
  assert.equal(mutationRequests, 0);
  assert.deepEqual(store.snapshot().operations, {});
});

test('failed foreground reconciliation records and retains a redacted diagnostic', async () => {
  const { diagnostics, raw } = memoryDiagnosticStore();
  await Promise.reject(Object.assign(new Error('private failure text'), {
    code: 'LOCAL_OPERATION_STORAGE_ERROR',
    status: 500,
    serverUrl: 'https://private-finance.example',
    token: 'private-api-token',
    body: { amount: 9876.54 },
  })).catch(diagnostics.record);

  assert.deepEqual(diagnostics.get(), {
    code: 'LOCAL_OPERATION_STORAGE_ERROR',
    status: 500,
    timestamp: 1_700_000_000_123,
  });
  assert.doesNotMatch(raw(), /private|9876\.54/i);
});

test('later successful foreground reconciliation clears the diagnostic', async () => {
  const { diagnostics } = memoryDiagnosticStore();
  diagnostics.record({ code: 'LOCAL_OPERATION_STORAGE_ERROR', status: 500 });
  assert.ok(diagnostics.get());

  await Promise.resolve({ checked: 0, completed: 0, failed: 0, unresolved: 0 })
    .then(diagnostics.clear)
    .catch(diagnostics.record);
  assert.equal(diagnostics.get(), null);

  const layoutSource = fs.readFileSync(
    path.join(__dirname, '../src/app/_layout.tsx'),
    'utf8',
  );
  assert.match(
    layoutSource,
    /clearDiagnostic:\s*clearFinanceOperationReconciliationDiagnostic/,
  );
  assert.match(layoutSource, /recordDiagnostic:\s*recordFinanceOperationReconciliationError/);
});

test('successful profile purge clears the reconciliation diagnostic', () => {
  const store = memoryStore();
  const state = machine(store);
  const { diagnostics } = memoryDiagnosticStore();
  state.prepare(request());
  diagnostics.record({ code: 'RECONCILIATION_FAILED', status: 500 });

  state.prepareProfilePurge(scope('primary'));
  diagnostics.clear();
  assert.equal(diagnostics.get(), null);

  const purgeSource = fs.readFileSync(
    path.join(__dirname, '../src/lib/profile-purge.ts'),
    'utf8',
  );
  const guardAt = purgeSource.indexOf('prepareFinanceOperationProfilePurge(operationScope);');
  const receiptsAt = purgeSource.indexOf('await purgeReceiptCache();');
  const clearAt = purgeSource.indexOf('clearFinanceOperationReconciliationDiagnostic();');
  assert.ok(guardAt >= 0 && receiptsAt > guardAt && clearAt > receiptsAt);
});

test('blocked profile purge retains the reconciliation diagnostic', () => {
  const store = memoryStore();
  const state = machine(store);
  const { diagnostics } = memoryDiagnosticStore();
  const operation = state.prepare(request());
  state.markDispatching(operation.requestDigest);
  diagnostics.record({ code: 'RECONCILIATION_FAILED', status: 500 });

  assert.throws(() => {
    state.prepareProfilePurge(scope('primary'));
    diagnostics.clear();
  }, (error) => error.code === 'UNRESOLVED_OPERATION_PROFILE_LOCK');
  assert.deepEqual(diagnostics.get(), {
    code: 'RECONCILIATION_FAILED',
    status: 500,
    timestamp: 1_700_000_000_123,
  });
  assert.equal(state.listRecords(scope('primary')).length, 1);
});

test('clearing diagnostics never clears unresolved operation records', () => {
  const store = memoryStore();
  const state = machine(store);
  const { diagnostics } = memoryDiagnosticStore();
  const operation = state.prepare(request());
  state.markDispatching(operation.requestDigest);
  diagnostics.record({ code: 'RECONCILIATION_FAILED', status: 500 });

  diagnostics.clear();
  assert.equal(diagnostics.get(), null);
  assert.equal(state.listRecords(scope('primary')).length, 1);
  assert.equal(state.listRecords(scope('primary'))[0].state, 'dispatching');
});

test('foreground reconciliation diagnostic contains only stable redacted fields', () => {
  const secrets = [
    'sensitive reconciliation message',
    'https://private-finance.example',
    'private-api-token',
    'request-digest-secret',
    'ios-idempotency-key-secret',
    'receipt-image-and-financial-body',
  ];
  const diagnostic = createRedactedReconciliationDiagnostic({
    code: 'LOCAL_OPERATION_STORAGE_ERROR',
    status: 500,
    message: secrets[0],
    serverUrl: secrets[1],
    token: secrets[2],
    requestDigest: secrets[3],
    idempotencyKey: secrets[4],
    body: { receipt: secrets[5], amount: 9876.54 },
  }, () => 1_700_000_000_123);

  assert.deepEqual(diagnostic, {
    code: 'LOCAL_OPERATION_STORAGE_ERROR',
    status: 500,
    timestamp: 1_700_000_000_123,
  });
  assert.deepEqual(Object.keys(diagnostic).sort(), ['code', 'status', 'timestamp']);
  const serialized = JSON.stringify(diagnostic);
  for (const secret of secrets) assert.equal(serialized.includes(secret), false);
  assert.equal(serialized.includes('9876.54'), false);

  const layoutSource = fs.readFileSync(
    path.join(__dirname, '../src/app/_layout.tsx'),
    'utf8',
  );
  const operationSource = fs.readFileSync(
    path.join(__dirname, '../src/lib/finance-operations.ts'),
    'utf8',
  );
  assert.match(layoutSource, /recordDiagnostic:\s*recordFinanceOperationReconciliationError/);
  assert.doesNotMatch(layoutSource, /recordDiagnostic:\s*\(\)\s*=>\s*\{\}/);
  assert.match(operationSource, /reconciliationDiagnosticStore\.record\(error\)/);
  assert.doesNotMatch(operationSource, /JSON\.stringify\(error\)/);
});

test('React Query mutation retry is forced off and foreground does not resume mutations', () => {
  assert.equal(REACT_QUERY_MUTATION_RETRY, 0);
  const requestsSource = fs.readFileSync(
    path.join(__dirname, '../src/api/client/requests.ts'),
    'utf8',
  );
  const layoutSource = fs.readFileSync(
    path.join(__dirname, '../src/app/_layout.tsx'),
    'utf8',
  );
  assert.match(requestsSource, /retry:\s*REACT_QUERY_MUTATION_RETRY/);
  assert.doesNotMatch(layoutSource, /resumePausedMutations/);
});

test('persisted snapshot contains only digests, key, lifecycle, and timestamps', async () => {
  const store = memoryStore();
  const state = machine(store);
  const secrets = [
    'https://private-finance.example',
    'super-secret-token',
    '9876.54',
    'receipt-image-private-base64',
    'account-sensitive-name',
  ];
  await assert.rejects(state.execute(request({
    scopeDigest: sha256(`${secrets[0]}\0${secrets[1]}`),
    endpoint: `/api/v1/receipts?amount=${secrets[2]}`,
    body: {
      amount: Number(secrets[2]),
      imageBase64: secrets[3],
      accountName: secrets[4],
    },
    dispatch: async () => ({ kind: 'outcome_unknown' }),
    queryStatus: async () => ({ status: 'started', phase: 'local_applied' }),
  })), (error) => error.code === 'OUTCOME_UNKNOWN');

  const serialized = JSON.stringify(store.snapshot());
  for (const secret of secrets) assert.equal(serialized.includes(secret), false);
  assert.deepEqual(Object.keys(store.snapshot()).sort(), ['generation', 'operations', 'version']);
  assert.equal(Number.isSafeInteger(store.snapshot().generation), true);
  const pending = recordFrom(store);
  assert.match(pending.requestDigest, /^[a-f0-9]{64}$/);
  assert.match(pending.scopeDigest, /^[a-f0-9]{64}$/);
  assert.deepEqual(Object.keys(pending).sort(), [
    'createdAt',
    'dispatchStartedAt',
    'idempotencyKey',
    'outcomeUnknownAt',
    'requestDigest',
    'scopeDigest',
    'state',
    'updatedAt',
    'version',
  ]);
});

test('429 admission overload resets to prepared and reuses the same key on retry', async () => {
  const store = memoryStore();
  const state = machine(store);
  let originalKey;
  let dispatches = 0;
  const input = request({
    dispatch: async (key) => {
      dispatches += 1;
      originalKey = key;
      if (dispatches === 1) {
        return {
          kind: 'retry_same_key',
          error: { status: 429, code: 'ADMISSION_OVERLOADED', message: 'Server busy' },
        };
      }
      return { kind: 'completed', result: { ok: true } };
    },
  });

  await assert.rejects(state.execute(input), (error) => (
    error.code === 'ADMISSION_OVERLOADED'
    && error.requiresIdempotencyKeyReuse === true
  ));
  assert.equal(dispatches, 1);
  const pending = recordFrom(store);
  assert.equal(pending.state, 'prepared');
  assert.equal(pending.idempotencyKey, originalKey);

  const result = await state.execute(input);
  assert.deepEqual(result, { ok: true });
  assert.equal(dispatches, 2);
  assert.deepEqual(store.snapshot().operations, {});
});

test('503 admission unavailable uses retry_same_key without status lookup', async () => {
  const store = memoryStore();
  const state = machine(store);
  let statusChecks = 0;
  await assert.rejects(state.execute(request({
    dispatch: async () => ({
      kind: 'retry_same_key',
      error: { status: 503, code: 'ADMISSION_UNAVAILABLE', message: 'Unavailable' },
    }),
    queryStatus: async () => {
      statusChecks += 1;
      return { status: 'started', phase: 'started' };
    },
  })), (error) => error.code === 'ADMISSION_UNAVAILABLE');
  assert.equal(statusChecks, 0);
  assert.equal(recordFrom(store).state, 'prepared');
});

test('conflicting body after admission retry mints a new operation key', async () => {
  const store = memoryStore();
  const state = machine(store);
  const firstBody = { categoryId: 'category-1', amount: 125 };
  const secondBody = { categoryId: 'category-2', amount: 225 };
  let firstKey;
  await assert.rejects(state.execute(request({
    body: firstBody,
    dispatch: async (key) => {
      firstKey = key;
      return {
        kind: 'retry_same_key',
        error: { status: 429, code: 'ADMISSION_OVERLOADED', message: 'busy' },
      };
    },
  })), (error) => error.code === 'ADMISSION_OVERLOADED');

  const result = await state.execute(request({
    body: secondBody,
    dispatch: async (key) => {
      assert.notEqual(key, firstKey);
      return { kind: 'completed', result: { ok: true, id: 'other' } };
    },
  }));
  assert.deepEqual(result, { ok: true, id: 'other' });
});
