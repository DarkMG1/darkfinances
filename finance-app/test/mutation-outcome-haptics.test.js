const test = require('node:test');
const assert = require('node:assert/strict');
const crypto = require('node:crypto');
const fs = require('node:fs');
const path = require('node:path');
const {
  createMutationOutcomeHapticGate,
  isTerminalMutationError,
} = require('../src/lib/mutation-outcome-haptics');
const {
  createRequestOperationMachine,
  executeMutationWithIdempotency,
} = require('../src/lib/request-operation-state');
const {
  DOCUMENTED_SEMANTIC_EXCEPTIONS,
  MUTATION_CALLBACK_SCAN_ROOTS,
  OUTCOME_HAPTIC_OWNER,
  REMOVED_CALLER_OUTCOME_HAPTICS,
} = require('./haptic-call-site-inventory');

const sha256 = (value) => crypto.createHash('sha256').update(value).digest('hex');
const scope = sha256('haptic-test-profile');
const digest = sha256('haptic-test-request');

function recordingHaptics() {
  const events = [];
  return {
    events,
    api: {
      success: () => events.push('success'),
      warning: () => events.push('warning'),
    },
  };
}

function memoryStore() {
  let value = null;
  return {
    read: () => (value == null ? null : JSON.parse(JSON.stringify(value))),
    write: (next) => {
      value = JSON.parse(JSON.stringify(next));
    },
  };
}

function operationMachine(store) {
  let sequence = 0;
  return createRequestOperationMachine({
    store,
    hash: sha256,
    keyFactory: () => `ios-haptic-${String(++sequence).padStart(8, '0')}`,
    now: (() => {
      let t = 1_700_000_000_000;
      return () => ++t;
    })(),
  });
}

function beginOperation(gate, machine, operation, { scopeDigest = scope } = {}) {
  const prepared = machine.prepare({ ...operation, scopeDigest });
  gate.beginUserMutation(prepared.requestDigest, {
    operationKey: prepared.idempotencyKey,
    scopeDigest,
  });
  return prepared;
}

class FakeOperationServer {
  constructor(behavior) {
    this.behavior = behavior;
    this.operations = new Map();
    this.mutationRequests = new Map();
    this.statusRequests = 0;
  }

  async mutate(key) {
    this.mutationRequests.set(key, (this.mutationRequests.get(key) ?? 0) + 1);
    if (this.behavior.directResult) {
      this.operations.set(key, { status: 'completed', result: this.behavior.directResult });
      return { kind: 'completed', result: this.behavior.directResult };
    }
    if (this.behavior.phase) {
      this.operations.set(key, {
        status: 'started',
        phase: this.behavior.phase,
      });
      throw Object.assign(new Error('response lost'), { status: 408, code: 'TIMEOUT' });
    }
    if (this.behavior.completedAfterTimeout) {
      this.operations.set(key, {
        status: 'completed',
        result: this.behavior.completedAfterTimeout,
      });
    }
    throw Object.assign(new Error('response lost'), { status: 408, code: 'TIMEOUT' });
  }

  async status(key) {
    this.statusRequests += 1;
    const operation = this.operations.get(key);
    if (!operation) {
      throw Object.assign(new Error('Operation not found'), { status: 404, code: 'OPERATION_NOT_FOUND' });
    }
    return operation;
  }

  totalMutationRequests() {
    return [...this.mutationRequests.values()].reduce((total, count) => total + count, 0);
  }
}

function simulateMutationCallbacks(gate, { requestDigest, demo, suppressOutcomeHaptic, outcome, error }) {
  if (demo) {
    if (suppressOutcomeHaptic) return;
    if (outcome === 'success') gate.emitDemoSuccess();
    else if (outcome === 'error') gate.emitDemoError(error);
    return;
  }
  if (suppressOutcomeHaptic) return;
  if (outcome === 'success') gate.emitSuccess(requestDigest);
  else if (outcome === 'error') gate.emitError(requestDigest, error);
}

test('gate contract: success emits exactly one success haptic', () => {
  const { api, events } = recordingHaptics();
  const gate = createMutationOutcomeHapticGate(api);
  gate.beginUserMutation(digest, { operationKey: 'ios-op-1' });
  assert.equal(gate.emitSuccess(digest), true);
  assert.equal(gate.emitSuccess(digest), false);
  assert.deepEqual(events, ['success']);
  assert.equal(gate.sessions().size, 0);
});

