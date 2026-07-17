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

async function request(base, route, {
  method = 'GET',
  key,
  body,
} = {}) {
  const response = await fetch(`${base}${route}`, {
    method,
    headers: {
      'X-Finance-Token': 'test-api-token',
      ...(key ? { 'Idempotency-Key': key } : {}),
      ...(body === undefined ? {} : { 'Content-Type': 'application/json' }),
    },
    ...(body === undefined ? {} : { body: JSON.stringify(body) }),
  });
  return { response, body: await response.json() };
}

test('delete and replacement ownership conflicts are terminal before operation effects', async (t) => {
  const port = await unusedPort();
  const base = `http://127.0.0.1:${port}`;
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'darkfinances-deletion-conflict-'));
  const dashboardRoot = path.resolve(__dirname, '..');
  const marker = path.join(dir, 'effects.log');
  const preload = path.join(dir, 'mock-data-module.js');
  fs.writeFileSync(preload, `
    const fs = require('fs');
    const path = require('path');
    const dataPath = require.resolve(path.join(process.env.TEST_DASHBOARD_ROOT, 'dataModule.js'));
    const { KnownPreApplyError } = require(path.join(process.env.TEST_DASHBOARD_ROOT, 'lib/errors.js'));
    const mark = (value) => fs.appendFileSync(process.env.TEST_EFFECT_MARKER, value + '\\n');
    const conflict = (kind) => {
      if (kind === 'replacement') {
        throw new KnownPreApplyError('A replacement for this transaction is already in progress', {
          code: 'TRANSACTION_REPLACEMENT_IN_PROGRESS',
          status: 409,
        });
      }
      throw new KnownPreApplyError('A deletion for this transaction is already in progress', {
        code: 'TRANSACTION_DELETION_IN_PROGRESS',
        status: 409,
      });
    };
    const mock = new Proxy({
      initApi: async () => ({ ok: true }),
      shutdownApi: async () => ({ ok: true }),
      getHealth: () => ({ ready: true }),
      assertTransactionMutationAvailable: ({ ids = [] }) => {
        const id = ids.filter(Boolean).map(String).find((value) =>
          value === 'replacement-owned' || value === 'delete-owned');
        mark('mutation-preflight:' + ids.filter(Boolean).join(','));
        if (id === 'replacement-owned') conflict('replacement');
        if (id === 'delete-owned') conflict('deletion');
      },
      assertTransactionDeletionAvailable(options) {
        return this.assertTransactionMutationAvailable(options);
      },
      assertTransactionReplacementAvailable: ({ ids }) => {
        const id = String(ids[0]);
        mark('replacement-preflight:' + id);
        if (id === 'delete-owned') conflict('deletion');
      },
      deleteTransaction: async ({ id }) => {
        mark('delete-mutation:' + id);
        return { ok: true, deleted: id, references: {} };
      },
      splitTransaction: async ({ id }) => {
        mark('split-mutation:' + id);
        return { ok: true, id };
      },
      setTransactionCategory: async ({ id }) => { mark('category-mutation:' + id); },
      setTransactionDate: async ({ id }) => { mark('date-mutation:' + id); },
      addReceipt: async ({ txnId }) => { mark('receipt-mutation:' + txnId); },
      addReimbLink: async ({ inflow }) => { mark('link-mutation:' + inflow.id); },
      setReconcileItem: async ({ id }) => { mark('reconciliation-mutation:' + id); },
      assertReceiptMutationAvailable: () => {},
      syncNow: async () => { mark('sync'); },
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

  const replacementKey = 'delete-blocked-by-replacement';
  let result = await request(
    base,
    '/api/v1/transactions/replacement-owned?accountId=account&date=2026-07-10',
    { method: 'DELETE', key: replacementKey },
  );
  assert.equal(result.response.status, 409);
  assert.equal(result.body.code, 'TRANSACTION_REPLACEMENT_IN_PROGRESS');
  assert.deepEqual(fs.readFileSync(marker, 'utf8').trim().split('\n'), [
    'mutation-preflight:replacement-owned',
  ]);

  result = await request(base, `/api/v1/operations/${replacementKey}`);
  assert.equal(result.body.data.phase, 'failed');
  assert.equal(result.body.data.outcome, 'failed');
  assert.equal(result.body.data.error.code, 'TRANSACTION_REPLACEMENT_IN_PROGRESS');
  assert.equal(result.body.data.error.status, 409);

  result = await request(
    base,
    '/api/v1/transactions/replacement-owned?accountId=account&date=2026-07-10',
    { method: 'DELETE', key: replacementKey },
  );
  assert.equal(result.response.status, 409);
  assert.equal(result.body.code, 'TRANSACTION_REPLACEMENT_IN_PROGRESS');
  assert.equal(
    fs.readFileSync(marker, 'utf8').trim(),
    'mutation-preflight:replacement-owned',
    'terminal failure replay performs no second preflight or effect',
  );

  const deleteKey = 'second-delete-blocked';
  result = await request(
    base,
    '/api/v1/transactions/delete-owned?accountId=account&date=2026-07-10',
    { method: 'DELETE', key: deleteKey },
  );
  assert.equal(result.response.status, 409);
  assert.equal(result.body.code, 'TRANSACTION_DELETION_IN_PROGRESS');

  const directConflicts = [
    {
      route: '/api/v1/transactions/delete-owned/category',
      key: 'category-blocked-by-delete',
      body: {
        categoryId: 'category',
        isLeg: false,
        parentId: null,
        accountId: 'account',
        date: '2026-07-10',
      },
    },
    {
      route: '/api/v1/transactions/delete-owned/date',
      key: 'date-blocked-by-delete',
      body: { date: '2026-07-11', isLeg: false },
    },
    {
      route: '/api/v1/receipts',
      key: 'receipt-blocked-by-delete',
      body: {
        txnId: 'delete-owned',
        accountId: 'account',
        transactionDate: '2026-07-10',
        imageBase64: 'aA==',
        mime: 'image/jpeg',
      },
    },
    {
      route: '/api/v1/reimb-links',
      key: 'link-blocked-by-delete',
      body: {
        inflow: { id: 'delete-owned', amount: 10, accountId: 'account' },
        expense: { id: 'unrelated-expense', amount: -10, accountId: 'account' },
        allocationCents: 1000,
      },
    },
    {
      route: '/api/v1/reconciliation/item',
      key: 'reconciliation-blocked-by-delete',
      body: { month: '2026-07', id: 'delete-owned', reconciled: true },
    },
  ];
  for (const conflictCase of directConflicts) {
    result = await request(base, conflictCase.route, {
      method: 'POST',
      key: conflictCase.key,
      body: conflictCase.body,
    });
    assert.equal(result.response.status, 409, conflictCase.route);
    assert.equal(result.body.code, 'TRANSACTION_DELETION_IN_PROGRESS', conflictCase.route);
  }

  const splitKey = 'replacement-blocked-by-delete';
  result = await request(base, '/api/v1/transactions/delete-owned/split', {
    method: 'POST',
    key: splitKey,
    body: {
      accountId: 'account',
      date: '2026-07-10',
      legs: [
        { amount: -4, categoryId: 'category-a' },
        { amount: -6, categoryId: 'category-b' },
      ],
    },
  });
  assert.equal(result.response.status, 409);
  assert.equal(result.body.code, 'TRANSACTION_DELETION_IN_PROGRESS');

  const unrelatedKey = 'unrelated-delete';
  result = await request(
    base,
    '/api/v1/transactions/unrelated?accountId=account&date=2026-07-10',
    { method: 'DELETE', key: unrelatedKey },
  );
  assert.equal(result.response.status, 200);
  assert.equal(result.body.data.deleted, 'unrelated');
  const effects = fs.readFileSync(marker, 'utf8').trim().split('\n');
  assert.ok(effects.includes('delete-mutation:unrelated'));
  assert.equal(effects.filter((value) => value === 'sync').length, 1);
  assert.ok(!effects.some((value) => value.startsWith('delete-mutation:delete-owned')));
  assert.ok(!effects.some((value) => value.startsWith('split-mutation:delete-owned')));
  assert.ok(!effects.some((value) => value.endsWith('mutation:delete-owned')));
});
