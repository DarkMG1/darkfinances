'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const os = require('os');
const path = require('path');
const { RECEIPT_MAX_DECODED_BYTES, RECEIPT_MAX_JSON_BYTES } = require('../lib/receipt-limits');
const { startEphemeralDashboardServer } = require('./helpers/ephemeral-dashboard-server');

const pngBytes = Buffer.concat([
  Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]),
  Buffer.from('receipt-image-payload'),
]);

async function apiRequest(base, body, key = `receipt-${Date.now()}`) {
  const response = await fetch(`${base}/api/v1/receipts`, {
    method: 'POST',
    headers: {
      'X-Finance-Token': 'test-api-token',
      'Content-Type': 'application/json',
      'Idempotency-Key': key,
    },
    body: JSON.stringify(body),
  });
  return { response, body: await response.json() };
}

function receiptBody(overrides = {}) {
  return {
    txnId: 'txn-upload-1',
    accountId: 'account-id',
    transactionDate: '2026-07-13',
    imageBase64: pngBytes.toString('base64'),
    mime: 'image/png',
    source: 'camera',
    ...overrides,
  };
}

test('HTTP receipt upload returns typed validation and duplicate errors', async (t) => {
  const { base } = await startEphemeralDashboardServer(t, {
    tempPrefix: 'darkfinances-receipt-upload-errors-',
    preloadBody: `
      const path = require('path');
      const root = process.env.TEST_DASHBOARD_ROOT;
      const dataPath = require.resolve(path.join(root, 'dataModule.js'));
      const real = require(dataPath);
      require.cache[dataPath] = {
        id: dataPath,
        filename: dataPath,
        loaded: true,
        exports: new Proxy(real, {
          get(target, property) {
            if (property === 'getTransactionById') {
              return async () => ({ id: 'txn-upload-1' });
            }
            if (property === 'initApi') return async () => ({ ok: true });
            if (property === 'shutdownApi') return async () => ({ ok: true });
            if (property === 'getHealth') return () => ({ ready: true });
            return target[property];
          },
        }),
        children: [],
        paths: [],
      };
    `,
  });

  let result = await apiRequest(base, receiptBody({ imageBase64: '' }), 'receipt-empty-image');
  assert.equal(result.response.status, 400);
  assert.equal(result.body.code, 'INVALID_REQUEST');

  result = await apiRequest(base, receiptBody({ imageBase64: 'not-base64!' }), 'receipt-bad-base64');
  assert.equal(result.response.status, 400);
  assert.equal(result.body.code, 'INVALID_REQUEST');

  result = await apiRequest(base, receiptBody({ mime: 'image/jpeg' }), 'receipt-mime-mismatch');
  assert.equal(result.response.status, 415);
  assert.equal(result.body.code, 'UNSUPPORTED_MEDIA_TYPE');

  result = await apiRequest(base, receiptBody(), 'receipt-valid-1');
  assert.equal(result.response.status, 200);

  result = await apiRequest(base, receiptBody(), 'receipt-duplicate-1');
  assert.equal(result.response.status, 409);
  assert.equal(result.body.code, 'RECEIPT_DUPLICATE');
  assert.equal(String(JSON.stringify(result.body)).includes('rcpt_'), false);
});

test('HTTP receipt upload returns 413 for oversized decoded payload', async (t) => {
  const { base } = await startEphemeralDashboardServer(t, {
    tempPrefix: 'darkfinances-receipt-upload-large-',
    preloadBody: `
      const path = require('path');
      const root = process.env.TEST_DASHBOARD_ROOT;
      const dataPath = require.resolve(path.join(root, 'dataModule.js'));
      const real = require(dataPath);
      require.cache[dataPath] = {
        id: dataPath,
        filename: dataPath,
        loaded: true,
        exports: new Proxy(real, {
          get(target, property) {
            if (property === 'getTransactionById') return async () => ({ id: 'txn-large' });
            if (property === 'initApi') return async () => ({ ok: true });
            if (property === 'shutdownApi') return async () => ({ ok: true });
            if (property === 'getHealth') return () => ({ ready: true });
            return target[property];
          },
        }),
        children: [],
        paths: [],
      };
    `,
  });

  const oversized = Buffer.alloc(RECEIPT_MAX_DECODED_BYTES + 1, 0xff);
  oversized[0] = 0x89;
  oversized[1] = 0x50;
  oversized[2] = 0x4e;
  oversized[3] = 0x47;
  oversized[4] = 0x0d;
  oversized[5] = 0x0a;
  oversized[6] = 0x1a;
  oversized[7] = 0x0a;
  const result = await apiRequest(base, {
    ...receiptBody({ txnId: 'txn-large' }),
    imageBase64: oversized.toString('base64'),
  }, 'receipt-too-large');
  assert.equal(result.response.status, 413);
  assert.equal(result.body.code, 'PAYLOAD_TOO_LARGE');
});