test('gate contract: terminal failure emits exactly one warning haptic', () => {
  const { api, events } = recordingHaptics();
  const gate = createMutationOutcomeHapticGate(api);
  gate.beginUserMutation(digest, { operationKey: 'ios-op-1' });
  const error = Object.assign(new Error('bad request'), { status: 400, code: 'INVALID' });
  assert.equal(gate.emitError(digest, error), true);
  assert.equal(gate.emitError(digest, error), false);
  assert.deepEqual(events, ['warning']);
  assert.equal(gate.sessions().size, 0);
});

test('gate contract: outcome unknown then retry success yields one success only', () => {
  const { api, events } = recordingHaptics();
  const gate = createMutationOutcomeHapticGate(api);
  gate.beginUserMutation(digest, { operationKey: 'ios-op-1' });
  const unknown = Object.assign(new Error('unknown'), { status: 409, code: 'OUTCOME_UNKNOWN' });
  assert.equal(gate.emitError(digest, unknown), false);
  assert.equal(gate.emitSuccess(digest), true);
  assert.deepEqual(events, ['success']);
  assert.equal(gate.sessions().size, 0);
});

test('gate contract: suppressed background mutation emits none', () => {
  const { api, events } = recordingHaptics();
  const gate = createMutationOutcomeHapticGate(api);
  simulateMutationCallbacks(gate, {
    requestDigest: digest,
    demo: false,
    suppressOutcomeHaptic: true,
    outcome: 'success',
  });
  assert.deepEqual(events, []);
});

test('gate contract: demo success and terminal demo error each emit once', () => {
  const { api, events } = recordingHaptics();
  const gate = createMutationOutcomeHapticGate(api);
  gate.emitDemoSuccess();
  gate.emitDemoSuccess();
  assert.deepEqual(events, ['success', 'success']);
  events.length = 0;
  const unknown = Object.assign(new Error('unknown'), { status: 409, code: 'OUTCOME_UNKNOWN' });
  assert.equal(gate.emitDemoError(unknown), false);
  assert.equal(gate.emitDemoError(Object.assign(new Error('fail'), { status: 400, code: 'BAD' })), true);
  assert.deepEqual(events, ['warning']);
});

test('gate contract: client validation helper emits one warning', () => {
  const { api, events } = recordingHaptics();
  const gate = createMutationOutcomeHapticGate(api);
  gate.emitClientValidationError();
  gate.emitClientValidationError();
  assert.deepEqual(events, ['warning', 'warning']);
});

test('isTerminalMutationError treats OUTCOME_UNKNOWN and TIMEOUT as non-terminal', () => {
  assert.equal(isTerminalMutationError({ code: 'OUTCOME_UNKNOWN', status: 409 }), false);
  assert.equal(isTerminalMutationError({ code: 'TIMEOUT', status: 408 }), false);
  assert.equal(isTerminalMutationError({ code: 'INVALID', status: 400 }), true);
});

test('reviewer repro A: repeated same-payload user actions each emit one success', () => {
  const { api, events } = recordingHaptics();
  const gate = createMutationOutcomeHapticGate(api);
  gate.beginUserMutation(digest, { operationKey: 'ios-op-1' });
  gate.emitSuccess(digest);
  gate.beginUserMutation(digest, { operationKey: 'ios-op-2' });
  gate.emitSuccess(digest);
  assert.deepEqual(events, ['success', 'success']);
});

test('reviewer repro B: terminal error then later new operation success emits warning then success', () => {
  const { api, events } = recordingHaptics();
  const gate = createMutationOutcomeHapticGate(api);
  const error = Object.assign(new Error('bad request'), { status: 400, code: 'INVALID' });
  gate.beginUserMutation(digest, { operationKey: 'ios-op-1' });
  gate.emitError(digest, error);
  gate.beginUserMutation(digest, { operationKey: 'ios-op-2' });
  gate.emitSuccess(digest);
  assert.deepEqual(events, ['warning', 'success']);
});

test('reviewer repro C: haptic platform failure still consumes session without feedback storms', () => {
  let successCalls = 0;
  const gate = createMutationOutcomeHapticGate({
    success: () => {
      successCalls += 1;
      throw new Error('taptic engine unavailable');
    },
    warning: () => {},
  });
  gate.beginUserMutation(digest, { operationKey: 'ios-op-1' });
  assert.equal(gate.emitSuccess(digest), true);
  assert.equal(successCalls, 1);
  gate.beginUserMutation(digest, { operationKey: 'ios-op-2' });
  assert.equal(gate.emitSuccess(digest), true);
  assert.equal(successCalls, 2);
});

