'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const os = require('os');
const path = require('path');
const { OperationJournal } = require('../lib/operation-journal');
const { loadAdmissionLimitsConfig } = require('../lib/admission-limits-config');
const {
  startAdmissionLimitsServer,
  tightAdmissionEnv,
} = require('./helpers/admission-limits-ephemeral-server');

async function v1Fetch(base, pathname, options = {}) {
  const response = await fetch(`${base}/api/v1${pathname}`, {
    ...options,
    headers: {
      'X-Finance-Token': 'test-api-token',
      ...(options.headers || {}),
    },
  });
  const text = await response.text();
  let body;
  try { body = JSON.parse(text); } catch (_) { body = text; }
  return { response, body };
}

test('expensive GET flood returns 429 while ping and operation status stay responsive', async (t) => {
  const { base, marker, releasePath } = await startAdmissionLimitsServer(t, {
    tempPrefix: 'darkfinances-admission-flood-',
  });

  const blocked = v1Fetch(base, '/accounts');
  await new Promise((resolve) => setImmediate(resolve));
  const queued = v1Fetch(base, '/accounts');
  await new Promise((resolve) => setImmediate(resolve));
  const overloaded = await v1Fetch(base, '/accounts');
  assert.equal(overloaded.response.status, 429);
  assert.equal(overloaded.body.code, 'ADMISSION_OVERLOADED');
  assert.equal(overloaded.body.requiresIdempotencyKeyReuse, undefined);
  assert.equal(overloaded.body.admission?.requiresIdempotencyKeyReuse, undefined);
  assert.equal(overloaded.body.admission?.lane, 'read');
  assert.match(String(overloaded.response.headers.get('retry-after') || ''), /^\d+$/);

  const ping = await v1Fetch(base, '/ping');
  assert.equal(ping.response.status, 200);
  assert.equal(ping.body.data.ok, true);
  assert.equal(typeof ping.body.data.requestAdmission, 'object');

  fs.writeFileSync(releasePath, 'go');
  await blocked;
  await queued;
  const markerText = fs.existsSync(marker) ? fs.readFileSync(marker, 'utf8') : '';
  assert.ok(markerText.includes('accounts:start'));
});

test('overload before journal start returns stable envelope and same-key replay stays admissible', async (t) => {
  const { base, marker, releasePath, journalPath } = await startAdmissionLimitsServer(t, {
    tempPrefix: 'darkfinances-admission-idem-',
    admissionEnv: tightAdmissionEnv(),
  });

  const key = 'budget-key-12345678';
  const body = { month: '2026-07', categoryId: 'cat-groceries', amount: 100 };
  const first = v1Fetch(base, '/budgets', {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      'Idempotency-Key': key,
    },
    body: JSON.stringify(body),
  });
  const deadline = Date.now() + 5_000;
  while (Date.now() < deadline) {
    if (fs.existsSync(marker) && fs.readFileSync(marker, 'utf8').includes('budget:start')) break;
    await new Promise((resolve) => setImmediate(resolve));
  }
  assert.ok(fs.existsSync(marker) && fs.readFileSync(marker, 'utf8').includes('budget:start'));
  const rejected = await v1Fetch(base, '/budgets', {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      'Idempotency-Key': 'other-key-123456789',
    },
    body: JSON.stringify(body),
  });
  assert.equal(rejected.response.status, 429);
  assert.equal(rejected.body.code, 'ADMISSION_OVERLOADED');
  assert.equal(rejected.body.requiresIdempotencyKeyReuse, true);
  assert.equal(rejected.body.admission?.requiresIdempotencyKeyReuse, true);
  assert.equal(rejected.body.admission?.lane, 'mutation');
  assert.equal(rejected.body.requestId?.length > 0, true);

  fs.writeFileSync(releasePath, 'go');
  const firstResult = await first;
  assert.equal(firstResult.response.status, 200);

  const markerText = fs.existsSync(marker) ? fs.readFileSync(marker, 'utf8') : '';
  assert.equal(markerText.includes('budget:start'), true);
  assert.equal(markerText.split('budget:end:').length - 1, 1);

  const replay = await v1Fetch(base, '/budgets', {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      'Idempotency-Key': key,
    },
    body: JSON.stringify(body),
  });
  assert.equal(replay.response.status, 200);
  assert.equal(replay.body.operation.replayed, true);
  assert.equal(markerText.split('budget:start').length - 1, 1);

  const journal = new OperationJournal(journalPath);
  assert.equal(journal.get(key)?.phase, 'completed');
});

test('missing Idempotency-Key returns 400 before queue saturation', async (t) => {
  const { base } = await startAdmissionLimitsServer(t, {
    tempPrefix: 'darkfinances-admission-no-key-',
    admissionEnv: tightAdmissionEnv(),
  });

  const rejected = await v1Fetch(base, '/budgets', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ month: '2026-07', categoryId: 'cat-groceries', amount: 100 }),
  });
  assert.equal(rejected.response.status, 400);
  assert.equal(rejected.body.code, 'IDEMPOTENCY_KEY_REQUIRED');
});

test('malformed admission env fails startup validation', () => {
  assert.throws(
    () => loadAdmissionLimitsConfig({ FINANCE_ADMISSION_MUTATION_GLOBAL_PENDING: 'not-a-number' }),
    /positive integer/,
  );
});

const ADMISSION_STORM_STATUSES = new Set([200, 409, 429, 503]);