test('bounded JSON middleware still rejects oversized receipt envelopes before handler', async (t) => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'darkfinances-receipt-json-bound-'));
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
  const { base } = await startEphemeralDashboardServer(t, {
    tempPrefix: 'darkfinances-receipt-json-bound-',
    dir,
  });
  const huge = 'a'.repeat(RECEIPT_MAX_JSON_BYTES + 1);
  const response = await fetch(`${base}/api/v1/receipts`, {
    method: 'POST',
    headers: {
      'X-Finance-Token': 'test-api-token',
      'Content-Type': 'application/json',
      'Idempotency-Key': 'receipt-json-too-large',
    },
    body: JSON.stringify({ imageBase64: huge }),
  });
  const body = await response.json();
  assert.equal(response.status, 413);
  assert.equal(body.code, 'PAYLOAD_TOO_LARGE');
});

function receiptConcurrentPreload() {
  return `
    const path = require('path');
    const root = process.env.TEST_DASHBOARD_ROOT;
    const dataPath = require.resolve(path.join(root, 'dataModule.js'));
    const real = require(dataPath);
    require.cache[dataPath] = {
      id: dataPath,
      filename: dataPath,
      loaded: true,
      exports: new Proxy(real, {
        get(target, property) {
          if (property === 'getTransactionById') {
            return async () => ({ id: 'txn-concurrent-dup' });
          }
          if (property === 'initApi') return async () => ({ ok: true });
          if (property === 'shutdownApi') return async () => ({ ok: true });
          if (property === 'getHealth') return () => ({ ready: true });
          return target[property];
        },
      }),
      children: [],
      paths: [],
    };
  `;
}

test('concurrent v1 receipt uploads classify post-precheck duplicate as RECEIPT_DUPLICATE', async (t) => {
  let journalPath;
  let receiptsPath;
  const { base } = await startEphemeralDashboardServer(t, {
    tempPrefix: 'darkfinances-receipt-concurrent-v1-',
    demoOnly: false,
    preloadBody: receiptConcurrentPreload(),
    extraEnvForDir: (dirPath) => {
      journalPath = path.join(dirPath, 'operation-journal.json');
      receiptsPath = path.join(dirPath, 'receipts.json');
      return {
        OPERATION_JOURNAL_PATH: journalPath,
        RECEIPTS_PATH: receiptsPath,
        RECEIPTS_DIR: path.join(dirPath, 'receipt-images'),
      };
    },
  });

  const body = receiptBody({ txnId: 'txn-concurrent-dup' });
  const [first, second] = await Promise.all([
    apiRequest(base, body, 'receipt-concurrent-a'),
    apiRequest(base, body, 'receipt-concurrent-b'),
  ]);
  const statuses = [first.response.status, second.response.status].sort();
  assert.deepEqual(statuses, [200, 409]);
  const success = first.response.status === 200 ? first : second;
  const duplicate = first.response.status === 409 ? first : second;
  assert.equal(duplicate.body.code, 'RECEIPT_DUPLICATE');
  assert.equal(String(JSON.stringify(duplicate.body)).includes('OUTCOME_UNKNOWN'), false);

  const replay = await apiRequest(base, body, 'receipt-concurrent-b');
  assert.equal(replay.response.status, 409);
  assert.equal(replay.body.code, 'RECEIPT_DUPLICATE');

  const store = JSON.parse(fs.readFileSync(receiptsPath, 'utf8'));
  const stored = Object.values(store.byTxn || {}).flat();
  assert.equal(stored.length, 1);
  assert.equal(stored[0].txnId, 'txn-concurrent-dup');
  assert.equal(stored[0].id, success.body.data.id);

  const duplicateRecord = JSON.parse(fs.readFileSync(journalPath, 'utf8')).operations['receipt-concurrent-b'];
  assert.equal(duplicateRecord.status, 'failed');
  assert.equal(duplicateRecord.phase, 'failed');
  assert.equal(duplicateRecord.error.code, 'RECEIPT_DUPLICATE');
  assert.equal(Object.hasOwn(duplicateRecord, 'localAppliedAt'), false);
});

test('legacy receipt upload returns typed duplicate envelope without OUTCOME_UNKNOWN', async (t) => {
  let receiptsPath;
  const { base } = await startEphemeralDashboardServer(t, {
    tempPrefix: 'darkfinances-receipt-legacy-dup-',
    demoOnly: false,
    preloadBody: receiptConcurrentPreload(),
    extraEnvForDir: (dirPath) => {
      receiptsPath = path.join(dirPath, 'receipts.json');
      return {
        RECEIPTS_PATH: receiptsPath,
        RECEIPTS_DIR: path.join(dirPath, 'receipt-images'),
        SELFTEST: '1',
      };
    },
  });

  const body = receiptBody({ txnId: 'txn-concurrent-dup' });
  const first = await fetch(`${base}/api/receipts`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(body),
  });
  assert.equal(first.status, 200);

  const second = await fetch(`${base}/api/receipts`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(body),
  });
  const payload = await second.json();
  assert.equal(second.status, 409);
  assert.equal(payload.code, 'RECEIPT_DUPLICATE');
  assert.equal(String(JSON.stringify(payload)).includes('OUTCOME_UNKNOWN'), false);
  const stored = Object.values(JSON.parse(fs.readFileSync(receiptsPath, 'utf8')).byTxn || {}).flat();
  assert.equal(stored.length, 1);
});