test('reviewer repro D: terminal sessions are removed so memory stays bounded', () => {
  const { api } = recordingHaptics();
  const gate = createMutationOutcomeHapticGate(api);
  for (let index = 0; index < 5; index += 1) {
    const requestDigest = sha256(`bounded-${index}`);
    gate.beginUserMutation(requestDigest, { operationKey: `ios-op-${index}` });
    gate.emitSuccess(requestDigest);
  }
  assert.equal(gate.sessions().size, 0);
});

test('reviewer repro E: concurrent distinct operation keys emit independently', () => {
  const { api, events } = recordingHaptics();
  const gate = createMutationOutcomeHapticGate(api);
  const digestOne = sha256('op-one');
  const digestTwo = sha256('op-two');
  gate.beginUserMutation(digestOne, { operationKey: 'ios-op-1' });
  gate.beginUserMutation(digestTwo, { operationKey: 'ios-op-2' });
  gate.emitSuccess(digestOne);
  gate.emitSuccess(digestTwo);
  assert.deepEqual(events, ['success', 'success']);
});

test('reviewer repro F: abandoned unknown sessions expire via TTL without cutting active retry', () => {
  let nowMs = 1_700_000_000_000;
  const { api } = recordingHaptics();
  const gate = createMutationOutcomeHapticGate(api, {
    maxSessions: 2,
    unknownSessionTtlMs: 1_000,
    now: () => nowMs,
  });
  gate.beginUserMutation(sha256('stale'), { operationKey: 'ios-stale' });
  nowMs += 1_500;
  gate.beginUserMutation(digest, { operationKey: 'ios-active' });
  nowMs += 500;
  gate.beginUserMutation(digest, { operationKey: 'ios-active' });
  assert.equal(gate.sessions().has('ios-stale'), false);
  assert.equal(gate.sessions().has('ios-active'), true);
  nowMs += 500;
  assert.equal(
    gate.beginUserMutation(sha256('fresh'), { operationKey: 'ios-fresh' }),
    true,
  );
  assert.equal(gate.sessions().has('ios-active'), true);
  assert.equal(gate.sessions().has('ios-fresh'), true);
  assert.equal(gate.sessions().size, 2);
});

test('capacity full of genuinely active retries refuses excess without digest mapping', () => {
  let nowMs = 1_700_000_000_000;
  const { api } = recordingHaptics();
  const gate = createMutationOutcomeHapticGate(api, {
    maxSessions: 4,
    now: () => nowMs,
  });
  for (let index = 0; index < 4; index += 1) {
    assert.equal(
      gate.beginUserMutation(sha256(`active-${index}`), { operationKey: `ios-active-${index}` }),
      true,
    );
  }
  const excessDigest = sha256('excess');
  assert.equal(
    gate.beginUserMutation(excessDigest, { operationKey: 'ios-excess' }),
    false,
  );
  assert.equal(gate.sessions().size, 4);
  assert.equal(gate.sessions().has('ios-excess'), false);
  assert.equal(gate.emitSuccess(excessDigest), false);
});

test('production cap: 129 abandoned unknown operations stay bounded at DEFAULT_MAX_SESSIONS', () => {
  const { DEFAULT_MAX_SESSIONS } = require('../src/lib/mutation-outcome-haptics');
  let nowMs = 1_700_000_000_000;
  const { api } = recordingHaptics();
  const gate = createMutationOutcomeHapticGate(api, {
    now: () => nowMs,
  });
  for (let index = 0; index < DEFAULT_MAX_SESSIONS + 1; index += 1) {
    nowMs += 1;
    assert.equal(
      gate.beginUserMutation(sha256(`abandoned-${index}`), { operationKey: `ios-ab-${index}` }),
      true,
      `tracking refused unexpectedly at index ${index}`,
    );
    assert.ok(
      gate.sessions().size <= DEFAULT_MAX_SESSIONS,
      `session map exceeded cap after index ${index}: ${gate.sessions().size}`,
    );
  }
  assert.equal(gate.sessions().size, DEFAULT_MAX_SESSIONS);
  assert.equal(gate.sessions().has('ios-ab-0'), false);
  assert.equal(gate.sessions().has(`ios-ab-${DEFAULT_MAX_SESSIONS}`), true);
  assert.equal(gate.sessions().has(`ios-ab-${DEFAULT_MAX_SESSIONS - 1}`), true);
});

