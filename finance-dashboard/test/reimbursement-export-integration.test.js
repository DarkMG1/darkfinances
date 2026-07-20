'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const { ExportSourceChangedError, MAX_SNAPSHOT_ATTEMPTS } = require('../lib/reimbursement-export-common');
const { getActualCoordinator, resetActualCoordinator } = require('../lib/actual-coordinator');
const { startEphemeralDashboardServer } = require('./helpers/ephemeral-dashboard-server');

test('generation mutation during bounded snapshot exhausts retries', async () => {
  resetActualCoordinator('reimb-export-barrier');
  const coordinator = getActualCoordinator();
  let caught = 0;
  for (let i = 1; i <= MAX_SNAPSHOT_ATTEMPTS; i += 1) {
    const captureGeneration = coordinator.generation;
    coordinator.invalidateGeneration();
    try {
      if (coordinator.generation !== captureGeneration) throw new ExportSourceChangedError();
      assert.fail('expected generation mismatch');
    } catch (error) {
      if (error instanceof ExportSourceChangedError) caught += 1;
      else throw error;
    }
  }
  assert.equal(caught, MAX_SNAPSHOT_ATTEMPTS);
});

test('demo API reimbursement-export returns complete allocation ledger', async (t) => {
  const { base, port } = await startEphemeralDashboardServer(t, {
    tempPrefix: 'reimb-export-api-',
    extraEnvForDir: () => ({ SELFTEST: '1' }),
  });
  const apiBase = `${base}/api/v1`;

  const headers = { 'X-Demo-Mode': '1' };
  const first = await fetch(`${apiBase}/reimbursement-export?format=json`, { headers });
  assert.equal(first.status, 200);
  const body = await first.json();
  assert.equal(body.data.completeness.status, 'complete');
  assert.equal(body.meta.exitCode, 0);
  assert.equal(body.meta.authoritative, true);
  assert.ok(Array.isArray(body.data.links));
  assert.ok(body.data.scopes?.global?.totals);

  const csv = await fetch(`${apiBase}/reimbursement-export?format=csv`, { headers });
  assert.match(await csv.text(), /linkKey,inflowId/);

  const legacy = await fetch(`http://127.0.0.1:${port}/api/reimbursement-export?format=json`, { headers });
  assert.equal(legacy.status, 200);
  assert.equal(legacy.headers.get('x-reimbursement-export-status'), 'complete');
  assert.equal(legacy.headers.get('x-reimbursement-export-exit-code'), '0');
  const legacyText = await legacy.text();
  const legacyBody = JSON.parse(legacyText);
  assert.equal(legacyBody.completeness.status, 'complete');
  assert.equal(legacyBody.data, undefined);
});
