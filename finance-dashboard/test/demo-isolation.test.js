'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const path = require('path');
const { startEphemeralDashboardServer } = require('./helpers/ephemeral-dashboard-server');

async function request(base, pathname, options = {}) {
  const response = await fetch(`${base}${pathname}`, options);
  const text = await response.text();
  let body;
  try { body = JSON.parse(text); } catch (_) { body = text; }
  return { response, body };
}

function fileSnapshot(filePath) {
  return fs.existsSync(filePath) ? fs.readFileSync(filePath) : null;
}

test('DEMO_ONLY forces headerless API reads and writes through synthetic handlers', async (t) => {
  let manualAssetsPath;
  const { base, dir } = await startEphemeralDashboardServer(t, {
    tempPrefix: 'darkfinances-demo-only-isolation-',
    demoOnly: true,
    extraEnvForDir: (dirPath) => {
      manualAssetsPath = path.join(dirPath, 'manual-assets.json');
      return { MANUAL_ASSETS_PATH: manualAssetsPath };
    },
  });
  const operationJournalPath = path.join(dir, 'operation-journal.json');
  const sidecarBefore = fileSnapshot(manualAssetsPath);
  const journalBefore = fileSnapshot(operationJournalPath);

  let result = await request(base, '/api/v1/accounts', {
    headers: { 'X-Finance-Token': 'test-api-token' },
  });
  assert.equal(result.response.status, 200);
  assert.ok(Array.isArray(result.body.data));
  assert.equal(result.body.data[0].name, 'Everyday Checking');

  result = await request(base, '/api/accounts', { redirect: 'manual' });
  assert.equal(result.response.status, 200);
  assert.ok(Array.isArray(result.body));
  assert.equal(result.body[0].name, 'Everyday Checking');

  result = await request(base, '/api/v1/manual-assets', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ name: 'Demo brokerage', value: 250, kind: 'asset' }),
  });
  assert.equal(result.response.status, 200);
  assert.deepEqual(result.body.data, { ok: true, demo: true });
  assert.deepEqual(fileSnapshot(manualAssetsPath), sidecarBefore);
  assert.deepEqual(fileSnapshot(operationJournalPath), journalBefore);
});

test('anonymous legacy demo API bypasses only the session gate and fails closed', async (t) => {
  const { base } = await startEphemeralDashboardServer(t, {
    tempPrefix: 'darkfinances-legacy-demo-',
  });

  let result = await request(base, '/api/accounts', { redirect: 'manual' });
  assert.equal(result.response.status, 302);
  assert.equal(result.response.headers.get('location'), '/login');

  result = await request(base, '/api/accounts?demo=1', { redirect: 'manual' });
  assert.equal(result.response.status, 200);
  assert.ok(Array.isArray(result.body));

  result = await request(base, '/api/goals?demo=1', {
    method: 'POST',
    redirect: 'manual',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ name: 'Demo goal', target: 500 }),
  });
  assert.equal(result.response.status, 200);
  assert.deepEqual(result.body, { ok: true, demo: true });

  result = await request(base, '/api/not-a-real-write?demo=1', {
    method: 'POST',
    redirect: 'manual',
    headers: { 'Content-Type': 'application/json' },
    body: '{}',
  });
  assert.equal(result.response.status, 404);
  assert.equal(result.body.code, 'NOT_FOUND');
});

test('demo receipt image routes return synthetic image bytes without live storage', async (t) => {
  const { base } = await startEphemeralDashboardServer(t, {
    tempPrefix: 'darkfinances-demo-receipt-image-',
  });
  const demoHeaders = { 'X-Demo-Mode': '1' };

  const metadata = await request(base, '/api/v1/receipts', { headers: demoHeaders });
  assert.equal(metadata.response.status, 200);
  const receiptId = metadata.body.data.receipts[0].id;

  for (const pathname of [
    `/api/v1/receipts/${encodeURIComponent(receiptId)}/image`,
    `/api/receipts/${encodeURIComponent(receiptId)}/image?demo=1`,
  ]) {
    const response = await fetch(`${base}${pathname}`, {
      headers: pathname.startsWith('/api/v1/') ? demoHeaders : {},
      redirect: 'manual',
    });
    const bytes = Buffer.from(await response.arrayBuffer());
    assert.equal(response.status, 200, pathname);
    assert.equal(response.headers.get('content-type'), 'image/png', pathname);
    assert.equal(response.headers.get('cache-control'), 'private, no-store', pathname);
    assert.deepEqual([...bytes.subarray(0, 8)], [0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a], pathname);
    assert.equal(Number(response.headers.get('content-length')), bytes.length, pathname);
  }

  const missing = await request(base, '/api/v1/receipts/missing/image', { headers: demoHeaders });
  assert.equal(missing.response.status, 404);
  assert.equal(missing.body.code, 'NOT_FOUND');
});