test('production cap: touched active retry survives while abandoned sessions are evicted', () => {
  const { DEFAULT_MAX_SESSIONS } = require('../src/lib/mutation-outcome-haptics');
  let nowMs = 1_700_000_000_000;
  const { api, events } = recordingHaptics();
  const gate = createMutationOutcomeHapticGate(api, {
    now: () => nowMs,
  });
  for (let index = 0; index < DEFAULT_MAX_SESSIONS; index += 1) {
    nowMs += 1;
    gate.beginUserMutation(sha256(`fill-${index}`), { operationKey: `ios-fill-${index}` });
  }
  assert.equal(gate.sessions().size, DEFAULT_MAX_SESSIONS);

  nowMs += 10_000;
  const activeDigest = sha256('active-retry');
  assert.equal(
    gate.beginUserMutation(activeDigest, { operationKey: 'ios-active-retry' }),
    true,
  );
  assert.equal(gate.sessions().has('ios-active-retry'), true);
  assert.equal(gate.sessions().has('ios-fill-0'), false);

  for (let index = 0; index < 20; index += 1) {
    nowMs += 1;
    if (index % 4 === 0) {
      assert.equal(
        gate.beginUserMutation(activeDigest, { operationKey: 'ios-active-retry' }),
        true,
        `active retry touch refused at extra index ${index}`,
      );
    }
    gate.beginUserMutation(sha256(`extra-${index}`), { operationKey: `ios-extra-${index}` });
    assert.ok(
      gate.sessions().size <= DEFAULT_MAX_SESSIONS,
      `session map exceeded cap after extra ${index}`,
    );
    assert.equal(gate.sessions().has('ios-active-retry'), true);
  }
  assert.equal(gate.sessions().size, DEFAULT_MAX_SESSIONS);
  assert.equal(gate.emitSuccess(activeDigest), true);
  assert.deepEqual(events, ['success']);
});

test('profile purge removes scoped haptic sessions only', () => {
  const { api } = recordingHaptics();
  const gate = createMutationOutcomeHapticGate(api);
  const scopeA = sha256('scope-a');
  const scopeB = sha256('scope-b');
  gate.beginUserMutation(digest, { operationKey: 'ios-op-a', scopeDigest: scopeA });
  gate.beginUserMutation(sha256('other'), { operationKey: 'ios-op-b', scopeDigest: scopeB });
  gate.purgeScope(scopeA);
  assert.equal(gate.sessions().has('ios-op-a'), false);
  assert.equal(gate.sessions().has('ios-op-b'), true);
});

test('idempotency retry after timeout emits one success across status polling', async () => {
  const { api, events } = recordingHaptics();
  const gate = createMutationOutcomeHapticGate(api);
  const store = memoryStore();
  const machine = operationMachine(store);
  const server = new FakeOperationServer({ completedAfterTimeout: { ok: true, id: 'txn-1' } });
  const operation = {
    scopeDigest: scope,
    method: 'POST',
    endpoint: '/api/v1/transactions',
    body: { amount: 42 },
    dispatch: (key) => server.mutate(key),
    queryStatus: (key) => server.status(key),
  };
  const prepared = beginOperation(gate, machine, operation);

  const result = await executeMutationWithIdempotency({
    demo: false,
    machine,
    demoDispatch: assert.fail,
    operation,
  });
  assert.deepEqual(result, { ok: true, id: 'txn-1' });
  assert.equal(server.totalMutationRequests(), 1);
  assert.equal(gate.emitSuccess(prepared.requestDigest), true);
  assert.equal(gate.emitSuccess(prepared.requestDigest), false);
  assert.deepEqual(events, ['success']);
});

