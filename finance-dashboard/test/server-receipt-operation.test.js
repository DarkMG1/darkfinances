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

async function apiRequest(base, pathname, { method = 'GET', key, body } = {}) {
  const response = await fetch(`${base}${pathname}`, {
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

function receiptBody(txnId, accountId = 'account-id') {
  return {
    txnId,
    accountId,
    transactionDate: '2026-07-13',
    imageBase64: Buffer.from('receipt-image').toString('base64'),
    mime: 'image/png',
    source: 'camera',
  };
}

function markerLines(file) {
  return fs.existsSync(file)
    ? fs.readFileSync(file, 'utf8').trim().split('\n').filter(Boolean)
    : [];
}

test('receipt lookup outcomes preserve replay-safe operation phases', async (t) => {
  const port = await unusedPort();
  const base = `http://127.0.0.1:${port}`;
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'darkfinances-receipt-operation-'));
  const dashboardRoot = path.resolve(__dirname, '..');
  const journalPath = path.join(dir, 'operation-journal.json');
  const receiptsPath = path.join(dir, 'receipts.json');
  const receiptsDir = path.join(dir, 'receipts');
  const marker = path.join(dir, 'effects.log');
  const preload = path.join(dir, 'mock-data-module.js');
  fs.writeFileSync(preload, `
    const fs = require('fs');
    const path = require('path');
    const root = process.env.TEST_DASHBOARD_ROOT;
    const dataPath = require.resolve(path.join(root, 'dataModule.js'));
    const {
      AccountNotFoundError,
      TransactionNotFoundError,
    } = require(path.join(root, 'lib/errors.js'));
    const mark = (value) => fs.appendFileSync(process.env.TEST_EFFECT_MARKER, value + '\\n');
    const mock = new Proxy({
      initApi: async () => ({ ok: true }),
      shutdownApi: async () => ({ ok: true }),
      getHealth: () => ({ ready: true }),
      getTransactionById: async ({ id, accountId }) => {
        mark('lookup:' + accountId + ':' + id);
        if (accountId === 'missing-account') throw new AccountNotFoundError();
        if (accountId === 'transient-account') throw new Error('injected Actual account lookup outage');
        if (id === 'missing-transaction') throw new TransactionNotFoundError();
        if (id === 'transient-transaction') throw new Error('injected Actual lookup outage');
        return { id };
      },
      addReceipt: async (receipt) => {
        mark('add:' + receipt.txnId);
        return {
          id: 'receipt-' + receipt.txnId,
          txnId: receipt.txnId,
          mime: receipt.mime,
        };
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
      PASSKEY_CREDENTIALS_FILE: path.join(dir, 'credentials.json'),
      RECEIPTS_PATH: receiptsPath,
      RECEIPTS_DIR: receiptsDir,
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

  const expectedEffects = [];
  const missingAccountKey = 'receipt-account-missing';
  let result = await apiRequest(base, '/api/v1/receipts', {
    method: 'POST',
    key: missingAccountKey,
    body: receiptBody('transaction-id', 'missing-account'),
  });
  expectedEffects.push('lookup:missing-account:transaction-id');
  assert.equal(result.response.status, 404);
  assert.equal(result.body.code, 'ACCOUNT_NOT_FOUND');
  assert.equal(result.body.error, 'Account not found');
  assert.deepEqual(markerLines(marker), expectedEffects);
  assert.equal(fs.existsSync(receiptsPath), false);
  assert.equal(fs.existsSync(receiptsDir), false);

  result = await apiRequest(base, '/api/v1/receipts', {
    method: 'POST',
    key: missingAccountKey,
    body: receiptBody('transaction-id', 'missing-account'),
  });
  assert.equal(result.response.status, 404);
  assert.equal(result.body.code, 'ACCOUNT_NOT_FOUND');
  assert.equal(result.body.error, 'Account not found');
  assert.deepEqual(markerLines(marker), expectedEffects);
  assert.equal(fs.existsSync(receiptsPath), false);
  assert.equal(fs.existsSync(receiptsDir), false);

  result = await apiRequest(base, `/api/v1/operations/${missingAccountKey}`);
  assert.equal(result.response.status, 200);
  assert.equal(result.body.data.status, 'failed');
  assert.equal(result.body.data.phase, 'failed');
  assert.equal(result.body.data.terminal, true);
  assert.equal(result.body.data.outcome, 'failed');
  assert.deepEqual(result.body.data.error, {
    code: 'ACCOUNT_NOT_FOUND',
    message: 'Account not found',
    status: 404,
  });
  const missingAccountRecord = JSON.parse(
    fs.readFileSync(journalPath, 'utf8'),
  ).operations[missingAccountKey];
  assert.equal(missingAccountRecord.knownBeforeApply, true);
  assert.equal(Object.hasOwn(missingAccountRecord, 'localAppliedAt'), false);
  assert.equal(Object.hasOwn(missingAccountRecord, 'provisionalResult'), false);

  const transientAccountKey = 'receipt-account-transient';
  result = await apiRequest(base, '/api/v1/receipts', {
    method: 'POST',
    key: transientAccountKey,
    body: receiptBody('transaction-id', 'transient-account'),
  });
  expectedEffects.push('lookup:transient-account:transaction-id');
  assert.equal(result.response.status, 409);
  assert.equal(result.body.code, 'OUTCOME_UNKNOWN');
  assert.deepEqual(markerLines(marker), expectedEffects);

  result = await apiRequest(base, `/api/v1/operations/${transientAccountKey}`);
  assert.equal(result.body.data.status, 'started');
  assert.equal(result.body.data.phase, 'started');
  assert.equal(result.body.data.terminal, false);
  assert.equal(result.body.data.outcome, 'unknown');
  assert.equal(Object.hasOwn(result.body.data, 'error'), false);

  result = await apiRequest(base, '/api/v1/receipts', {
    method: 'POST',
    key: transientAccountKey,
    body: receiptBody('transaction-id', 'transient-account'),
  });
  assert.equal(result.response.status, 409);
  assert.equal(result.body.code, 'OUTCOME_UNKNOWN');
  assert.deepEqual(markerLines(marker), expectedEffects);
  assert.equal(fs.existsSync(receiptsPath), false);
  assert.equal(fs.existsSync(receiptsDir), false);

  const missingKey = 'receipt-missing-001';
  result = await apiRequest(base, '/api/v1/receipts', {
    method: 'POST',
    key: missingKey,
    body: receiptBody('missing-transaction'),
  });
  expectedEffects.push('lookup:account-id:missing-transaction');
  assert.equal(result.response.status, 404);
  assert.equal(result.body.code, 'TRANSACTION_NOT_FOUND');
  assert.equal(result.body.error, 'Transaction not found');
  assert.deepEqual(markerLines(marker), expectedEffects);
  assert.equal(fs.existsSync(receiptsPath), false);
  assert.equal(fs.existsSync(receiptsDir), false);

  result = await apiRequest(base, '/api/v1/receipts', {
    method: 'POST',
    key: missingKey,
    body: receiptBody('missing-transaction'),
  });
  assert.equal(result.response.status, 404);
  assert.equal(result.body.code, 'TRANSACTION_NOT_FOUND');
  assert.equal(result.body.error, 'Transaction not found');
  assert.deepEqual(markerLines(marker), expectedEffects);
  assert.equal(fs.existsSync(receiptsPath), false);
  assert.equal(fs.existsSync(receiptsDir), false);

  result = await apiRequest(base, `/api/v1/operations/${missingKey}`);
  assert.equal(result.response.status, 200);
  assert.equal(result.body.data.status, 'failed');
  assert.equal(result.body.data.phase, 'failed');
  assert.equal(result.body.data.terminal, true);
  assert.equal(result.body.data.outcome, 'failed');
  assert.deepEqual(result.body.data.error, {
    code: 'TRANSACTION_NOT_FOUND',
    message: 'Transaction not found',
    status: 404,
  });
  const missingRecord = JSON.parse(fs.readFileSync(journalPath, 'utf8')).operations[missingKey];
  assert.equal(missingRecord.knownBeforeApply, true);
  assert.equal(Object.hasOwn(missingRecord, 'localAppliedAt'), false);
  assert.equal(Object.hasOwn(missingRecord, 'provisionalResult'), false);

  const transientKey = 'receipt-transient-01';
  result = await apiRequest(base, '/api/v1/receipts', {
    method: 'POST',
    key: transientKey,
    body: receiptBody('transient-transaction'),
  });
  expectedEffects.push('lookup:account-id:transient-transaction');
  assert.equal(result.response.status, 409);
  assert.equal(result.body.code, 'OUTCOME_UNKNOWN');
  assert.deepEqual(markerLines(marker), expectedEffects);

  result = await apiRequest(base, `/api/v1/operations/${transientKey}`);
  assert.equal(result.body.data.status, 'started');
  assert.equal(result.body.data.phase, 'started');
  assert.equal(result.body.data.terminal, false);
  assert.equal(result.body.data.outcome, 'unknown');
  assert.equal(Object.hasOwn(result.body.data, 'error'), false);

  result = await apiRequest(base, '/api/v1/receipts', {
    method: 'POST',
    key: transientKey,
    body: receiptBody('transient-transaction'),
  });
  assert.equal(result.response.status, 409);
  assert.equal(result.body.code, 'OUTCOME_UNKNOWN');
  assert.deepEqual(markerLines(marker), expectedEffects);
  assert.equal(fs.existsSync(receiptsPath), false);
  assert.equal(fs.existsSync(receiptsDir), false);

  const validKey = 'receipt-valid-0001';
  result = await apiRequest(base, '/api/v1/receipts', {
    method: 'POST',
    key: validKey,
    body: receiptBody('valid-transaction'),
  });
  expectedEffects.push(
    'lookup:account-id:valid-transaction',
    'add:valid-transaction',
  );
  assert.equal(result.response.status, 200);
  assert.deepEqual(result.body.data, {
    id: 'receipt-valid-transaction',
    txnId: 'valid-transaction',
    mime: 'image/png',
  });
  assert.deepEqual(result.body.operation, { key: validKey, replayed: false });
  assert.deepEqual(markerLines(marker), expectedEffects);

  const validRecord = JSON.parse(fs.readFileSync(journalPath, 'utf8')).operations[validKey];
  assert.equal(validRecord.status, 'completed');
  assert.equal(validRecord.phase, 'completed');
  assert.equal(typeof validRecord.localAppliedAt, 'string');
  assert.deepEqual(validRecord.provisionalResult, result.body.data);
  assert.deepEqual(validRecord.result, result.body.data);
});
