const test = require('node:test');
const assert = require('node:assert/strict');
const crypto = require('node:crypto');
const { createRequestOperationMachine } = require('../src/lib/request-operation-state');

const clone = (value) => value == null ? value : JSON.parse(JSON.stringify(value));
const sha256 = (value) => crypto.createHash('sha256').update(value).digest('hex');
const profileScope = sha256('fake-server-profile');

function durableStore() {
  let value = null;
  return {
    read: () => clone(value),
    write: (next) => {
      value = clone(next);
    },
  };
}

function newMachine(store, keyPrefix = 'ios-fake') {
  let sequence = 0;
  let clock = 1_800_000_000_000;
  return createRequestOperationMachine({
    store,
    hash: sha256,
    keyFactory: () => `${keyPrefix}-${String(++sequence).padStart(8, '0')}`,
    now: () => ++clock,
  });
}

class FakeOperationServer {
  constructor(behavior) {
    this.behavior = behavior;
    this.operations = new Map();
    this.mutationRequests = new Map();
    this.statusRequests = 0;
    this.statusFailuresRemaining = behavior.statusFailures ?? 0;
  }

  async mutate(key) {
    this.mutationRequests.set(key, (this.mutationRequests.get(key) ?? 0) + 1);
    if (this.behavior.waitFor) await this.behavior.waitFor;
    if (this.behavior.directResult) {
      this.operations.set(key, {
        status: 'completed',
        phase: 'completed',
        result: clone(this.behavior.directResult),
      });
      return { kind: 'completed', result: clone(this.behavior.directResult) };
    }
    if (this.behavior.terminalError) {
      this.operations.set(key, {
        status: 'failed',
        phase: 'failed',
        error: clone(this.behavior.terminalError),
      });
      throw Object.assign(new Error('response lost'), { status: 408, code: 'TIMEOUT' });
    }
    if (this.behavior.phase) {
      this.operations.set(key, {
        status: 'started',
        phase: this.behavior.phase,
        provisionalResult: { mustNotBeReturned: true },
      });
      throw Object.assign(new Error('response lost'), { status: 408, code: 'TIMEOUT' });
    }
    if (this.behavior.completedAfterTimeout) {
      this.operations.set(key, {
        status: 'completed',
        phase: 'completed',
        result: clone(this.behavior.completedAfterTimeout),
      });
    }
    throw Object.assign(new Error('response lost'), { status: 408, code: 'TIMEOUT' });
  }

  async status(key) {
    this.statusRequests += 1;
    if (this.statusFailuresRemaining > 0) {
      this.statusFailuresRemaining -= 1;
      throw new Error('status network failure');
    }
    const operation = this.operations.get(key);
    if (!operation) {
      throw Object.assign(new Error('Operation not found'), {
        status: 404,
        code: 'OPERATION_NOT_FOUND',
      });
    }
    return clone(operation);
  }

  totalMutationRequests() {
    return [...this.mutationRequests.values()].reduce((total, count) => total + count, 0);
  }

  assertAtMostOneMutationPerKey() {
    for (const count of this.mutationRequests.values()) assert.ok(count <= 1);
  }
}

function operation(server, overrides = {}) {
  return {
    scopeDigest: profileScope,
    method: 'POST',
    endpoint: '/api/v1/transactions?source=mobile',
    body: { accountId: 'account-1', amount: 42, tags: ['one', 'two'] },
    dispatch: (key) => server.mutate(key),
    queryStatus: (key) => server.status(key),
    ...overrides,
  };
}

test('fake server recovers completed timeout without mutation replay', async () => {
  const store = durableStore();
  const state = newMachine(store);
  const server = new FakeOperationServer({ completedAfterTimeout: { ok: true, id: 'txn-1' } });
  const result = await state.execute(operation(server));
  assert.deepEqual(result, { ok: true, id: 'txn-1' });
  assert.equal(server.totalMutationRequests(), 1);
  assert.equal(server.statusRequests, 1);
  server.assertAtMostOneMutationPerKey();
});

test('fake server returns durable terminal failure without mutation replay', async () => {
  const store = durableStore();
  const state = newMachine(store);
  const server = new FakeOperationServer({
    terminalError: { status: 400, code: 'INVALID_REQUEST', message: 'Invalid transaction' },
  });
  await assert.rejects(
    state.execute(operation(server)),
    (error) => error.status === 400 && error.code === 'INVALID_REQUEST',
  );
  assert.equal(server.totalMutationRequests(), 1);
  assert.equal(server.statusRequests, 1);
  server.assertAtMostOneMutationPerKey();
});

test('fake server unresolved phases retain safety state without mutation replay', async (t) => {
  for (const phase of ['started', 'local_applied', 'sync_unknown']) {
    await t.test(phase, async () => {
      const store = durableStore();
      const state = newMachine(store);
      const server = new FakeOperationServer({ phase });
      await assert.rejects(state.execute(operation(server)), (error) => error.code === 'OUTCOME_UNKNOWN');
      await assert.rejects(state.execute(operation(server)), (error) => error.code === 'OUTCOME_UNKNOWN');
      assert.equal(server.totalMutationRequests(), 1);
      assert.equal(server.statusRequests, 2);
      server.assertAtMostOneMutationPerKey();
    });
  }
});

test('fake server 404 remains ambiguous across user retries', async () => {
  const store = durableStore();
  const state = newMachine(store);
  const server = new FakeOperationServer({});
  await assert.rejects(state.execute(operation(server)), (error) => error.code === 'OUTCOME_UNKNOWN');
  await assert.rejects(state.execute(operation(server)), (error) => error.code === 'OUTCOME_UNKNOWN');
  assert.equal(server.totalMutationRequests(), 1);
  assert.equal(server.statusRequests, 2);
  server.assertAtMostOneMutationPerKey();
});

test('fake server restart rehydrates and queries the original key', async () => {
  const store = durableStore();
  const server = new FakeOperationServer({
    completedAfterTimeout: { ok: true, id: 'txn-after-restart' },
    statusFailures: 1,
  });
  const beforeRestart = newMachine(store, 'ios-before');
  await assert.rejects(
    beforeRestart.execute(operation(server)),
    (error) => error.code === 'OUTCOME_UNKNOWN',
  );

  const afterRestart = newMachine(store, 'ios-after');
  const result = await afterRestart.execute(operation(server));
  assert.deepEqual(result, { ok: true, id: 'txn-after-restart' });
  assert.equal(server.totalMutationRequests(), 1);
  assert.equal(server.statusRequests, 2);
  server.assertAtMostOneMutationPerKey();
});

test('fake server concurrent taps issue one mutation request', async () => {
  const store = durableStore();
  let release;
  const waitFor = new Promise((resolve) => {
    release = resolve;
  });
  const server = new FakeOperationServer({
    waitFor,
    directResult: { ok: true, id: 'txn-concurrent' },
  });
  const state = newMachine(store);
  const first = state.execute(operation(server));
  const second = state.execute(operation(server));
  assert.equal(server.totalMutationRequests(), 1);
  release();
  assert.deepEqual(await first, { ok: true, id: 'txn-concurrent' });
  assert.deepEqual(await second, { ok: true, id: 'txn-concurrent' });
  assert.equal(server.statusRequests, 0);
  server.assertAtMostOneMutationPerKey();
});