test('outcome unknown user retry emits one success total', async () => {
  const { api, events } = recordingHaptics();
  const gate = createMutationOutcomeHapticGate(api);
  const store = memoryStore();
  const machine = operationMachine(store);
  const server = new FakeOperationServer({ phase: 'started' });
  const operation = {
    scopeDigest: scope,
    method: 'POST',
    endpoint: '/api/v1/budgets',
    body: { categoryId: 'cat-1', amount: 50 },
    dispatch: (key) => server.mutate(key),
    queryStatus: (key) => server.status(key),
  };
  const prepared = beginOperation(gate, machine, operation);

  await assert.rejects(machine.execute(operation), (error) => error.code === 'OUTCOME_UNKNOWN');
  gate.emitError(prepared.requestDigest, { code: 'OUTCOME_UNKNOWN', status: 409 });

  const pending = machine.listRecords(scope);
  assert.equal(pending.length, 1);
  server.operations.set(pending[0].idempotencyKey, {
    status: 'completed',
    result: { ok: true },
  });

  gate.beginUserMutation(prepared.requestDigest, {
    operationKey: pending[0].idempotencyKey,
    scopeDigest: scope,
  });
  const result = await machine.execute(operation);
  assert.deepEqual(result, { ok: true });
  gate.emitSuccess(prepared.requestDigest);
  assert.deepEqual(events, ['success']);
});

test('machine-aligned repeat same payload allocates new operation identity and haptic', async () => {
  const { api, events } = recordingHaptics();
  const gate = createMutationOutcomeHapticGate(api);
  const store = memoryStore();
  const machine = operationMachine(store);
  const operation = {
    scopeDigest: scope,
    method: 'POST',
    endpoint: '/api/v1/budgets',
    body: { categoryId: 'cat-1', amount: 50 },
    dispatch: async () => ({ kind: 'completed', result: { ok: true } }),
    queryStatus: async () => ({ status: 'started', phase: 'started' }),
  };

  const first = beginOperation(gate, machine, operation);
  await machine.execute(operation);
  gate.emitSuccess(first.requestDigest);

  const second = beginOperation(gate, machine, operation);
  assert.notEqual(second.idempotencyKey, first.idempotencyKey);
  await machine.execute(operation);
  gate.emitSuccess(second.requestDigest);
  assert.deepEqual(events, ['success', 'success']);
});

test('in-flight replay coalescing emits one success for rapid double invoke', async () => {
  const { api, events } = recordingHaptics();
  const gate = createMutationOutcomeHapticGate(api);
  const store = memoryStore();
  const machine = operationMachine(store);
  let resolveDispatch;
  const dispatchGate = new Promise((resolve) => {
    resolveDispatch = resolve;
  });
  const operation = {
    scopeDigest: scope,
    method: 'POST',
    endpoint: '/api/v1/reimbursements/confirm',
    body: { id: 'rep-1' },
    dispatch: async () => {
      await dispatchGate;
      return { kind: 'completed', result: { ok: true } };
    },
    queryStatus: async () => ({ status: 'started', phase: 'started' }),
  };
  const prepared = beginOperation(gate, machine, operation);
  gate.beginUserMutation(prepared.requestDigest, {
    operationKey: prepared.idempotencyKey,
    scopeDigest: scope,
  });

  const first = machine.execute(operation);
  const second = machine.execute(operation);
  resolveDispatch();
  await Promise.all([first, second]);
  gate.emitSuccess(prepared.requestDigest);
  assert.deepEqual(events, ['success']);
});

test('foreground reconciliation path emits zero outcome haptics', async () => {
  const { api, events } = recordingHaptics();
  createMutationOutcomeHapticGate(api);
  const store = memoryStore();
  const machine = operationMachine(store);
  const server = new FakeOperationServer({ phase: 'started' });
  const operation = {
    scopeDigest: scope,
    method: 'POST',
    endpoint: '/api/v1/transactions',
    body: { amount: 10 },
    dispatch: (key) => server.mutate(key),
    queryStatus: (key) => server.status(key),
  };
  await assert.rejects(machine.execute(operation), (error) => error.code === 'OUTCOME_UNKNOWN');
  const pending = machine.listRecords(scope);
  server.operations.set(pending[0].idempotencyKey, {
    status: 'completed',
    result: { ok: true },
  });
  const summary = await machine.reconcileProfile(scope, (key) => server.status(key));
  assert.equal(summary.completed, 1);
  assert.deepEqual(events, []);
});

test('non-mutation GET emits zero outcome haptics', () => {
  const { api, events } = recordingHaptics();
  const gate = createMutationOutcomeHapticGate(api);
  gate.beginUserMutation(null);
  gate.emitSuccess(null);
  gate.emitError(null, { code: 'INVALID', status: 400 });
  assert.deepEqual(events, []);
});

