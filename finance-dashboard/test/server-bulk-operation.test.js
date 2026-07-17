'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const os = require('os');
const path = require('path');
const net = require('net');
const { spawn } = require('child_process');

async function unusedPort() {
  return new Promise((resolve, reject) => {
    const server = net.createServer();
    server.once('error', reject);
    server.listen(0, '127.0.0.1', () => {
      const { port } = server.address();
      server.close((error) => error ? reject(error) : resolve(port));
    });
  });
}

async function waitForServer(base, child, logs) {
  for (let attempt = 0; attempt < 100; attempt += 1) {
    if (child.exitCode != null) throw new Error(`server exited early: ${logs.value}`);
    try {
      const response = await fetch(`${base}/api/v1/ping`, {
        headers: { 'X-Finance-Token': 'test-api-token' },
      });
      if (response.status === 200) return;
    } catch (_) {}
    await new Promise((resolve) => setTimeout(resolve, 25));
  }
  throw new Error(`server did not start: ${logs.value}`);
}

test('rules apply binds operation journal to bulk saga identity', async (t) => {
  const port = await unusedPort();
  const base = `http://127.0.0.1:${port}`;
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'darkfinances-bulk-operation-'));
  const dashboardRoot = path.resolve(__dirname, '..');
  const journalPath = path.join(dir, 'operation-journal.json');
  const bulkPath = path.join(dir, 'bulk-operation-sagas.json');
  const marker = path.join(dir, 'effects.log');
  const preload = path.join(dir, 'mock-data-module.js');
  fs.writeFileSync(preload, `
    const fs = require('fs');
    const path = require('path');
    const dataPath = require.resolve(path.join(process.env.TEST_DASHBOARD_ROOT, 'dataModule.js'));
    const mark = (value) => fs.appendFileSync(process.env.TEST_EFFECT_MARKER, value + '\\n');
    let bulkPhase = 'sync_pending';
    const mock = new Proxy({
      initApi: async () => ({ ok: true }),
      shutdownApi: async () => ({ ok: true }),
      getHealth: () => ({ ready: true }),
      applyRules: async ({ operationKey, journalBinding } = {}) => {
        mark('apply:' + operationKey);
        bulkPhase = 'sync_pending';
        const binding = journalBinding || {};
        fs.writeFileSync(process.env.BULK_OPERATION_SAGAS_PATH, JSON.stringify({
          schemaVersion: 1,
          sagas: {
            bulk1: {
              id: 'bulk1',
              recordVersion: 1,
              kind: 'rules_apply',
              operationKey,
              operationJournalFingerprint: binding.fingerprint || null,
              operationJournalFingerprintVersion: binding.fingerprintVersion ?? null,
              operationJournalMethod: binding.method || 'POST',
              operationJournalRoute: binding.route || '/api/v1/rules/apply',
              phase: bulkPhase,
              plan: { items: [{ globalIndex: 0, itemType: 'category_update', stageId: 'rule:r1' }] },
              itemOutcomes: { '0': { status: 'completed' } },
              auditOutcome: { status: 'in_progress', applied: 1, failed: 0, skipped: 0, failedItems: [] },
            },
          },
        }, null, 2) + '\\n');
        return { ok: false, needsSync: true, applied: 1, settleUpsMoved: 0, status: 'in_progress' };
      },
      getBulkOperationResult: (operationKey) => {
        mark('result:' + operationKey);
        return {
          ok: true,
          needsSync: false,
          applied: 1,
          settleUpsMoved: 0,
          status: 'completed',
          auditOutcome: { status: 'completed', applied: 1, failed: 0, skipped: 0, failedItems: [] },
        };
      },
      syncNow: async () => {
        mark('sync');
        bulkPhase = 'completed';
        const store = JSON.parse(fs.readFileSync(process.env.BULK_OPERATION_SAGAS_PATH, 'utf8'));
        const saga = Object.values(store.sagas)[0];
        saga.phase = 'completed';
        saga.auditOutcome = { status: 'completed', applied: 1, failed: 0, skipped: 0, failedItems: [] };
        fs.writeFileSync(process.env.BULK_OPERATION_SAGAS_PATH, JSON.stringify(store, null, 2) + '\\n');
      },
    }, {
      get(target, property) {
        if (property in target) return target[property];
        return async () => [];
      },
    });
    require.cache[dataPath] = {
      id: dataPath,
      filename: dataPath,
      loaded: true,
      exports: mock,
      children: [],
      paths: [],
    };
  `);

  const logs = { value: '' };
  const child = spawn(process.execPath, ['server.js'], {
    cwd: dashboardRoot,
    env: {
      ...process.env,
      NODE_ENV: 'test',
      DEMO_ONLY: '1',
      NODE_OPTIONS: `${process.env.NODE_OPTIONS || ''} --require=${preload}`.trim(),
      PORT: String(port),
      PUBLIC_ORIGIN: `http://localhost:${port}`,
      WEBAUTHN_ORIGIN: `http://localhost:${port}`,
      WEBAUTHN_RP_ID: 'localhost',
      FINANCE_API_TOKEN: 'test-api-token',
      SESSION_SECRET: 'test-session-secret-with-sufficient-length',
      SESSION_DIR: path.join(dir, 'sessions'),
      OPERATION_JOURNAL_PATH: journalPath,
      BULK_OPERATION_SAGAS_PATH: bulkPath,
      PASSKEY_CREDENTIALS_FILE: path.join(dir, 'credentials.json'),
      TEST_DASHBOARD_ROOT: dashboardRoot,
      TEST_EFFECT_MARKER: marker,
    },
    stdio: ['ignore', 'pipe', 'pipe'],
  });
  child.stdout.on('data', (chunk) => { logs.value += chunk; });
  child.stderr.on('data', (chunk) => { logs.value += chunk; });
  t.after(() => {
    child.kill('SIGTERM');
    fs.rmSync(dir, { recursive: true, force: true });
  });

  await waitForServer(base, child, logs);
  const key = 'bulk-rules-apply-journal';
  const response = await fetch(`${base}/api/v1/rules/apply`, {
    method: 'POST',
    headers: {
      'X-Finance-Token': 'test-api-token',
      'Idempotency-Key': key,
    },
  });
  assert.equal(response.status, 200);
  const body = await response.json();
  assert.equal(body.data.ok, true);
  assert.equal(body.data.status, 'completed');
  assert.equal(body.data.needsSync, false);
  const journal = JSON.parse(fs.readFileSync(journalPath, 'utf8'));
  const bulk = JSON.parse(fs.readFileSync(bulkPath, 'utf8'));
  assert.equal(journal.operations[key].phase, 'completed');
  assert.equal(journal.operations[key].result.ok, true);
  assert.equal(journal.operations[key].result.status, 'completed');
  assert.equal(Object.values(bulk.sagas)[0].operationKey, key);
  assert.match(fs.readFileSync(marker, 'utf8'), /apply:bulk-rules-apply-journal/);
  assert.match(fs.readFileSync(marker, 'utf8'), /sync/);
  assert.match(fs.readFileSync(marker, 'utf8'), /result:bulk-rules-apply-journal/);

  const replay = await fetch(`${base}/api/v1/rules/apply`, {
    method: 'POST',
    headers: {
      'X-Finance-Token': 'test-api-token',
      'Idempotency-Key': key,
    },
  });
  assert.equal(replay.status, 200);
  const replayBody = await replay.json();
  assert.equal(replayBody.data.ok, true);
  assert.equal(replayBody.data.status, 'completed');
});