test('concurrent same-key replay storm above mutation queue capacity stays bounded', async (t) => {
  const { base, marker, releasePath, journalPath } = await startAdmissionLimitsServer(t, {
    tempPrefix: 'darkfinances-admission-storm-',
    admissionEnv: tightAdmissionEnv({
      FINANCE_ADMISSION_MUTATION_GLOBAL_PENDING: '2',
      FINANCE_ADMISSION_MUTATION_GLOBAL_RUNNING: '1',
      FINANCE_ADMISSION_MUTATION_PRINCIPAL_PENDING: '1',
      FINANCE_ADMISSION_MUTATION_PRINCIPAL_RUNNING: '1',
      FINANCE_ADMISSION_RECOVERY_RESERVE: '1',
      FINANCE_ADMISSION_MAX_WAIT_MS: '50',
    }),
  });

  const key = 'storm-key-123456789';
  const body = { month: '2026-07', categoryId: 'cat-groceries', amount: 100 };
  fs.writeFileSync(releasePath, 'go');
  const seed = await v1Fetch(base, '/budgets', {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      'Idempotency-Key': key,
    },
    body: JSON.stringify(body),
  });
  assert.equal(seed.response.status, 200);
  fs.unlinkSync(releasePath);

  const blockerKey = 'blocker-key-12345678';
  const blocker = v1Fetch(base, '/budgets', {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      'Idempotency-Key': blockerKey,
    },
    body: JSON.stringify(body),
  });
  const deadline = Date.now() + 5_000;
  while (Date.now() < deadline) {
    const text = fs.existsSync(marker) ? fs.readFileSync(marker, 'utf8') : '';
    if (text.includes('budget:start') && text.split('budget:start').length - 1 >= 2) break;
    await new Promise((resolve) => setImmediate(resolve));
  }

  const storm = Array.from({ length: 48 }, () => v1Fetch(base, '/budgets', {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      'Idempotency-Key': key,
    },
    body: JSON.stringify(body),
  }));
  const stormResults = await Promise.all(storm);

  fs.writeFileSync(releasePath, 'go');
  await blocker;

  for (const result of stormResults) {
    assert.notEqual(result.response.status, 500, JSON.stringify(result.body));
    assert.ok(
      ADMISSION_STORM_STATUSES.has(result.response.status),
      `unexpected status ${result.response.status}: ${JSON.stringify(result.body)}`,
    );
    if (result.response.status === 429) {
      assert.equal(result.body.code, 'ADMISSION_OVERLOADED');
      assert.equal(result.body.requiresIdempotencyKeyReuse, true);
      assert.equal(result.body.admission?.requiresIdempotencyKeyReuse, true);
      assert.equal(result.body.admission?.lane, 'mutation');
    }
  }

  const markerText = fs.existsSync(marker) ? fs.readFileSync(marker, 'utf8') : '';
  assert.equal(markerText.split('budget:start').length - 1, 2, 'seed + blocker only');
  assert.equal(markerText.split('budget:end:').length - 1, 2);

  const journal = new OperationJournal(journalPath);
  assert.equal(journal.get(key)?.phase, 'completed');
  assert.equal(journal.get(blockerKey)?.phase, 'completed');
});

test('receipt image flood returns read overload without idempotency key reuse hint', async (t) => {
  const receiptPath = path.join(os.tmpdir(), `darkfinances-admission-receipt-${process.pid}.png`);
  fs.writeFileSync(receiptPath, Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]));
  t.after(() => {
    try { fs.unlinkSync(receiptPath); } catch (_) {}
  });
  const { base, marker, releasePath } = await startAdmissionLimitsServer(t, {
    tempPrefix: 'darkfinances-admission-receipt-',
    admissionEnv: {
      TEST_RECEIPT_PATH: receiptPath,
      FINANCE_ADMISSION_LIGHTWEIGHT_GLOBAL_PENDING: '1',
      FINANCE_ADMISSION_LIGHTWEIGHT_GLOBAL_RUNNING: '1',
      FINANCE_ADMISSION_LIGHTWEIGHT_PRINCIPAL_PENDING: '1',
      FINANCE_ADMISSION_LIGHTWEIGHT_PRINCIPAL_RUNNING: '1',
      FINANCE_ADMISSION_MAX_PENDING_DEPTH: '1',
      FINANCE_ADMISSION_MAX_WAIT_MS: '25',
    },
  });

  const blocked = v1Fetch(base, '/receipts/r1/image');
  const waitDeadline = Date.now() + 5_000;
  while (Date.now() < waitDeadline) {
    const text = fs.existsSync(marker) ? fs.readFileSync(marker, 'utf8') : '';
    if (text.includes('receipt-image:start:r1')) break;
    await new Promise((resolve) => setImmediate(resolve));
  }
  assert.ok(
    fs.existsSync(marker) && fs.readFileSync(marker, 'utf8').includes('receipt-image:start:r1'),
    'first receipt read must hold lightweight admission before overload probe',
  );

  const overloaded = await v1Fetch(base, '/receipts/r2/image');
  assert.equal(overloaded.response.status, 429);
  assert.equal(overloaded.body.code, 'ADMISSION_OVERLOADED');
  assert.equal(overloaded.body.requiresIdempotencyKeyReuse, undefined);
  assert.equal(overloaded.body.admission?.requiresIdempotencyKeyReuse, undefined);
  assert.equal(overloaded.body.admission?.lane, 'lightweight');

  fs.writeFileSync(releasePath, 'go');
  await blocked;
  const markerText = fs.existsSync(marker) ? fs.readFileSync(marker, 'utf8') : '';
  assert.ok(markerText.includes('receipt-image:start:r1'));
});
