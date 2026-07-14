const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const net = require('net');
const os = require('os');
const path = require('path');
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
  const deadline = Date.now() + 10_000;
  while (Date.now() < deadline) {
    if (child.exitCode != null) throw new Error(`server exited early: ${logs.value}`);
    try {
      const response = await fetch(`${base}/auth/status`);
      if (response.ok) return;
    } catch (_) {}
    await new Promise((resolve) => setTimeout(resolve, 25));
  }
  throw new Error(`server startup timeout: ${logs.value}`);
}

async function post(base, pathname, key, body) {
  const response = await fetch(`${base}${pathname}`, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      'X-Finance-Token': 'test-api-token',
      'Idempotency-Key': key,
    },
    body: typeof body === 'string' ? body : JSON.stringify(body),
  });
  return { response, body: await response.json() };
}

function reimbRef(id, amount) {
  return {
    id,
    date: '2026-07-09',
    payee: id,
    amount,
    accountId: 'account',
    account: 'Checking',
    imported: false,
  };
}

test('money routes reject before data mutation and durably journal known failures', async (t) => {
  const port = await unusedPort();
  const base = `http://127.0.0.1:${port}`;
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'darkfinances-money-routes-'));
  const dashboardRoot = path.resolve(__dirname, '..');
  const marker = path.join(dir, 'data-mutations.txt');
  const journal = path.join(dir, 'operation-journal.json');
  const preload = path.join(dir, 'mock-data-module.js');
  fs.writeFileSync(preload, `
    const fs = require('fs');
    const path = require('path');
    const dataPath = require.resolve(path.join(process.env.TEST_DASHBOARD_ROOT, 'dataModule.js'));
    const mutations = new Set([
      'createTransaction',
      'splitTransaction',
      'setBudgetAmount',
      'saveManualAsset',
      'saveGoal',
      'addReceipt',
      'addReimbLink',
      'setOwesConfig',
      'getTransactionById',
      'syncNow',
    ]);
    const mock = new Proxy({
      initApi: async () => ({ ok: true }),
      shutdownApi: async () => ({ ok: true }),
      getHealth: () => ({ ready: true }),
    }, {
      get(target, property) {
        if (property in target) return target[property];
        return async () => {
          if (mutations.has(String(property))) {
            fs.appendFileSync(process.env.TEST_DATA_MUTATION_MARKER, String(property) + '\\n');
          }
          return { ok: true, id: 'stub-id' };
        };
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
      SELFTEST: '1',
      NODE_OPTIONS: `${process.env.NODE_OPTIONS || ''} --require=${preload}`.trim(),
      PORT: String(port),
      PUBLIC_ORIGIN: `http://localhost:${port}`,
      WEBAUTHN_ORIGIN: `http://localhost:${port}`,
      WEBAUTHN_RP_ID: 'localhost',
      FINANCE_API_TOKEN: 'test-api-token',
      SESSION_SECRET: 'test-session-secret-with-sufficient-length',
      SESSION_DIR: path.join(dir, 'sessions'),
      OPERATION_JOURNAL_PATH: journal,
      PASSKEY_CREDENTIALS_FILE: path.join(dir, 'credentials.json'),
      TEST_DASHBOARD_ROOT: dashboardRoot,
      TEST_DATA_MUTATION_MARKER: marker,
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

  const cases = [
    {
      name: 'legacy mixed-case transaction',
      pathname: '/API/Transactions',
      invalid: { accountId: 'account', amount: 0.001 },
      valid: { accountId: 'account', amount: 0.01, payee: 'Coffee', date: '2026-07-09' },
      mutation: 'createTransaction',
    },
    {
      name: 'versioned mixed-case transaction',
      pathname: '/API/V1/Transactions',
      invalid: { accountId: 'account', amount: -0.001 },
      valid: { accountId: 'account', amount: -0.01, payee: 'Coffee', date: '2026-07-09' },
      mutation: 'createTransaction',
    },
    {
      name: 'transaction',
      pathname: '/api/v1/transactions',
      invalid: { accountId: 'account', amount: 1.005 },
      valid: { accountId: 'account', amount: -7.34, payee: 'Coffee', date: '2026-07-09' },
      mutation: 'createTransaction',
    },
    {
      name: 'split',
      pathname: '/api/v1/Transactions/txn/SPLIT',
      invalid: { accountId: 'account', date: '2026-07-09', legs: [{ amount: -1.005 }, { amount: -5 }] },
      valid: { accountId: 'account', date: '2026-07-09', legs: [{ amount: -5 }, { amount: -7.34 }] },
      mutation: 'splitTransaction',
    },
    {
      name: 'budget',
      pathname: '/api/v1/budgets',
      invalid: { categoryId: 'category', amount: null },
      valid: { month: '2026-07', categoryId: 'category', amount: 0 },
      mutation: 'setBudgetAmount',
    },
    {
      name: 'manual-asset',
      pathname: '/api/v1/manual-assets',
      invalid: { name: 'Brokerage', value: '1250.50', kind: 'asset' },
      valid: { name: 'Brokerage', value: 1250.5, kind: 'asset' },
      mutation: 'saveManualAsset',
    },
    {
      name: 'goal',
      pathname: '/api/v1/goals',
      invalid: { name: 'Emergency fund', target: 5000, current: 0.001 },
      valid: { name: 'Emergency fund', target: 5000, current: 734.56, accountId: null, deadline: null },
      mutation: 'saveGoal',
    },
    {
      name: 'receipt',
      pathname: '/api/v1/receipts',
      invalid: '{"txnId":"txn","accountId":"account","transactionDate":"2026-07-09","imageBase64":"abc","mime":"image/jpeg","amount":-0}',
      valid: {
        txnId: 'txn',
        accountId: 'account',
        transactionDate: '2026-07-09',
        imageBase64: 'abc',
        mime: 'image/jpeg',
        amount: 12.34,
        date: null,
        source: 'camera',
      },
      mutation: 'addReceipt',
    },
    {
      name: 'reimbursement-reference',
      pathname: '/api/v1/reimb-links',
      invalid: { inflow: reimbRef('inflow', '112.50'), expense: reimbRef('expense', -112.5) },
      valid: { inflow: reimbRef('inflow', 112.5), expense: reimbRef('expense', -112.5) },
      mutation: 'addReimbLink',
    },
    {
      name: 'reimbursement-allocation',
      pathname: '/api/v1/reimb-links',
      invalid: { inflow: reimbRef('inflow-2', 112.5), expense: reimbRef('expense-2', -112.5), amount: 0.001 },
      valid: { inflow: reimbRef('inflow-2', 112.5), expense: reimbRef('expense-2', -112.5), amount: 12.34 },
      mutation: 'addReimbLink',
    },
    {
      name: 'reimbursement-config-cents',
      pathname: '/api/v1/owes-config',
      invalid: { expected: { trip: { person: 12.5 } } },
      valid: { expected: { trip: { person: 1250 } }, manualTrips: { person: [{ event: 'trip', amount: 12.34 }] } },
      mutation: 'setOwesConfig',
    },
    {
      name: 'reimbursement-config-dollars',
      pathname: '/api/v1/owes-config',
      invalid: { manualTrips: { person: [{ event: 'trip', amount: 1.005 }] } },
      valid: { manualTrips: { person: [{ event: 'trip', amount: 0.01 }] } },
      mutation: 'setOwesConfig',
    },
  ];

  for (const [index, entry] of cases.entries()) {
    const result = await post(base, entry.pathname, `money-boundary-${index}`, entry.invalid);
    assert.equal(result.response.status, 400, `${entry.name}: ${JSON.stringify(result.body)}`);
    assert.equal(result.body.code, 'INVALID_REQUEST');
  }
  assert.equal(fs.existsSync(marker), false, 'invalid requests must not invoke data mutations');
  assert.equal(fs.existsSync(journal), true, 'versioned validation failures must be durable');
  const operations = JSON.parse(fs.readFileSync(journal, 'utf8')).operations;
  assert.equal(operations['money-boundary-0'], undefined, 'legacy validation remains outside the v1 journal');
  for (let index = 1; index < cases.length; index += 1) {
    assert.equal(operations[`money-boundary-${index}`].status, 'failed');
    assert.equal(operations[`money-boundary-${index}`].phase, 'failed');
    assert.equal(operations[`money-boundary-${index}`].knownBeforeApply, true);
  }

  for (const [index, entry] of cases.entries()) {
    const result = await post(base, entry.pathname, `money-valid-${index}`, entry.valid);
    assert.equal(result.response.status, 200, `${entry.name}: ${JSON.stringify(result.body)}`);
  }
  const invoked = fs.readFileSync(marker, 'utf8').trim().split('\n');
  for (const entry of cases) {
    assert.ok(invoked.includes(entry.mutation), `${entry.name} should invoke ${entry.mutation} for valid input`);
  }
});