test('orphan operation journal reconciles from recovered bulk on status poll and replay', async (t) => {
  const port = await unusedPort();
  const base = `http://127.0.0.1:${port}`;
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'darkfinances-bulk-orphan-journal-'));
  const dashboardRoot = path.resolve(__dirname, '..');
  const journalPath = path.join(dir, 'operation-journal.json');
  const bulkPath = path.join(dir, 'bulk-operation-sagas.json');
  const marker = path.join(dir, 'effects.log');
  const preload = path.join(dir, 'mock-data-module.js');
  fs.writeFileSync(preload, `
    const fs = require('fs');
    const path = require('path');
    const dataPath = require.resolve(path.join(process.env.TEST_DASHBOARD_ROOT, 'dataModule.js'));
    const sagaPath = require.resolve(path.join(process.env.TEST_DASHBOARD_ROOT, 'lib/bulk-operation-saga.js'));
    const { createBulkOperationSaga } = require(sagaPath);
    const mark = (value) => fs.appendFileSync(process.env.TEST_EFFECT_MARKER, value + '\\n');
    const bulkPath = process.env.BULK_OPERATION_SAGAS_PATH;
    const noopPaths = {
      rules: path.join(path.dirname(bulkPath), 'rules.json'),
      phantomSeen: path.join(path.dirname(bulkPath), 'phantom-seen.json'),
      phantomLog: path.join(path.dirname(bulkPath), 'phantom-log.json'),
    };
    for (const [name, filePath] of Object.entries(noopPaths)) {
      if (!fs.existsSync(filePath)) {
        fs.writeFileSync(filePath, JSON.stringify(name === 'rules' ? { rules: [] } : name === 'phantomSeen' ? { seen: {} } : { deleted: [] }));
      }
    }
    const manager = () => createBulkOperationSaga({
      sagaPath: bulkPath,
      readRules: () => JSON.parse(fs.readFileSync(noopPaths.rules, 'utf8')),
      writeRules: (store) => fs.writeFileSync(noopPaths.rules, JSON.stringify(store)),
      readPhantomSeen: () => JSON.parse(fs.readFileSync(noopPaths.phantomSeen, 'utf8')),
      writePhantomSeen: (store) => fs.writeFileSync(noopPaths.phantomSeen, JSON.stringify(store)),
      readPhantomLog: () => JSON.parse(fs.readFileSync(noopPaths.phantomLog, 'utf8')),
      writePhantomLog: (store) => fs.writeFileSync(noopPaths.phantomLog, JSON.stringify(store)),
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
        const next = new Date(date + 'T12:00:00.000Z');
        next.setUTCDate(next.getUTCDate() + delta);
        return next.toISOString().slice(0, 10);
      },
    });
    const mock = new Proxy({
      initApi: async () => ({ ok: true }),
      shutdownApi: async () => ({ ok: true }),
      getHealth: () => ({ ready: true }),
      syncNow: async () => { mark('sync'); },
      applyRules: async ({ operationKey, journalBinding } = {}) => {
        mark('apply:' + operationKey);
        const binding = journalBinding || {};
        fs.writeFileSync(bulkPath, JSON.stringify({
          schemaVersion: 1,
          sagas: {
            bulk1: {
              id: 'bulk1',
              recordVersion: 1,
              kind: 'rules_apply',
              operationKey,
              operationJournalFingerprint: binding.fingerprint || null,
              operationJournalFingerprintVersion: binding.fingerprintVersion ?? null,
              operationJournalMethod: binding.method || 'POST',
              operationJournalRoute: binding.route || '/api/v1/rules/apply',
              phase: 'sync_pending',
              plan: {
                items: [
                  { globalIndex: 0, itemType: 'category_update', stageId: 'rule:r1' },
                  { globalIndex: 1, itemType: 'category_update', stageId: 'rule:r2' },
                ],
              },
              itemOutcomes: { '0': { status: 'completed' } },
              auditOutcome: { status: 'in_progress', applied: 1, failed: 0, skipped: 0, failedItems: [] },
            },
          },
        }, null, 2) + '\\n');
        throw new Error('bulk item 1 failed before journal checkpoint');
      },
      assertBulkOperationJournalAdmission: (args) => manager().assertJournalAdmission(args),
      proveBulkOperationJournalCompletion: (operationKey, journalOperation) =>
        manager().proveTerminalJournalCompletion(operationKey, journalOperation),
      getBulkOperationResult: (operationKey) => manager().resultForOperationKey(operationKey),
    }, {
      get(target, property) {
        if (property in target) return target[property];
        return async () => [];
      },
    });
    require.cache[dataPath] = {
      id: dataPath,
      filename: dataPath,
      loaded: true,
      exports: mock,
      children: [],
      paths: [],
    };
  `);

  const logs = { value: '' };
  const child = spawn(process.execPath, ['server.js'], {
    cwd: dashboardRoot,
    env: {
      ...process.env,
      NODE_ENV: 'test',
      DEMO_ONLY: '1',
      NODE_OPTIONS: `${process.env.NODE_OPTIONS || ''} --require=${preload}`.trim(),
      PORT: String(port),
      PUBLIC_ORIGIN: `http://localhost:${port}`,
      WEBAUTHN_ORIGIN: `http://localhost:${port}`,
      WEBAUTHN_RP_ID: 'localhost',
      FINANCE_API_TOKEN: 'test-api-token',
      SESSION_SECRET: 'test-session-secret-with-sufficient-length',
      SESSION_DIR: path.join(dir, 'sessions'),
      OPERATION_JOURNAL_PATH: journalPath,
      BULK_OPERATION_SAGAS_PATH: bulkPath,
      PASSKEY_CREDENTIALS_FILE: path.join(dir, 'credentials.json'),
      TEST_DASHBOARD_ROOT: dashboardRoot,
      TEST_EFFECT_MARKER: marker,
    },
    stdio: ['ignore', 'pipe', 'pipe'],
  });
  child.stdout.on('data', (chunk) => { logs.value += chunk; });
  child.stderr.on('data', (chunk) => { logs.value += chunk; });
  t.after(() => {
    child.kill('SIGTERM');
    fs.rmSync(dir, { recursive: true, force: true });
  });

  await waitForServer(base, child, logs);
  const key = 'bulk-orphan-journal-key';
  const failed = await fetch(`${base}/api/v1/rules/apply`, {
    method: 'POST',
    headers: {
      'X-Finance-Token': 'test-api-token',
      'Idempotency-Key': key,
    },
  });
  assert.equal(failed.status, 409);
  const journalAfterFailure = JSON.parse(fs.readFileSync(journalPath, 'utf8'));
  assert.equal(journalAfterFailure.operations[key].phase, 'started');

  const recoveredBulk = JSON.parse(fs.readFileSync(bulkPath, 'utf8'));
  const saga = recoveredBulk.sagas.bulk1;
  saga.phase = 'completed';
  saga.itemOutcomes['1'] = { status: 'completed' };
  saga.auditOutcome = { status: 'completed', applied: 2, failed: 0, skipped: 0, failedItems: [] };
  saga.syncedAt = new Date().toISOString();
  fs.writeFileSync(bulkPath, JSON.stringify(recoveredBulk, null, 2));

  const statusResponse = await fetch(`${base}/api/v1/operations/${encodeURIComponent(key)}`, {
    headers: { 'X-Finance-Token': 'test-api-token' },
  });
  assert.equal(statusResponse.status, 200);
  const statusBody = await statusResponse.json();
  assert.equal(statusBody.data.status, 'completed');
  assert.equal(statusBody.data.outcome, 'completed');
  assert.equal(statusBody.data.result.ok, true);
  assert.equal(statusBody.data.result.status, 'completed');
  const journalAfterStatus = JSON.parse(fs.readFileSync(journalPath, 'utf8'));
  assert.equal(journalAfterStatus.operations[key].phase, 'completed');

  const replay = await fetch(`${base}/api/v1/rules/apply`, {
    method: 'POST',
    headers: {
      'X-Finance-Token': 'test-api-token',
      'Idempotency-Key': key,
    },
  });
  assert.equal(replay.status, 200);
  const replayBody = await replay.json();
  assert.equal(replayBody.data.ok, true);
  assert.equal(replayBody.data.status, 'completed');
  assert.equal(replayBody.operation.replayed, true);
  const markerText = fs.readFileSync(marker, 'utf8');
  assert.equal((markerText.match(/apply:bulk-orphan-journal-key/g) || []).length, 1);
});