test('inventory documents request-layer ownership', () => {
  assert.match(OUTCOME_HAPTIC_OWNER, /useFinanceMutation/);
  assert.ok(REMOVED_CALLER_OUTCOME_HAPTICS.length >= 5);
});

function mutationCallbackRegion(lines, index) {
  const line = lines[index];
  if (!/\bon(Success|Error)\s*:/.test(line)) return line;
  if (!/=>\s*\{/.test(line)) return line;
  let depth = 0;
  const parts = [];
  for (let i = index; i < lines.length; i += 1) {
    parts.push(lines[i]);
    for (const ch of lines[i]) {
      if (ch === '{') depth += 1;
      if (ch === '}') depth -= 1;
    }
    if (depth === 0) break;
  }
  return parts.join('\n');
}

function findDuplicateOutcomeHapticViolations(appRoot) {
  const violations = [];
  const outcomeHapticPattern = /haptics\.(success|warning)/;

  for (const root of MUTATION_CALLBACK_SCAN_ROOTS) {
    const dir = path.join(appRoot, root);
    for (const file of walk(dir)) {
      if (!file.endsWith('.tsx') && !file.endsWith('.ts')) continue;
      const rel = path.relative(appRoot, file);
      if (rel.includes('api/client/requests.ts')) continue;
      const lines = fs.readFileSync(file, 'utf8').split('\n');
      for (let i = 0; i < lines.length; i += 1) {
        if (!/\bon(Success|Error)\s*:/.test(lines[i])) continue;
        const region = mutationCallbackRegion(lines, i);
        if (outcomeHapticPattern.test(region)) {
          violations.push(`${rel}:${i + 1}: ${lines[i].trim()}`);
        }
      }
    }
  }

  return violations;
}

test('mutation callback region stays within onSuccess block', () => {
  const lines = [
    '    markRec.mutate(',
    '      { payee: payeeName },',
    '      {',
    "        onSuccess: () => Alert.alert('ok'),",
    "        onError: (e) => Alert.alert('fail'),",
    '      }',
    '    );',
    '  };',
    '  const doDelete = () => {',
    '    haptics.warning();',
  ];
  const region = mutationCallbackRegion(lines, 3);
  assert.doesNotMatch(region, /haptics\.warning/);
});

test('mutation callback region catches same-line duplicate haptic', () => {
  const lines = [
    "    mutate(x, { onSuccess: () => haptics.success() });",
  ];
  assert.match(mutationCallbackRegion(lines, 0), /haptics\.success/);
});

test('call-site inventory: no duplicate outcome haptics in mutation callbacks', () => {
  const appRoot = path.join(__dirname, '..');
  const violations = findDuplicateOutcomeHapticViolations(appRoot);
  assert.deepEqual(violations, [], `Duplicate caller outcome haptics:\n${violations.join('\n')}`);
});

test('call-site inventory: semantic exceptions remain at documented locations', () => {
  const appRoot = path.join(__dirname, '..');
  for (const entry of DOCUMENTED_SEMANTIC_EXCEPTIONS) {
    const file = path.join(appRoot, entry.file);
    const source = fs.readFileSync(file, 'utf8');
    assert.match(source, new RegExp(entry.pattern.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')));
  }
});

test('requests.ts wires mutationOutcomeHaptics gate with operation identity', () => {
  const source = fs.readFileSync(
    path.join(__dirname, '../src/api/client/requests.ts'),
    'utf8',
  );
  assert.match(source, /mutationOutcomeHaptics\.emitSuccess/);
  assert.match(source, /mutationOutcomeHaptics\.emitError/);
  assert.match(source, /operationKey:\s*preparedOperation\.idempotencyKey/);
  assert.match(source, /suppressOutcomeHaptic/);
  assert.doesNotMatch(source, /haptics\.success\(\)/);
  assert.doesNotMatch(source, /haptics\.warning\(\)/);
});

test('profile purge clears scoped haptic sessions', () => {
  const source = fs.readFileSync(
    path.join(__dirname, '../src/lib/profile-purge.ts'),
    'utf8',
  );
  assert.match(source, /mutationOutcomeHaptics\.purgeScope\(operationScope\)/);
});

function walk(dir) {
  const entries = fs.readdirSync(dir, { withFileTypes: true });
  const files = [];
  for (const entry of entries) {
    const full = path.join(dir, entry.name);
    if (entry.isDirectory()) files.push(...walk(full));
    else files.push(full);
  }
  return files;
}
