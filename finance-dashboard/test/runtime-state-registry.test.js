const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const os = require('os');
const path = require('path');
const { STATE_REGISTRY, statePath } = require('../lib/state-registry');
const { RUNTIME_STATE_SCHEMAS, CALLER_INVARIANTS } = require('../lib/runtime-state-schemas');
const {
  RuntimeStateError,
  readRuntimeState,
  resetWriteGuards,
  validateBackupSidecar,
  writeRuntimeState,
} = require('../lib/runtime-state-store');
const { validateSidecar } = require('../../ops/lib/backup-verify');
const { writeJsonFile } = require('../lib/json-store');

function tempEnv(t) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'darkfinances-runtime-state-'));
  const env = { ...process.env };
  for (const [name, definition] of Object.entries(STATE_REGISTRY)) {
    env[definition.env] = path.join(dir, definition.filename);
  }
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
  return { dir, env };
}

function writePrimary(env, name, value) {
  const file = statePath(name, env);
  fs.mkdirSync(path.dirname(file), { recursive: true });
  fs.writeFileSync(file, `${JSON.stringify(value, null, 2)}\n`, { mode: 0o600 });
  return file;
}

function writeLastGood(env, name, value) {
  const file = `${statePath(name, env)}.last-good`;
  const contents = typeof value === 'string' ? value : `${JSON.stringify(value, null, 2)}\n`;
  fs.writeFileSync(file, contents, { mode: 0o600 });
  return file;
}