test('pruned journal cannot reconcile a different fingerprint from stale bulk evidence', async (t) => {
  const port = await unusedPort();
  const base = `http://127.0.0.1:${port}`;
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'darkfinances-bulk-prune-attack-'));
  const dashboardRoot = path.resolve(__dirname, '..');
  const journalPath = path.join(dir, 'operation-journal.json');
  const bulkPath = path.join(dir, 'bulk-operation-sagas.json');
  const marker = path.join(dir, 'effects.log');
  const preload = path.join(dir, 'mock-data-module.js');
  fs.writeFileSync(preload, `
    const fs = require('fs');
    const path = require('path');
    const dataPath = require.resolve(path.join(process.env.TEST_DASHBOARD_ROOT, 'dataModule.js'));
    const sagaPath = require.resolve(path.join(process.env.TEST_DASHBOARD_ROOT, 'lib/bulk-operation-saga.js'));
    const { createBulkOperationSaga } = require(sagaPath);
    const mark = (value) => fs.appendFileSync(process.env.TEST_EFFECT_MARKER, value + '\\n');
    const bulkPath = process.env.BULK_OPERATION_SAGAS_PATH;
    const manager = () => createBulkOperationSaga({
      sagaPath: bulkPath,
      readRules: () => ({ rules: [] }),
      writeRules: () => {},
      readPhantomSeen: () => ({ seen: {} }),
      writePhantomSeen: () => {},
      readPhantomLog: () => ({ deleted: [] }),
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
        const next = new Date(String(date) + 'T12:00:00.000Z');
        next.setUTCDate(next.getUTCDate() + delta);
        return next.toISOString().slice(0, 10);
      },
    });
    const mock = new Proxy({
      initApi: async () => ({ ok: true }),
      shutdownApi: async () => ({ ok: true }),
      getHealth: () => ({ ready: true }),
      syncNow: async () => { mark('sync'); },
      applyRules: async ({ operationKey, journalBinding } = {}) => {
        const binding = journalBinding || {};
        let existing = null;
        if (fs.existsSync(bulkPath)) {
          existing = Object.values(JSON.parse(fs.readFileSync(bulkPath, 'utf8')).sagas || {})[0] || null;
        }
        if (existing?.phase === 'completed'
          && existing.operationKey === operationKey
          && existing.operationJournalFingerprint === (binding.fingerprint || null)) {
          return { ok: true, needsSync: false, applied: 0, settleUpsMoved: 0, status: 'completed' };
        }
        mark('apply:' + operationKey);
        fs.writeFileSync(bulkPath, JSON.stringify({
          schemaVersion: 1,
          sagas: {
            bulk1: {
              id: 'bulk1',
              recordVersion: 1,
              kind: 'rules_apply',
              operationKey,
              operationJournalFingerprint: binding.fingerprint || null,
              operationJournalFingerprintVersion: binding.fingerprintVersion ?? null,
              operationJournalMethod: binding.method || 'POST',
              operationJournalRoute: binding.route || '/api/v1/rules/apply',
              phase: 'completed',
              plan: { items: [] },
              itemOutcomes: {},
              auditOutcome: { status: 'completed', applied: 0, failed: 0, skipped: 0, failedItems: [] },
            },
          },
        }, null, 2) + '\\n');
        return { ok: true, needsSync: false, applied: 0, settleUpsMoved: 0, status: 'completed' };
      },
      assertBulkOperationJournalAdmission: (args) => manager().assertJournalAdmission(args),
      proveBulkOperationJournalCompletion: (operationKey, journalOperation) =>
        manager().proveTerminalJournalCompletion(operationKey, journalOperation),
      getBulkOperationResult: (operationKey) => manager().resultForOperationKey(operationKey),
    }, {
      get(target, property) {
        if (property in target) return target[property];
        return async () => [];
      },
    });
    require.cache[dataPath] = { id: dataPath, filename: dataPath, loaded: true, exports: mock, children: [], paths: [] };
  `);
  const logs = { value: '' };
  const child = spawn(process.execPath, ['server.js'], {
    cwd: dashboardRoot,
    env: {
      ...process.env,
      NODE_ENV: 'test',
      DEMO_ONLY: '1',
      NODE_OPTIONS: `${process.env.NODE_OPTIONS || ''} --require=${preload}`.trim(),
      PORT: String(port),
      PUBLIC_ORIGIN: `http://localhost:${port}`,
      WEBAUTHN_ORIGIN: `http://localhost:${port}`,
      WEBAUTHN_RP_ID: 'localhost',
      FINANCE_API_TOKEN: 'test-api-token',
      SESSION_SECRET: 'test-session-secret-with-sufficient-length',
      SESSION_DIR: path.join(dir, 'sessions'),
      OPERATION_JOURNAL_PATH: journalPath,
      BULK_OPERATION_SAGAS_PATH: bulkPath,
      PASSKEY_CREDENTIALS_FILE: path.join(dir, 'credentials.json'),
      TEST_DASHBOARD_ROOT: dashboardRoot,
      TEST_EFFECT_MARKER: marker,
    },
    stdio: ['ignore', 'pipe', 'pipe'],
  });
  child.stdout.on('data', (chunk) => { logs.value += chunk; });
  child.stderr.on('data', (chunk) => { logs.value += chunk; });
  t.after(() => {
    child.kill('SIGTERM');
    fs.rmSync(dir, { recursive: true, force: true });
  });
  await waitForServer(base, child, logs);

  const key = 'prune-attack-key';
  const first = await fetch(`${base}/api/v1/rules/apply`, {
    method: 'POST',
    headers: { 'X-Finance-Token': 'test-api-token', 'Idempotency-Key': key },
  });
  assert.equal(first.status, 200);
  const bulkAfterA = JSON.parse(fs.readFileSync(bulkPath, 'utf8'));
  const boundFingerprint = bulkAfterA.sagas.bulk1.operationJournalFingerprint;
  assert.ok(boundFingerprint);

  const operations = {};
  for (let index = 0; index < 1001; index += 1) {
    const fillerKey = `filler-${String(index).padStart(4, '0')}`;
    operations[fillerKey] = {
      key: fillerKey,
      recordVersion: 2,
      fingerprintVersion: 2,
      fingerprint: `${String(index).padStart(64, '0')}`,
      method: 'POST',
      route: '/api/v1/ping',
      status: 'completed',
      phase: 'completed',
      startedAt: '2026-07-10T00:00:00.000Z',
      updatedAt: '2026-07-10T00:00:00.000Z',
      completedAt: '2026-07-10T00:00:00.000Z',
      provisionalResult: { ok: true },
      localAppliedAt: '2026-07-10T00:00:00.000Z',
      result: { ok: true },
    };
  }
  fs.writeFileSync(journalPath, JSON.stringify({ schemaVersion: 1, operations }, null, 2));
  assert.equal(JSON.parse(fs.readFileSync(journalPath, 'utf8')).operations[key], undefined);

  const replaySame = await fetch(`${base}/api/v1/rules/apply`, {
    method: 'POST',
    headers: { 'X-Finance-Token': 'test-api-token', 'Idempotency-Key': key },
  });
  assert.equal(replaySame.status, 200);
  const replayBody = await replaySame.json();
  assert.equal(replayBody.data.status, 'completed');
  assert.equal((fs.readFileSync(marker, 'utf8').match(/apply:prune-attack-key/g) || []).length, 1);

  fs.writeFileSync(journalPath, JSON.stringify({ schemaVersion: 1, operations }, null, 2));

  const markerBefore = fs.readFileSync(marker, 'utf8');
  const attack = await fetch(`${base}/api/v1/rules/apply?variant=b`, {
    method: 'POST',
    headers: { 'X-Finance-Token': 'test-api-token', 'Idempotency-Key': key },
  });
  assert.equal(attack.status, 409);
  const attackBody = await attack.json();
  assert.equal(attackBody.code, 'IDEMPOTENCY_KEY_REUSED');
  assert.equal(fs.readFileSync(marker, 'utf8'), markerBefore);
  const bulkAfterAttack = JSON.parse(fs.readFileSync(bulkPath, 'utf8'));
  assert.equal(bulkAfterAttack.sagas.bulk1.operationJournalFingerprint, boundFingerprint);
  assert.equal(bulkAfterAttack.sagas.bulk1.phase, 'completed');
});

