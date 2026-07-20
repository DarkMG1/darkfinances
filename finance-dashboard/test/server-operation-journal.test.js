const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const path = require('path');
const { legacyRequestFingerprint } = require('../lib/operation-journal');
const { startEphemeralDashboardServer } = require('./helpers/ephemeral-dashboard-server');

async function request(base, pathname, options = {}) {
  const response = await fetch(`${base}${pathname}`, options);
  const text = await response.text();
  let body;
  try { body = JSON.parse(text); } catch (_) { body = text; }
  return { response, body };
}

function mutationOptions(key, body) {
  return {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      'X-Finance-Token': 'test-api-token',
      'Idempotency-Key': key,
    },
    body: JSON.stringify(body),
  };
}

test('server exposes phase-aware replay and legacy-safe operation status', async (t) => {
  const legacyBody = { enabled: false };
  const legacyRoute = '/api/v1/reconciliation/enabled';
  const legacyKey = 'legacy-failed-01';
  let operationFile;
  let reconciliationFile;
  const { base } = await startEphemeralDashboardServer(t, {
    tempPrefix: 'darkfinances-operation-server-',
    prepareDir: (dir) => {
      operationFile = path.join(dir, 'operation-journal.json');
      reconciliationFile = path.join(dir, 'reconciliation.json');
      fs.writeFileSync(operationFile, JSON.stringify({
        schemaVersion: 1,
        operations: {
          [legacyKey]: {
            key: legacyKey,
            fingerprint: legacyRequestFingerprint('POST', legacyRoute, legacyBody),
            method: 'POST',
            route: legacyRoute,
            status: 'failed',
            startedAt: '2025-01-01T00:00:00.000Z',
            completedAt: '2025-01-01T00:01:00.000Z',
            error: { code: 'INTERNAL_ERROR', message: 'ambiguous old failure' },
          },
        },
      }));
    },
    extraEnvForDir: (dir) => ({
      OPERATION_JOURNAL_PATH: path.join(dir, 'operation-journal.json'),
      RECON_PATH: path.join(dir, 'reconciliation.json'),
    }),
  });

  const key = 'server-completed-1';
  let result = await request(
    base,
    '/api/v1/reconciliation/enabled?b=2&a=1&a=0',
    mutationOptions(key, { enabled: true }),
  );
  assert.equal(result.response.status, 200);
  assert.deepEqual(result.body.data, { ok: true, enabled: true });
  assert.deepEqual(result.body.operation, { key, replayed: false });

  result = await request(
    base,
    '/api/v1/reconciliation/enabled?a=1&a=0&b=2',
    mutationOptions(key, { enabled: true }),
  );
  assert.equal(result.response.status, 200);
  assert.equal(result.body.operation.replayed, true);

  result = await request(
    base,
    '/api/v1/reconciliation/enabled?a=9&b=2',
    mutationOptions(key, { enabled: true }),
  );
  assert.equal(result.response.status, 409);
  assert.equal(result.body.code, 'IDEMPOTENCY_KEY_REUSED');

  result = await request(base, `/api/v1/operations/${key}`, {
    headers: { 'X-Finance-Token': 'test-api-token' },
  });
  assert.equal(result.response.status, 200);
  assert.equal(result.body.data.status, 'completed');
  assert.equal(result.body.data.phase, 'completed');
  assert.equal(result.body.data.terminal, true);
  assert.deepEqual(result.body.data.result, { ok: true, enabled: true });
  assert.equal(Object.hasOwn(result.body.data, 'fingerprint'), false);

  const invalidKey = 'server-invalid-01';
  const invalidOptions = mutationOptions(invalidKey, { enabled: 'yes' });
  const firstInvalid = await request(base, legacyRoute, invalidOptions);
  const replayedInvalid = await request(base, legacyRoute, invalidOptions);
  assert.equal(firstInvalid.response.status, 400);
  assert.equal(replayedInvalid.response.status, 400);
  assert.equal(firstInvalid.body.code, 'INVALID_REQUEST');
  assert.equal(replayedInvalid.body.code, firstInvalid.body.code);
  assert.equal(replayedInvalid.body.error, firstInvalid.body.error);

  result = await request(base, `/api/v1/operations/${invalidKey}`, {
    headers: { 'X-Finance-Token': 'test-api-token' },
  });
  assert.equal(result.body.data.status, 'failed');
  assert.equal(result.body.data.phase, 'failed');
  assert.equal(result.body.data.outcome, 'failed');

  result = await request(base, `/api/v1/operations/${legacyKey}`, {
    headers: { 'X-Finance-Token': 'test-api-token' },
  });
  assert.equal(result.body.data.status, 'started');
  assert.equal(result.body.data.phase, 'started');
  assert.equal(result.body.data.outcome, 'unknown');
  assert.equal(result.body.data.legacyAmbiguous, true);

  result = await request(base, legacyRoute, mutationOptions(legacyKey, legacyBody));
  assert.equal(result.response.status, 409);
  assert.equal(result.body.code, 'OUTCOME_UNKNOWN');
  assert.equal(JSON.parse(fs.readFileSync(reconciliationFile, 'utf8')).enabled, true);
});