const FIXTURES = {
  accountOverrides: {
    current: {
      schemaVersion: 2,
      accounts: { '00000000-0000-4000-8000-000000000001': { name: 'Cash', role: 'operating_cash' } },
      metadata: { writer: 'fixture' },
    },
    legacy: { '00000000-0000-4000-8000-000000000001': { name: 'Cash', role: 'operating_cash' } },
    legacyMixed: {
      '00000000-0000-4000-8000-000000000001': { hidden: true, role: 'operating_cash' },
      metadata: { writer: 'legacy-import', run: 3 },
    },
    malformed: { schemaVersion: 2, accounts: [] },
    future: { schemaVersion: 9, accounts: {} },
  },
  billsPaid: {
    current: { '2026-07': true },
    legacy: { '2026-06': true },
    malformed: 42,
    future: { schemaVersion: 9 },
  },
  budgetSettings: {
    current: { cat1: { rollover: true } },
    legacy: { cat1: { rollover: false } },
    malformed: 42,
    future: { schemaVersion: 9 },
  },
  debtPlanner: {
    current: { debts: [{ id: 'd1', name: 'Card' }] },
    legacy: { debts: [{ id: 'd1', name: 'Card' }] },
    malformed: 42,
    future: { schemaVersion: 9, debts: [] },
  },
  events: {
    current: { events: [{ slug: 'trip', name: 'Trip' }] },
    legacy: [{ slug: 'trip', name: 'Trip' }],
    malformed: 42,
    future: { schemaVersion: 9, events: [] },
  },
  goals: {
    current: [{ id: 'g1', name: 'Emergency', target: 1000 }],
    legacy: { goals: [{ id: 'g1', name: 'Emergency', target: 1000 }] },
    malformed: { id: 'g1' },
    future: { schemaVersion: 9, goals: [] },
  },
  investmentHoldings: {
    current: { holdings: [{ id: 'h1', symbol: 'VTI' }] },
    legacy: [{ id: 'h1', symbol: 'VTI' }],
    malformed: 42,
    future: { schemaVersion: 9, holdings: [] },
  },
  manualAssets: {
    current: { items: [{ id: 'm1', name: 'Car', value: 10000 }] },
    legacy: [{ id: 'm1', name: 'Car', value: 10000 }],
    malformed: 42,
    future: { schemaVersion: 9, items: [] },
  },
  operationJournal: {
    current: {
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
    legacy: {
      schemaVersion: 1,
      operations: {
        'idem-key-12345678': {
          fingerprint: 'b'.repeat(64),
          method: 'POST',
          route: '/api/v1/rules/apply',
          status: 'started',
          startedAt: '2026-07-13T00:00:00.000Z',
        },
      },
    },
    malformed: 42,
    future: { schemaVersion: 9, operations: {} },
  },
  owesConfig: {
    current: { debtors: [{ slug: 'alex', name: 'Alex' }] },
    legacy: { debtors: [{ slug: 'alex', name: 'Alex' }] },
    malformed: 'bad',
    future: { schemaVersion: 9 },
  },
  owesTruth: {
    current: {
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
    legacy: {
      schemaVersion: 1,
      bySlug: { alex: [{ event: 'trip', amount: 25 }] },
      source: 'splitwise-pairwise',
      generatedAt: '2026-07-13T00:00:00.000Z',
    },
    malformed: { schemaVersion: 2, bySlug: [] },
    future: { schemaVersion: 9, bySlug: {} },
  },
  personalConfig: {
    current: { ownerName: 'Owner' },
    legacy: { ownerName: 'Owner' },
    malformed: 'bad',
    future: { schemaVersion: 9 },
  },
  phantomLog: {
    current: { deleted: [{ importedId: 'x', at: '2026-07-13T00:00:00.000Z' }] },
    legacy: { deleted: [{ importedId: 'x', at: '2026-07-13T00:00:00.000Z' }] },
    malformed: 42,
    future: { schemaVersion: 9, deleted: [] },
  },
  phantomSeen: {
    current: { seen: { abc: { count: 1 } } },
    legacy: { seen: { abc: { count: 1 } } },
    malformed: 42,
    future: { schemaVersion: 9, seen: {} },
  },
  receipts: {
    current: { schemaVersion: 1, byTxn: { t1: [{ id: 'r1', txnId: 't1', filename: 'r1.jpg' }] } },
    legacy: [
      { id: 'r1', txnId: 't1', filename: 'legacy.jpg', note: 'keep-me' },
      { id: 'r2', txnId: 't1', filename: 'legacy2.jpg' },
      { id: 'r3', txnId: 't2', filename: 'other.jpg' },
    ],
    legacyUnmappable: [{ id: 'r1', filename: 'legacy.jpg' }],
    malformed: 42,
    future: { schemaVersion: 9, byTxn: {} },
  },
  reimbursementLinks: {
    current: { schemaVersion: 2, links: [{ linkKey: 'i1:e1', inflow: { id: 'i1' }, expense: { id: 'e1' }, allocationCents: 1000 }] },
    legacy: { links: [{ inflow: { id: 'i1' }, expense: { id: 'e1' }, amount: null }] },
    malformed: 42,
    future: { schemaVersion: 9, links: [] },
  },
  reimbursementLinkSagas: {
    current: {
      schemaVersion: 1,
      sagas: {
        link1: {
          id: 'link1',
          recordVersion: 1,
          action: 'link',
          phase: 'completed',
          status: 'completed',
          updatedAt: '2026-07-13T00:00:00.000Z',
          terminalAt: '2026-07-13T00:00:00.000Z',
          inflowId: 'i1',
          expenseId: 'e1',
          resultVersion: 1,
        },
      },
    },
    legacy: { schemaVersion: 1, sagas: {} },
    malformed: 42,
    future: { schemaVersion: 9, sagas: {} },
  },
  reimbursementSuggestions: {
    current: { confirmed: {}, dismissed: ['s1'] },
    legacy: { confirmed: {}, dismissed: ['s1'] },
    malformed: 42,
    future: { schemaVersion: 9, confirmed: {}, dismissed: [] },
  },
  reconciliation: {
    current: { enabled: true, months: { '2026-07': { closed: false, txns: {} } } },
    legacy: { enabled: true, months: { '2026-07': { closed: false, txns: {} } } },
    malformed: 42,
    future: { schemaVersion: 9, enabled: false, months: {} },
  },
  recurringOverrides: {
    current: { netflix: { amount: 1599 } },
    legacy: { netflix: { amount: 1599 } },
    malformed: 42,
    future: { schemaVersion: 9 },
  },
  reviewState: {
    current: {
      schemaVersion: 2,
      contentVersion: 1,
      dispositions: {
        'uncategorized:imported:abc@v1': {
          disposition: 'acknowledge',
          at: '2026-07-13T00:00:00.000Z',
          contentHash: 'a'.repeat(64),
          kind: 'uncategorized',
        },
      },
      legacyDispositions: {},
    },
    legacy: {
      'fp-1': 'hidden',
      'task:1': { disposition: 'snooze', at: '2026-07-13T00:00:00.000Z' },
    },
    malformed: 42,
    future: { schemaVersion: 9, dispositions: {}, legacyDispositions: {} },
  },
  rules: {
    current: { rules: [{ id: 'r1', payee: 'Coffee', category: 'c1' }] },
    legacy: [{ id: 'r1', payee: 'Coffee', category: 'c1' }],
    malformed: 42,
    future: { schemaVersion: 9, rules: [] },
  },
  transactionDeletionSagas: {
    current: {
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
    legacy: {
      schemaVersion: 1,
      sagas: {
        s1: {
          id: 's1',
          phase: 'completed',
          status: 'completed',
        },
      },
    },
    malformed: { schemaVersion: 1, sagas: { s1: null } },
    future: { schemaVersion: 9, sagas: {} },
  },
  bulkOperationSagas: {
    current: {
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
    legacy: {
      schemaVersion: 1,
      sagas: {
        b1: {
          id: 'b1',
          phase: 'planning',
          status: 'started',
        },
      },
    },
    malformed: { schemaVersion: 1, sagas: { b1: null } },
    future: { schemaVersion: 9, sagas: {} },
  },
  splitwiseMirrorResolutions: {
    current: {
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
    legacy: {
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
    malformed: { schemaVersion: 1, resolutions: [{ sourceId: '123' }] },
    future: { schemaVersion: 9, resolutions: [] },
  },
  repaymentConfirmationSagas: {
    current: {
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
    legacy: {
      schemaVersion: 1,
      sagas: {
        r1: {
          id: 'r1',
          phase: 'completed',
          status: 'completed',
        },
      },
    },
    malformed: { schemaVersion: 1, sagas: { r1: null } },
    future: { schemaVersion: 9, sagas: {} },
  },
  transactionSagas: {
    current: {
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
    legacy: {
      schemaVersion: 1,
      sagas: {
        t1: {
          id: 't1',
          status: 'completed',
        },
      },
    },
    malformed: { schemaVersion: 1, sagas: { t1: null } },
    future: { schemaVersion: 9, sagas: {} },
  },
  venmoTruth: {
    current: { schemaVersion: 2, bySlug: { alex: [{ event: 'venmo', amount: 10 }] } },
    legacy: { bySlug: { alex: [{ event: 'venmo', amount: 10 }] } },
    malformed: { schemaVersion: 2, bySlug: [] },
    future: { schemaVersion: 9, bySlug: {} },
  },
  passkeyCredentials: {
    current: [{
      credentialID: 'cred-1',
      credentialPublicKey: Buffer.from('public-key-bytes').toString('base64'),
      counter: 0,
      transports: ['internal'],
      createdAt: '2026-07-13T00:00:00.000Z',
      lastUsedAt: null,
    }],
    legacy: [{
      credentialID: 'cred-1',
      credentialPublicKey: Buffer.from('public-key-bytes').toString('base64'),
      counter: 0,
      transports: ['internal'],
      createdAt: '2026-07-13T00:00:00.000Z',
      lastUsedAt: null,
    }],
    legacyWrapper: {
      credentials: [{
        credentialID: 'cred-1',
        credentialPublicKey: Buffer.from('public-key-bytes').toString('base64'),
        counter: 0,
        transports: ['internal'],
        createdAt: '2026-07-13T00:00:00.000Z',
        lastUsedAt: null,
      }],
    },
    malformed: { credentials: 'bad' },
    future: { schemaVersion: 9, credentials: [] },
  },
};

test('every registry entry has an authoritative runtime schema', () => {
  for (const name of Object.keys(STATE_REGISTRY)) {
    assert.ok(RUNTIME_STATE_SCHEMAS[name], `missing schema for ${name}`);
  }
  assert.equal(Object.keys(RUNTIME_STATE_SCHEMAS).length, Object.keys(STATE_REGISTRY).length);
});

for (const [name, fixtures] of Object.entries(FIXTURES)) {
  test(`${name}: missing optional/default is distinct from corrupt`, (t) => {
    resetWriteGuards();
    const { env } = tempEnv(t);
    const schema = RUNTIME_STATE_SCHEMAS[name];
    const result = readRuntimeState(name, { env });
    if (schema.optionalMissing) {
      assert.equal(result.value, schema.missingValue());
      assert.equal(result.meta.source, 'missing');
    } else {
      assert.deepEqual(result.value, schema.missingValue());
      assert.equal(result.meta.source, 'missing-default');
    }
  });

  test(`${name}: valid current payload loads from primary`, (t) => {
    resetWriteGuards();
    const { env } = tempEnv(t);
    writePrimary(env, name, fixtures.current);
    const result = readRuntimeState(name, { env });
    assert.equal(result.meta.source, 'primary');
    assert.ok(schemaFor(name).validateCurrent(result.value));
  });

  test(`${name}: supported legacy migrates before validation`, (t) => {
    resetWriteGuards();
    const { env } = tempEnv(t);
    writePrimary(env, name, fixtures.legacy);
    const first = readRuntimeState(name, { env });
    const second = readRuntimeState(name, { env });
    assert.ok(schemaFor(name).validateCurrent(first.value));
    assert.deepEqual(second.value, first.value);
    const migrated = schemaFor(name).migrate(fixtures.legacy);
    const again = schemaFor(name).migrate(migrated.value);
    assert.deepEqual(again.value, migrated.value);
    if (name === 'receipts') {
      assert.deepEqual(first.value.byTxn.t1.length, 2);
      assert.equal(first.value.byTxn.t1[0].note, 'keep-me');
      assert.deepEqual(first.value.byTxn.t2.length, 1);
    }
    if (name === 'reviewState') {
      assert.deepEqual(first.value.legacyDispositions['fp-1'], 'hidden');
      assert.deepEqual(first.value.legacyDispositions['task:1'], fixtures.legacy['task:1']);
      assert.equal(Object.keys(first.value.dispositions || {}).length, 0);
    }
    if (name === 'accountOverrides' && fixtures.legacyMixed) {
      resetWriteGuards();
      const mixedEnv = tempEnv(t);
      writePrimary(mixedEnv.env, name, fixtures.legacyMixed);
      const mixed = readRuntimeState(name, { env: mixedEnv.env }).value;
      assert.deepEqual(mixed.metadata, fixtures.legacyMixed.metadata);
      assert.equal(mixed.accounts['00000000-0000-4000-8000-000000000001'].hidden, true);
    }
  });

  test(`${name}: malformed primary quarantines and blocks writes`, (t) => {
    resetWriteGuards();
    const { env, dir } = tempEnv(t);
    const file = statePath(name, env);
    fs.mkdirSync(path.dirname(file), { recursive: true });
    if (typeof fixtures.malformed === 'string' && fixtures.malformed.startsWith('{broken')) {
      fs.writeFileSync(file, fixtures.malformed, { mode: 0o600 });
    } else {
      writePrimary(env, name, fixtures.malformed);
    }
    if (name === 'passkeyCredentials') {
      assert.throws(() => readRuntimeState(name, { env }), RuntimeStateError);
      return;
    }
    assert.throws(
      () => readRuntimeState(name, { env }),
      (error) => error instanceof RuntimeStateError
        || error?.name === 'SplitwiseMirrorResolutionError',
    );
    if (name !== 'splitwiseMirrorResolutions') {
      assert.ok(fs.readdirSync(dir).some((entry) => entry.includes('.corrupt-')));
    } else {
      assert.ok(fs.readdirSync(dir).some((entry) => entry.includes('.corrupt-')));
    }
    assert.throws(
      () => writeRuntimeState(name, fixtures.current, { env }),
      (error) => error instanceof RuntimeStateError && error.code === 'RUNTIME_STATE_WRITE_BLOCKED',
    );
    assert.equal(fs.existsSync(file), true);
  });

  test(`${name}: future schemaVersion is rejected`, (t) => {
    resetWriteGuards();
    const { env } = tempEnv(t);
    writePrimary(env, name, fixtures.future);
    assert.throws(
      () => readRuntimeState(name, { env }),
      (error) => error instanceof RuntimeStateError || error?.code === 'RUNTIME_STATE_FUTURE_SCHEMA',
    );
  });

  test(`${name}: corrupt primary with valid last-good recovers read path`, (t) => {
    resetWriteGuards();
    const schema = RUNTIME_STATE_SCHEMAS[name];
    if (schema.lastGoodPolicy !== 'allow-on-primary-invalid') return;
    const { env } = tempEnv(t);
    const file = statePath(name, env);
    fs.mkdirSync(path.dirname(file), { recursive: true });
    fs.writeFileSync(file, '{broken', { mode: 0o600 });
    writeLastGood(env, name, fixtures.current);
    const result = readRuntimeState(name, { env });
    assert.equal(result.meta.source, 'last-good');
    assert.ok(schema.validateCurrent(result.value));
  });

  test(`${name}: corrupt primary with invalid last-good blocks writes`, (t) => {
    resetWriteGuards();
    const schema = RUNTIME_STATE_SCHEMAS[name];
    if (schema.lastGoodPolicy !== 'allow-on-primary-invalid') return;
    const { env } = tempEnv(t);
    const file = statePath(name, env);
    fs.mkdirSync(path.dirname(file), { recursive: true });
    fs.writeFileSync(file, '{broken', { mode: 0o600 });
    writeLastGood(env, name, '{broken');
    assert.throws(() => readRuntimeState(name, { env }), RuntimeStateError);
    assert.throws(
      () => writeRuntimeState(name, fixtures.current, { env }),
      (error) => error.code === 'RUNTIME_STATE_WRITE_BLOCKED',
    );
  });

  test(`${name}: writes validate current shape before atomic commit`, (t) => {
    resetWriteGuards();
    const { env } = tempEnv(t);
    if (name === 'passkeyCredentials') {
      assert.throws(
        () => writeRuntimeState(name, fixtures.current, { env }),
        (error) => error.code === 'RUNTIME_STATE_DURABILITY_CONTRACT',
      );
      return;
    }
    writeRuntimeState(name, fixtures.current, { env });
    const loaded = readRuntimeState(name, { env }).value;
    assert.ok(schemaFor(name).validateCurrent(loaded));
    assert.throws(
      () => writeRuntimeState(name, fixtures.malformed, { env }),
      (error) => error instanceof RuntimeStateError,
    );
  });
}

test('active bulk saga ownership survives idempotent migration', (t) => {
  resetWriteGuards();
  const { env } = tempEnv(t);
  const active = {
    schemaVersion: 1,
    sagas: {
      bulk1: {
        id: 'bulk1',
        phase: 'item_apply',
        status: 'started',
        kind: 'splitwise_mirror',
      },
    },
  };
  writePrimary(env, 'bulkOperationSagas', active);
  const loaded = readRuntimeState('bulkOperationSagas', { env }).value;
  assert.equal(loaded.sagas.bulk1.phase, 'item_apply');
  const again = RUNTIME_STATE_SCHEMAS.bulkOperationSagas.migrate(loaded);
  assert.equal(again.value.sagas.bulk1.phase, 'item_apply');
  assert.equal(again.changed, false);
});

test('json-store still writes atomically with validated last-good copy', (t) => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'darkfinances-json-'));
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
  const file = path.join(dir, 'state.json');
  writeJsonFile(file, { version: 1 });
  writeJsonFile(file, { version: 2 });
  assert.deepEqual(JSON.parse(fs.readFileSync(`${file}.last-good`, 'utf8')), { version: 1 });
});

test('receipts legacy array without durable txnId is unmappable and quarantined', (t) => {
  resetWriteGuards();
  const { env, dir } = tempEnv(t);
  writePrimary(env, 'receipts', FIXTURES.receipts.legacyUnmappable);
  assert.throws(
    () => readRuntimeState('receipts', { env }),
    (error) => error instanceof RuntimeStateError || error.code === 'RUNTIME_STATE_MIGRATION_FAILED',
  );
  assert.ok(fs.readdirSync(dir).some((entry) => entry.includes('.corrupt-')));
  assert.throws(
    () => writeRuntimeState('receipts', FIXTURES.receipts.current, { env }),
    (error) => error.code === 'RUNTIME_STATE_WRITE_BLOCKED',
  );
});

test('receipts legacy migration is lossless on read and write round-trip', (t) => {
  resetWriteGuards();
  const { env } = tempEnv(t);
  writePrimary(env, 'receipts', FIXTURES.receipts.legacy);
  const migrated = readRuntimeState('receipts', { env }).value;
  writeRuntimeState('receipts', migrated, { env });
  const roundTrip = readRuntimeState('receipts', { env }).value;
  assert.deepEqual(roundTrip, migrated);
});

test('readJsonSafe caller validate runs after registry migration for receipts byTxn arrays', (t) => {
  resetWriteGuards();
  const { env } = tempEnv(t);
  const file = statePath('receipts', env);
  writePrimary(env, 'receipts', { schemaVersion: 1, byTxn: { bad: 'not-an-array' } });
  assert.throws(
    () => readRuntimeState('receipts', {
      env,
      validate: CALLER_INVARIANTS.receipts,
    }),
    RuntimeStateError,
  );
  assert.throws(
    () => readRuntimeState('receipts', { env }),
    RuntimeStateError,
  );
  assert.equal(fs.existsSync(file), true);
});

for (const [name, validator] of Object.entries(CALLER_INVARIANTS)) {
  test(`caller invariant inventory: ${name} rejects malformed post-migration shape`, () => {
    const schema = RUNTIME_STATE_SCHEMAS[name];
    const good = FIXTURES[name]?.current;
    assert.ok(good != null, `missing fixture for ${name}`);
    const migrated = schema.migrate(good).value;
    assert.ok(validator(migrated));
    if (name === 'receipts') {
      assert.equal(validator({ schemaVersion: 1, byTxn: { bad: 'x' } }), false);
    }
    if (name === 'reimbursementLinks') {
      assert.equal(validator({ schemaVersion: 2, links: 'bad' }), false);
    }
    if (name === 'reimbursementSuggestions') {
      assert.equal(validator({ confirmed: {}, dismissed: 'bad' }), false);
    }
    if (name === 'reconciliation') {
      assert.equal(validator({ enabled: false, months: [] }), false);
    }
    if (name === 'phantomSeen') {
      assert.equal(validator({ seen: [] }), false);
    }
    if (name === 'accountOverrides') {
      assert.equal(validator({ schemaVersion: 2, accounts: [] }), false);
    }
  });
}

const OWNERSHIP_ADVERSARIAL = [
  {
    name: 'bulkOperationSagas',
    buildOriginal: (stamp) => ({
      schemaVersion: 1,
      sagas: {
        active: {
          id: 'active',
          recordVersion: 1,
          kind: 'rules_apply',
          phase: 'item_pending',
          updatedAt: stamp,
          items: [{ txnIds: ['txn-owned'] }],
        },
        done: {
          id: 'done',
          recordVersion: 1,
          kind: 'rules_apply',
          phase: 'completed',
          updatedAt: stamp,
          terminalAt: stamp,
          items: [{ txnIds: ['txn-done'] }],
        },
      },
    }),
    buildAttack: (original) => ({
      schemaVersion: 1,
      sagas: {
        done: { ...original.sagas.done, phase: 'item_pending', terminalAt: undefined },
      },
    }),
    pattern: /cannot reopen terminal|cannot remove terminal|cannot weaken ownership|cannot drop a nonterminal/,
  },
  {
    name: 'transactionDeletionSagas',
    buildOriginal: (stamp) => ({
      schemaVersion: 1,
      sagas: {
        active: {
          id: 'active',
          recordVersion: 1,
          phase: 'prepared',
          updatedAt: stamp,
          transaction: { id: 'txn-owned' },
        },
      },
    }),
    buildAttack: () => ({ schemaVersion: 1, sagas: {} }),
    pattern: /cannot drop a nonterminal/,
  },
  {
    name: 'reimbursementLinkSagas',
    buildOriginal: (stamp) => ({
      schemaVersion: 1,
      sagas: {
        active: {
          id: 'active',
          recordVersion: 1,
          action: 'link',
          phase: 'prepared',
          updatedAt: stamp,
          inflowId: 'in-owned',
          expenseId: 'ex-owned',
        },
        done: {
          id: 'done',
          recordVersion: 1,
          action: 'link',
          phase: 'completed',
          updatedAt: stamp,
          terminalAt: stamp,
          inflowId: 'in-done',
          expenseId: 'ex-done',
          resultVersion: 1,
        },
      },
    }),
    buildAttack: (original) => ({
      schemaVersion: 1,
      sagas: {
        done: { ...original.sagas.done, phase: 'prepared', terminalAt: undefined, resultVersion: undefined },
      },
    }),
    pattern: /cannot reopen terminal|cannot remove terminal|cannot weaken ownership|cannot drop a nonterminal/,
  },
  {
    name: 'repaymentConfirmationSagas',
    buildOriginal: (stamp) => ({
      schemaVersion: 1,
      sagas: {
        active: {
          id: 'active',
          recordVersion: 1,
          phase: 'prepared',
          updatedAt: stamp,
          inflow: { id: 'in-owned' },
        },
        done: {
          id: 'done',
          recordVersion: 1,
          phase: 'completed',
          updatedAt: stamp,
          terminalAt: stamp,
          inflow: { id: 'in-done' },
          allocations: [{ expenseId: 'ex-done' }],
          auditOutcome: { outcome: 'confirmed' },
        },
      },
    }),
    buildAttack: (original) => ({
      schemaVersion: 1,
      sagas: {
        done: {
          ...original.sagas.done,
          phase: 'prepared',
          terminalAt: undefined,
          auditOutcome: undefined,
        },
      },
    }),
    pattern: /cannot reopen terminal|cannot remove terminal|cannot weaken ownership|cannot drop a nonterminal/,
  },
  {
    name: 'operationJournal',
    buildOriginal: (stamp) => ({
      schemaVersion: 1,
      operations: {
        'idem-key-12345678': {
          key: 'idem-key-12345678',
          recordVersion: 2,
          fingerprint: 'a'.repeat(64),
          fingerprintVersion: 2,
          method: 'POST',
          route: '/api/v1/test',
          status: 'started',
          phase: 'started',
          startedAt: stamp,
          updatedAt: stamp,
        },
      },
    }),
    buildAttack: () => ({ schemaVersion: 1, operations: {} }),
    pattern: /cannot drop a nonterminal operation/,
  },
];

for (const scenario of OWNERSHIP_ADVERSARIAL) {
  test(`ownership guard: ${scenario.name} rejects adversarial rewrite`, (t) => {
    resetWriteGuards();
    const { env } = tempEnv(t);
    const stamp = '2026-07-13T00:00:00.000Z';
    const original = scenario.buildOriginal(stamp);
    writeRuntimeState(scenario.name, original, { env, enforceOwnership: false });
    assert.throws(
      () => writeRuntimeState(scenario.name, scenario.buildAttack(original), { env }),
      scenario.pattern,
    );
  });
}

test('backup sidecar validation shares authoritative runtime schemas', () => {
  for (const [name, definition] of Object.entries(STATE_REGISTRY)) {
    if (!definition.backup) continue;
    const sample = FIXTURES[name]?.current;
    if (sample == null) continue;
    assert.doesNotThrow(() => validateBackupSidecar(definition.filename, sample));
    assert.doesNotThrow(() => validateSidecar(definition.filename, JSON.stringify(sample)));
  }
});

test('owesTruth v1 live truth migrates for backup validation without requiring manifest', () => {
  const legacy = FIXTURES.owesTruth.legacy;
  assert.doesNotThrow(() => validateBackupSidecar('owes-truth.json', legacy));
});

test('reviewState flat legacy map migrates losslessly through read, write, and backup', (t) => {
  resetWriteGuards();
  const { env } = tempEnv(t);
  const legacy = FIXTURES.reviewState.legacy;
  writePrimary(env, 'reviewState', legacy);
  const loaded = readRuntimeState('reviewState', { env }).value;
  assert.equal(loaded.schemaVersion, 2);
  assert.deepEqual(loaded.legacyDispositions['fp-1'], 'hidden');
  assert.deepEqual(loaded.legacyDispositions['task:1'], legacy['task:1']);
  assert.deepEqual(loaded.dispositions, {});
  writeRuntimeState('reviewState', loaded, { env, enforceOwnership: false });
  const roundTrip = readRuntimeState('reviewState', { env }).value;
  assert.deepEqual(roundTrip.legacyDispositions, loaded.legacyDispositions);
  assert.doesNotThrow(() => validateBackupSidecar('review-state.json', legacy));
  const migrated = RUNTIME_STATE_SCHEMAS.reviewState.migrate(legacy).value;
  assert.doesNotThrow(() => validateBackupSidecar('review-state.json', migrated));
});

test('owesTruth and venmoTruth preserve undeclared top-level metadata across v0/v1 to v2 migration', (t) => {
  resetWriteGuards();
  const { env } = tempEnv(t);
  const extraMeta = { auditTrail: { run: 3 }, tags: ['live'] };
  const cases = [
    {
      name: 'owesTruth',
      filename: 'owes-truth.json',
      v0: {
        bySlug: { alex: [{ event: 'trip', amount: 25 }] },
        source: 'splitwise-pairwise',
        extraMeta,
      },
      v1: {
        schemaVersion: 1,
        bySlug: { alex: [{ event: 'trip', amount: 25 }] },
        extraMeta,
      },
    },
    {
      name: 'venmoTruth',
      filename: 'venmo-truth.json',
      v0: {
        bySlug: { alex: [{ event: 'venmo', amount: 10 }] },
        extraMeta,
      },
      v1: {
        schemaVersion: 1,
        bySlug: { alex: [{ event: 'venmo', amount: 10 }] },
        extraMeta,
      },
    },
  ];

  for (const entry of cases) {
    for (const [label, payload] of [['v0', entry.v0], ['v1', entry.v1]]) {
      writePrimary(env, entry.name, payload);
      const loaded = readRuntimeState(entry.name, { env }).value;
      assert.equal(loaded.schemaVersion, 2, `${entry.name} ${label} read`);
      assert.deepEqual(loaded.extraMeta, extraMeta, `${entry.name} ${label} extraMeta read`);
      writeRuntimeState(entry.name, loaded, { env, enforceOwnership: false });
      const roundTrip = readRuntimeState(entry.name, { env }).value;
      assert.deepEqual(roundTrip.extraMeta, extraMeta, `${entry.name} ${label} write round-trip`);
      assert.doesNotThrow(
        () => validateBackupSidecar(entry.filename, payload),
        `${entry.name} ${label} backup validate`,
      );
      const migrated = RUNTIME_STATE_SCHEMAS[entry.name].migrate(payload).value;
      assert.deepEqual(migrated.extraMeta, extraMeta, `${entry.name} ${label} migrate`);
      assert.doesNotThrow(
        () => validateBackupSidecar(entry.filename, migrated),
        `${entry.name} ${label} migrated backup validate`,
      );
    }
  }
});

test('truth sidecars reject unsafe top-level prototype keys during migration', () => {
  for (const name of ['owesTruth', 'venmoTruth']) {
    const unsafe = JSON.parse('{"bySlug":{},"__proto__":{"polluted":true}}');
    assert.throws(
      () => RUNTIME_STATE_SCHEMAS[name].migrate(unsafe),
      /rejects unsafe top-level field __proto__/,
    );
  }
});

const STAMP = '2026-07-13T00:00:00.000Z';

const COMPLETE_SAGA_FIXTURES = {
  transactionSagas: {
    schemaVersion: 1,
    sagas: {
      saga1: {
        id: 'saga1',
        recordVersion: 2,
        phase: 'prepared',
        updatedAt: STAMP,
        original: { id: 'txn-1' },
      },
    },
  },
  transactionDeletionSagas: {
    schemaVersion: 1,
    sagas: {
      del1: {
        id: 'del1',
        recordVersion: 1,
        phase: 'prepared',
        updatedAt: STAMP,
        target: { parentId: 'txn-1', ids: ['txn-1'], legIds: [] },
      },
    },
  },
  repaymentConfirmationSagas: {
    schemaVersion: 1,
    sagas: {
      repay1: {
        id: 'repay1',
        recordVersion: 1,
        phase: 'prepared',
        updatedAt: STAMP,
        inflow: { id: 'in-1' },
      },
    },
  },
  reimbursementLinkSagas: {
    schemaVersion: 1,
    sagas: {
      link1: {
        id: 'link1',
        recordVersion: 1,
        action: 'link',
        phase: 'prepared',
        updatedAt: STAMP,
        inflowId: 'in-1',
        expenseId: 'ex-1',
      },
    },
  },
  bulkOperationSagas: {
    schemaVersion: 1,
    sagas: {
      bulk1: {
        id: 'bulk1',
        recordVersion: 1,
        kind: 'rules_apply',
        phase: 'prepared',
        updatedAt: STAMP,
        items: [{ txnIds: ['txn-1'] }],
      },
    },
  },
};

for (const [name, payload] of Object.entries(COMPLETE_SAGA_FIXTURES)) {
  test(`strict write accepts complete new ${name} record`, (t) => {
    resetWriteGuards();
    const { env } = tempEnv(t);
    assert.doesNotThrow(() => writeRuntimeState(name, payload, { env, enforceOwnership: false }));
  });

  test(`strict write rejects incomplete new ${name} record`, (t) => {
    resetWriteGuards();
    const { env } = tempEnv(t);
    const incomplete = {
      schemaVersion: 1,
      sagas: {
        newSaga: { id: 'newSaga', phase: 'prepared' },
      },
    };
    assert.throws(
      () => writeRuntimeState(name, incomplete, { env, enforceOwnership: false }),
      /cannot write incomplete new saga|requires durable id on write/,
    );
  });
}

const FAMILY_IDENTITY_WRITE_REJECTIONS = [
  {
    name: 'bulkOperationSagas',
    payload: {
      schemaVersion: 1,
      sagas: {
        bulk1: {
          id: 'bulk1',
          recordVersion: 1,
          phase: 'prepared',
          updatedAt: STAMP,
          items: [{ txnIds: ['txn-1'] }],
        },
      },
    },
    pattern: /kind must be a non-empty string/,
  },
  {
    name: 'transactionDeletionSagas',
    payload: {
      schemaVersion: 1,
      sagas: {
        del1: {
          id: 'del1',
          recordVersion: 1,
          phase: 'prepared',
          updatedAt: STAMP,
        },
      },
    },
    pattern: /requires target\.parentId on write/,
  },
  {
    name: 'repaymentConfirmationSagas',
    payload: {
      schemaVersion: 1,
      sagas: {
        repay1: {
          id: 'repay1',
          recordVersion: 1,
          phase: 'prepared',
          updatedAt: STAMP,
        },
      },
    },
    pattern: /requires inflow\.id on write/,
  },
  {
    name: 'reimbursementLinkSagas',
    payload: {
      schemaVersion: 1,
      sagas: {
        link1: {
          id: 'link1',
          recordVersion: 1,
          action: 'link',
          phase: 'prepared',
          updatedAt: STAMP,
        },
      },
    },
    pattern: /requires inflowId on write/,
  },
  {
    name: 'transactionSagas',
    payload: {
      schemaVersion: 1,
      sagas: {
        saga1: {
          id: 'saga1',
          recordVersion: 2,
          phase: 'prepared',
          updatedAt: STAMP,
        },
      },
    },
    pattern: /requires original\.id on write/,
  },
];

for (const scenario of FAMILY_IDENTITY_WRITE_REJECTIONS) {
  test(`strict write rejects new ${scenario.name} record missing family identity`, (t) => {
    resetWriteGuards();
    const { env } = tempEnv(t);
    assert.throws(
      () => writeRuntimeState(scenario.name, scenario.payload, { env, enforceOwnership: false }),
      scenario.pattern,
    );
  });
}

test('strict write rejects incomplete new operationJournal record', (t) => {
  resetWriteGuards();
  const { env } = tempEnv(t);
  assert.throws(
    () => writeRuntimeState('operationJournal', {
      schemaVersion: 1,
      operations: {
        'idem-key-12345678': {
          key: 'idem-key-12345678',
          recordVersion: 2,
          fingerprint: 'a'.repeat(64),
          fingerprintVersion: 2,
          method: 'POST',
          route: '/api/v1/test',
          status: 'started',
          phase: 'started',
        },
      },
    }, { env, enforceOwnership: false }),
    /cannot write incomplete new operation/,
  );
});

test('strict write accepts complete new operationJournal record', (t) => {
  resetWriteGuards();
  const { env } = tempEnv(t);
  assert.doesNotThrow(() => writeRuntimeState('operationJournal', {
    schemaVersion: 1,
    operations: {
      'idem-key-12345678': {
        key: 'idem-key-12345678',
        recordVersion: 2,
        fingerprint: 'a'.repeat(64),
        fingerprintVersion: 2,
        method: 'POST',
        route: '/api/v1/test',
        status: 'started',
        phase: 'started',
        startedAt: STAMP,
        updatedAt: STAMP,
      },
    },
  }, { env, enforceOwnership: false }));
});

test('legacy-tolerant read allows rewriting incomplete saga with prior evidence', (t) => {
  resetWriteGuards();
  const { env } = tempEnv(t);
  const legacy = {
    schemaVersion: 1,
    sagas: {
      legacy1: { id: 'legacy1', phase: 'prepared', status: 'started' },
    },
  };
  writePrimary(env, 'bulkOperationSagas', legacy);
  const loaded = readRuntimeState('bulkOperationSagas', { env }).value;
  writeRuntimeState('bulkOperationSagas', loaded, { env, enforceOwnership: false });
  const again = readRuntimeState('bulkOperationSagas', { env }).value;
  assert.ok(again.sagas.legacy1 || again.sagas.legacy1 === undefined || Object.values(again.sagas).some((s) => s.id === 'legacy1'));
});

test('terminal saga pruning remains legal under strict write', (t) => {
  resetWriteGuards();
  const { env } = tempEnv(t);
  const stamp = STAMP;
  const original = {
    schemaVersion: 1,
    sagas: {
      done: {
        id: 'done',
        recordVersion: 1,
        kind: 'rules_apply',
        phase: 'completed',
        updatedAt: stamp,
        terminalAt: stamp,
        items: [],
      },
    },
  };
  writeRuntimeState('bulkOperationSagas', original, { env, enforceOwnership: false });
  writeRuntimeState('bulkOperationSagas', { schemaVersion: 1, sagas: {} }, { env });
  assert.deepEqual(readRuntimeState('bulkOperationSagas', { env }).value.sagas, {});
});

test('reject policy quarantines undeclared envelope top-level keys on read', (t) => {
  resetWriteGuards();
  const { env, dir } = tempEnv(t);
  writePrimary(env, 'accountOverrides', {
    schemaVersion: 2,
    accounts: {},
    undeclared: true,
  });
  assert.throws(() => readRuntimeState('accountOverrides', { env }), RuntimeStateError);
  assert.ok(fs.readdirSync(dir).some((entry) => entry.includes('.corrupt-')));
});

test('preserve policy round-trips undeclared top-level metadata', (t) => {
  resetWriteGuards();
  const { env } = tempEnv(t);
  const payload = {
    schemaVersion: 1,
    byTxn: {},
    auditStamp: STAMP,
    nested: { keep: true },
  };
  writeRuntimeState('receipts', payload, { env, enforceOwnership: false });
  const loaded = readRuntimeState('receipts', { env }).value;
  assert.equal(loaded.auditStamp, STAMP);
  assert.deepEqual(loaded.nested, { keep: true });
});

test('registry-wide policy matrix matches fixtures and production preserve metadata', () => {
  const { registryPolicyMatrix, LEGACY_MIGRATION_SHAPES } = require('../lib/runtime-state-field-policy');
  const matrix = registryPolicyMatrix();
  assert.equal(matrix.length, Object.keys(STATE_REGISTRY).length);
  for (const entry of matrix) {
    assert.ok(['reject', 'preserve-top-level'].includes(entry.policy));
    assert.ok(['array-root', 'open-map', 'envelope'].includes(entry.shape));
    assert.ok(Array.isArray(entry.legacyShapes));
    assert.ok(entry.legacyShapes.length > 0, `${entry.name} must declare explicit legacy migration shapes`);
    assert.deepEqual(entry.legacyShapes, LEGACY_MIGRATION_SHAPES[entry.name]);
    for (const shape of entry.legacyShapes) {
      assert.ok(shape.legacyShape);
      assert.ok(shape.consumed);
      assert.ok(shape.preservedAs);
      assert.ok(!/dropped/i.test(shape.consumed));
      assert.ok(!/dropped/i.test(shape.preservedAs));
    }
    const sample = FIXTURES[entry.name]?.current;
    if (sample == null) continue;
    if (entry.policy === 'preserve-top-level' && entry.shape === 'envelope') {
      const withMeta = { ...sample, fixtureMeta: { ok: true } };
      assert.doesNotThrow(() => {
        const migrated = RUNTIME_STATE_SCHEMAS[entry.name].migrate(withMeta).value;
        const { enforceUnknownFieldPolicy } = require('../lib/runtime-state-field-policy');
        enforceUnknownFieldPolicy(entry.name, withMeta, migrated, RUNTIME_STATE_SCHEMAS[entry.name]);
      });
    }
    if (entry.policy === 'reject' && entry.shape === 'envelope' && entry.allowedTopLevel) {
      const withExtra = { ...sample, undeclaredFixtureKey: true };
      if (entry.name === 'accountOverrides') {
        assert.throws(
          () => RUNTIME_STATE_SCHEMAS[entry.name].migrate(withExtra),
          /legacy payload is not migratable/,
        );
        continue;
      }
      assert.throws(() => {
        const migrated = RUNTIME_STATE_SCHEMAS[entry.name].migrate(withExtra).value;
        const { enforceUnknownFieldPolicy } = require('../lib/runtime-state-field-policy');
        enforceUnknownFieldPolicy(entry.name, withExtra, migrated, RUNTIME_STATE_SCHEMAS[entry.name]);
      }, /rejects unknown top-level field/);
    }
  }
});

function schemaFor(name) {
  return RUNTIME_STATE_SCHEMAS[name];
}

test('passkeyCredentials legacy wrapper unwraps losslessly', (t) => {
  resetWriteGuards();
  const { env } = tempEnv(t);
  writePrimary(env, 'passkeyCredentials', FIXTURES.passkeyCredentials.legacyWrapper);
  const loaded = readRuntimeState('passkeyCredentials', { env }).value;
  assert.deepEqual(loaded, FIXTURES.passkeyCredentials.current);
});

test('optional personalConfig owesConfig and truth sidecars accept JSON null root', (t) => {
  for (const name of ['personalConfig', 'owesConfig', 'owesTruth', 'venmoTruth']) {
    resetWriteGuards();
    const { env } = tempEnv(t);
    writePrimary(env, name, null);
    const result = readRuntimeState(name, { env });
    assert.equal(result.value, null);
    assert.equal(result.meta.source, 'primary');
  }
});

test('passkeyCredentials missing file defaults to empty array enrollment state', (t) => {
  resetWriteGuards();
  const { env } = tempEnv(t);
  const result = readRuntimeState('passkeyCredentials', { env });
  assert.deepEqual(result.value, []);
  assert.equal(result.meta.source, 'missing-default');
});

test('passkeyCredentials JSON null root fails closed', (t) => {
  resetWriteGuards();
  const { env } = tempEnv(t);
  writePrimary(env, 'passkeyCredentials', null);
  assert.throws(() => readRuntimeState('passkeyCredentials', { env }), RuntimeStateError);
});

test('non-optional JSON null root quarantines primary and recovers from last-good', (t) => {
  resetWriteGuards();
  const { env, dir } = tempEnv(t);
  writeLastGood(env, 'debtPlanner', FIXTURES.debtPlanner.current);
  writePrimary(env, 'debtPlanner', null);
  const result = readRuntimeState('debtPlanner', { env });
  assert.equal(result.meta.source, 'last-good');
  assert.deepEqual(result.value, FIXTURES.debtPlanner.current);
  assert.ok(fs.readdirSync(dir).some((entry) => entry.includes('.corrupt-')));
});

test('non-optional JSON null root without last-good blocks writes', (t) => {
  resetWriteGuards();
  const { env } = tempEnv(t);
  writePrimary(env, 'debtPlanner', null);
  assert.throws(() => readRuntimeState('debtPlanner', { env }), RuntimeStateError);
  assert.throws(
    () => writeRuntimeState('debtPlanner', FIXTURES.debtPlanner.current, { env }),
    (error) => error.code === 'RUNTIME_STATE_WRITE_BLOCKED',
  );
});

test('passkeyCredentials never uses last-good even when sidecar exists', (t) => {
  resetWriteGuards();
  const { env } = tempEnv(t);
  const { assertWritable } = require('../lib/runtime-state-store');
  writeLastGood(env, 'passkeyCredentials', FIXTURES.passkeyCredentials.current);
  writePrimary(env, 'passkeyCredentials', FIXTURES.passkeyCredentials.malformed);
  assert.throws(() => readRuntimeState('passkeyCredentials', { env }), RuntimeStateError);
  assert.throws(
    () => assertWritable(statePath('passkeyCredentials', env)),
    (error) => error.code === 'RUNTIME_STATE_WRITE_BLOCKED',
  );
});

test('accountOverrides flat legacy preserves recognized metadata alongside valid accounts', () => {
  const { migrateAccountOverrides } = require('../lib/account-overrides-schema');
  const accountId = '00000000-0000-4000-8000-000000000101';
  const mixed = migrateAccountOverrides({
    [accountId]: { hidden: true, role: 'operating_cash' },
    metadata: { writer: 'legacy-import', run: 3 },
    auditTrail: { importedAt: '2026-07-13T00:00:00.000Z' },
  });
  assert.deepEqual(mixed, {
    schemaVersion: 2,
    accounts: { [accountId]: { hidden: true, role: 'operating_cash' } },
    metadata: { writer: 'legacy-import', run: 3 },
    auditTrail: { importedAt: '2026-07-13T00:00:00.000Z' },
  });
});

test('accountOverrides flat legacy rejects ambiguous non-account keys', () => {
  const { migrateAccountOverrides } = require('../lib/account-overrides-schema');
  const accountId = '00000000-0000-4000-8000-000000000101';
  assert.equal(migrateAccountOverrides({ rogue: { hidden: true } }), null);
  assert.equal(migrateAccountOverrides({
    [accountId]: { hidden: true },
    rogue: { hidden: true },
  }), null);
  assert.equal(migrateAccountOverrides({ [accountId]: { notes: 'x' } }), null);
  assert.equal(migrateAccountOverrides({ acct1: { hidden: true } }), null);
});

test('accountOverrides v2 metadata round-trips through read write and backup validation', (t) => {
  resetWriteGuards();
  const { env } = tempEnv(t);
  const accountId = '00000000-0000-4000-8000-000000000202';
  const payload = {
    schemaVersion: 2,
    accounts: { [accountId]: { name: 'Cash', role: 'operating_cash' } },
    metadata: { writer: 'runtime-test', run: 9 },
  };
  writeRuntimeState('accountOverrides', payload, { env, enforceOwnership: false });
  const loaded = readRuntimeState('accountOverrides', { env }).value;
  assert.deepEqual(loaded.metadata, payload.metadata);
  writeRuntimeState('accountOverrides', {
    ...loaded,
    accounts: {
      ...loaded.accounts,
      [accountId]: { ...loaded.accounts[accountId], hidden: true },
    },
  }, { env, enforceOwnership: false });
  const roundTrip = readRuntimeState('accountOverrides', { env }).value;
  assert.deepEqual(roundTrip.metadata, payload.metadata);
  assert.equal(roundTrip.accounts[accountId].hidden, true);
  assert.doesNotThrow(() => validateBackupSidecar('account-overrides.json', roundTrip));
});

const PRESENT_WRONG_TYPE = {
  debtPlanner: { debts: 'bad' },
  events: { events: {} },
  investmentHoldings: { holdings: null },
  manualAssets: { items: false },
  phantomLog: { deleted: {} },
  phantomSeen: { seen: [] },
  receipts: { schemaVersion: 1, byTxn: [] },
  reimbursementSuggestions: { confirmed: [], dismissed: {} },
  reconciliation: { enabled: 'yes', months: {} },
  rules: { rules: {} },
  operationJournal: { schemaVersion: 1, operations: 'bad' },
  transactionSagas: { schemaVersion: 1, sagas: [] },
  transactionDeletionSagas: { schemaVersion: 1, sagas: null },
  bulkOperationSagas: { schemaVersion: 1, sagas: 'bad' },
  repaymentConfirmationSagas: { schemaVersion: 1, sagas: ['x'] },
  reimbursementLinkSagas: { schemaVersion: 1, sagas: false },
};

for (const [name, payload] of Object.entries(PRESENT_WRONG_TYPE)) {
  test(`present-but-wrong-type field quarantines ${name} without silent emptying`, (t) => {
    resetWriteGuards();
    const { env, dir } = tempEnv(t);
    const fixture = FIXTURES[name];
    writeLastGood(env, name, fixture.current);
    writePrimary(env, name, payload);
    const result = readRuntimeState(name, { env });
    assert.equal(result.meta.source, 'last-good');
    assert.deepEqual(result.value, fixture.current);
    assert.ok(fs.readdirSync(dir).some((entry) => entry.includes('.corrupt-')));
    if (name === 'operationJournal') {
      assert.ok(Object.keys(result.value.operations).length > 0);
    }
    if (name.endsWith('Sagas')) {
      assert.ok(Object.keys(result.value.sagas).length > 0);
    }
  });

  test(`present-but-wrong-type field blocks ${name} writes without last-good`, (t) => {
    resetWriteGuards();
    const { env } = tempEnv(t);
    writePrimary(env, name, payload);
    assert.throws(() => readRuntimeState(name, { env }), RuntimeStateError);
    assert.throws(
      () => writeRuntimeState(name, FIXTURES[name].current, { env }),
      (error) => error.code === 'RUNTIME_STATE_WRITE_BLOCKED',
    );
  });
}

test('operationJournal adversarial empty operations cannot erase active ownership on write', (t) => {
  resetWriteGuards();
  const { env } = tempEnv(t);
  const stamp = STAMP;
  const original = {
    schemaVersion: 1,
    operations: {
      'idem-key-12345678': {
        key: 'idem-key-12345678',
        recordVersion: 2,
        fingerprint: 'a'.repeat(64),
        fingerprintVersion: 2,
        method: 'POST',
        route: '/api/v1/test',
        status: 'started',
        phase: 'started',
        startedAt: stamp,
        updatedAt: stamp,
      },
    },
  };
  writeRuntimeState('operationJournal', original, { env, enforceOwnership: false });
  assert.throws(
    () => writeRuntimeState('operationJournal', { schemaVersion: 1, operations: {} }, { env }),
    /cannot drop a nonterminal operation/,
  );
});

test('bulkOperationSagas adversarial empty sagas cannot erase active ownership on write', (t) => {
  resetWriteGuards();
  const { env } = tempEnv(t);
  const original = COMPLETE_SAGA_FIXTURES.bulkOperationSagas;
  writeRuntimeState('bulkOperationSagas', original, { env, enforceOwnership: false });
  assert.throws(
    () => writeRuntimeState('bulkOperationSagas', { schemaVersion: 1, sagas: {} }, { env }),
    /cannot drop a nonterminal/,
  );
});

test('reimbursementLinkSagas adversarial empty sagas cannot erase active ownership on write', (t) => {
  resetWriteGuards();
  const { env } = tempEnv(t);
  const original = COMPLETE_SAGA_FIXTURES.reimbursementLinkSagas;
  writeRuntimeState('reimbursementLinkSagas', original, { env, enforceOwnership: false });
  assert.throws(
    () => writeRuntimeState('reimbursementLinkSagas', { schemaVersion: 1, sagas: {} }, { env }),
    /cannot drop a nonterminal/,
  );
});

test('repaymentConfirmationSagas adversarial empty sagas cannot erase active ownership on write', (t) => {
  resetWriteGuards();
  const { env } = tempEnv(t);
  const original = COMPLETE_SAGA_FIXTURES.repaymentConfirmationSagas;
  writeRuntimeState('repaymentConfirmationSagas', original, { env, enforceOwnership: false });
  assert.throws(
    () => writeRuntimeState('repaymentConfirmationSagas', { schemaVersion: 1, sagas: {} }, { env }),
    /cannot drop a nonterminal/,
  );
});