test('concurrent same-key bulk mutations execute one handler and preserve journal writes', async (t) => {
  const port = await unusedPort();
  const base = `http://127.0.0.1:${port}`;
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'darkfinances-bulk-concurrency-'));
  const dashboardRoot = path.resolve(__dirname, '..');
  const journalPath = path.join(dir, 'operation-journal.json');
  const bulkPath = path.join(dir, 'bulk-operation-sagas.json');
  const marker = path.join(dir, 'effects.log');
  const preload = path.join(dir, 'mock-data-module.js');
  fs.writeFileSync(preload, `
    const fs = require('fs');
    const path = require('path');
    const dataPath = require.resolve(path.join(process.env.TEST_DASHBOARD_ROOT, 'dataModule.js'));
    const sagaPath = require.resolve(path.join(process.env.TEST_DASHBOARD_ROOT, 'lib/bulk-operation-saga.js'));
    const { createBulkOperationSaga } = require(sagaPath);
    const mark = (value) => fs.appendFileSync(process.env.TEST_EFFECT_MARKER, value + '\\n');
    const bulkPath = process.env.BULK_OPERATION_SAGAS_PATH;
    const manager = () => createBulkOperationSaga({
      sagaPath: bulkPath,
      readRules: () => ({ rules: [] }),
      writeRules: () => {},
      readPhantomSeen: () => ({ seen: {} }),
      writePhantomSeen: () => {},
      readPhantomLog: () => ({ deleted: [] }),
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
        const next = new Date(String(date) + 'T12:00:00.000Z');
        next.setUTCDate(next.getUTCDate() + delta);
        return next.toISOString().slice(0, 10);
      },
    });
    const mock = new Proxy({
      initApi: async () => ({ ok: true }),
      shutdownApi: async () => ({ ok: true }),
      getHealth: () => ({ ready: true }),
      syncNow: async () => { mark('sync'); },
      applyRules: async ({ operationKey, journalBinding } = {}) => {
        mark('apply:' + operationKey);
        await new Promise((resolve) => setTimeout(resolve, 40));
        const binding = journalBinding || {};
        fs.writeFileSync(bulkPath, JSON.stringify({
          schemaVersion: 1,
          sagas: {
            bulk1: {
              id: 'bulk1',
              recordVersion: 1,
              kind: 'rules_apply',
              operationKey,
              operationJournalFingerprint: binding.fingerprint || null,
              operationJournalFingerprintVersion: binding.fingerprintVersion ?? null,
              operationJournalMethod: binding.method || 'POST',
              operationJournalRoute: binding.route || '/api/v1/rules/apply',
              phase: 'completed',
              plan: { items: [] },
              itemOutcomes: {},
              auditOutcome: { status: 'completed', applied: 0, failed: 0, skipped: 0, failedItems: [] },
            },
          },
        }, null, 2) + '\\n');
        return { ok: true, needsSync: false, applied: 0, settleUpsMoved: 0, status: 'completed' };
      },
      assertBulkOperationJournalAdmission: (args) => manager().assertJournalAdmission(args),
      proveBulkOperationJournalCompletion: (operationKey, journalOperation) =>
        manager().proveTerminalJournalCompletion(operationKey, journalOperation),
      getBulkOperationResult: (operationKey) => manager().resultForOperationKey(operationKey),
    }, {
      get(target, property) {
        if (property in target) return target[property];
        return async () => [];
      },
    });
    require.cache[dataPath] = { id: dataPath, filename: dataPath, loaded: true, exports: mock, children: [], paths: [] };
  `);
  const logs = { value: '' };
  const child = spawn(process.execPath, ['server.js'], {
    cwd: dashboardRoot,
    env: {
      ...process.env,
      NODE_ENV: 'test',
      DEMO_ONLY: '1',
      NODE_OPTIONS: `${process.env.NODE_OPTIONS || ''} --require=${preload}`.trim(),
      PORT: String(port),
      PUBLIC_ORIGIN: `http://localhost:${port}`,
      WEBAUTHN_ORIGIN: `http://localhost:${port}`,
      WEBAUTHN_RP_ID: 'localhost',
      FINANCE_API_TOKEN: 'test-api-token',
      SESSION_SECRET: 'test-session-secret-with-sufficient-length',
      SESSION_DIR: path.join(dir, 'sessions'),
      OPERATION_JOURNAL_PATH: journalPath,
      BULK_OPERATION_SAGAS_PATH: bulkPath,
      PASSKEY_CREDENTIALS_FILE: path.join(dir, 'credentials.json'),
      TEST_DASHBOARD_ROOT: dashboardRoot,
      TEST_EFFECT_MARKER: marker,
    },
    stdio: ['ignore', 'pipe', 'pipe'],
  });
  child.stdout.on('data', (chunk) => { logs.value += chunk; });
  child.stderr.on('data', (chunk) => { logs.value += chunk; });
  t.after(() => {
    child.kill('SIGTERM');
    fs.rmSync(dir, { recursive: true, force: true });
  });
  await waitForServer(base, child, logs);

  const key = 'concurrent-bulk-key';
  const headers = { 'X-Finance-Token': 'test-api-token', 'Idempotency-Key': key };
  const [first, second, statusDuring] = await Promise.all([
    fetch(`${base}/api/v1/rules/apply`, { method: 'POST', headers }),
    fetch(`${base}/api/v1/rules/apply`, { method: 'POST', headers }),
    fetch(`${base}/api/v1/operations/${encodeURIComponent(key)}`, { headers: { 'X-Finance-Token': 'test-api-token' } }),
  ]);
  assert.equal(first.status, 200);
  const secondBody = await second.json();
  assert.equal(second.status, 200);
  assert.equal(secondBody.operation.replayed, true);
  assert.equal((fs.readFileSync(marker, 'utf8').match(/apply:concurrent-bulk-key/g) || []).length, 1);
  const journal = JSON.parse(fs.readFileSync(journalPath, 'utf8'));
  assert.equal(journal.operations[key].phase, 'completed');
  if (statusDuring.status === 200) {
    const statusBody = await statusDuring.json();
    assert.ok(['started', 'completed'].includes(statusBody.data.status));
  }
});
