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

async function request(base, route, { method = 'GET', key } = {}) {
  const response = await fetch(`${base}${route}`, {
    method,
    headers: {
      'X-Finance-Token': 'test-api-token',
      ...(key ? { 'Idempotency-Key': key } : {}),
    },
  });
  return { response, body: await response.json() };
}

test('DELETE journals local apply, sync uncertainty, and status-only recovery', async (t) => {
  const port = await unusedPort();
  const base = `http://127.0.0.1:${port}`;
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'darkfinances-deletion-operation-'));
  const dashboardRoot = path.resolve(__dirname, '..');
  const marker = path.join(dir, 'effects.log');
  const preload = path.join(dir, 'mock-data-module.js');
  fs.writeFileSync(preload, `
    const fs = require('fs');
    const path = require('path');
    const dataPath = require.resolve(path.join(process.env.TEST_DASHBOARD_ROOT, 'dataModule.js'));
    const mark = (value) => fs.appendFileSync(process.env.TEST_EFFECT_MARKER, value + '\\n');
    let currentId = null;
    const mock = new Proxy({
      initApi: async () => ({ ok: true }),
      shutdownApi: async () => ({ ok: true }),
      getHealth: () => ({ ready: true }),
      assertTransactionMutationAvailable: ({ ids }) => {
        currentId = String(ids[0]);
        mark('preflight:' + currentId);
      },
      deleteTransaction: async ({ id }) => {
        currentId = String(id);
        mark('local-delete:' + currentId);
        if (currentId === 'delete-throws') {
          mark('actual-delete-applied:' + currentId);
          throw new Error('delete response lost after apply');
        }
        return {
          ok: true,
          deleted: currentId,
          references: {
            receipts: 1,
            links: 0,
            suggestions: 0,
            reconciliation: 0,
            phantomSeen: 0,
      reviewState: 0,
            reviewState: 0,
          },
        };
      },
      syncNow: async () => {
        mark('sync:' + currentId);
        if (currentId === 'sync-fail') throw new Error('sync unavailable');
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
      OPERATION_JOURNAL_PATH: path.join(dir, 'operation-journal.json'),
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

  const successKey = 'delete-success';
  let result = await request(
    base,
    '/api/v1/transactions/success?accountId=account&date=2026-07-10',
    { method: 'DELETE', key: successKey },
  );
  assert.equal(result.response.status, 200);
  assert.deepEqual(result.body.data, {
    ok: true,
    deleted: 'success',
    references: {
      receipts: 1,
      links: 0,
      suggestions: 0,
      reconciliation: 0,
      phantomSeen: 0,
      reviewState: 0,
    },
  });
  assert.deepEqual(result.body.operation, { key: successKey, replayed: false });
  result = await request(base, `/api/v1/operations/${successKey}`);
  assert.equal(result.body.data.phase, 'completed');
  assert.equal(result.body.data.outcome, 'completed');

  const syncKey = 'delete-sync-failure';
  result = await request(
    base,
    '/api/v1/transactions/sync-fail?accountId=account&date=2026-07-10',
    { method: 'DELETE', key: syncKey },
  );
  assert.equal(result.response.status, 409);
  assert.equal(result.body.code, 'OUTCOME_UNKNOWN');
  result = await request(base, `/api/v1/operations/${syncKey}`);
  assert.equal(result.body.data.phase, 'sync_unknown');
  assert.equal(result.body.data.outcome, 'unknown');
  const effectsBeforeSyncRetry = fs.readFileSync(marker, 'utf8');
  result = await request(
    base,
    '/api/v1/transactions/sync-fail?accountId=account&date=2026-07-10',
    { method: 'DELETE', key: syncKey },
  );
  assert.equal(result.response.status, 409);
  assert.equal(result.body.code, 'OUTCOME_UNKNOWN');
  assert.equal(fs.readFileSync(marker, 'utf8'), effectsBeforeSyncRetry);

  const deleteKey = 'delete-response-lost';
  result = await request(
    base,
    '/api/v1/transactions/delete-throws?accountId=account&date=2026-07-10',
    { method: 'DELETE', key: deleteKey },
  );
  assert.equal(result.response.status, 409);
  assert.equal(result.body.code, 'OUTCOME_UNKNOWN');
  result = await request(base, `/api/v1/operations/${deleteKey}`);
  assert.equal(result.body.data.phase, 'started');
  assert.equal(result.body.data.outcome, 'unknown');
  const effectsBeforeDeleteRetry = fs.readFileSync(marker, 'utf8');
  result = await request(
    base,
    '/api/v1/transactions/delete-throws?accountId=account&date=2026-07-10',
    { method: 'DELETE', key: deleteKey },
  );
  assert.equal(result.response.status, 409);
  assert.equal(result.body.code, 'OUTCOME_UNKNOWN');
  assert.equal(fs.readFileSync(marker, 'utf8'), effectsBeforeDeleteRetry);

  const effects = fs.readFileSync(marker, 'utf8').trim().split('\n');
  assert.deepEqual(effects.slice(0, 3), [
    'preflight:success',
    'local-delete:success',
    'sync:success',
  ]);
  assert.equal(effects.filter((value) => value === 'local-delete:sync-fail').length, 1);
  assert.equal(effects.filter((value) => value === 'sync:sync-fail').length, 1);
  assert.equal(effects.filter((value) => value === 'local-delete:delete-throws').length, 1);
  assert.equal(effects.filter((value) => value === 'actual-delete-applied:delete-throws').length, 1);
});
