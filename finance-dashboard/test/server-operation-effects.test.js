const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const path = require('path');
const { startEphemeralDashboardServer } = require('./helpers/ephemeral-dashboard-server');

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

test('server composes structural sync and strict bank uncertainty', async (t) => {
  const { base, dir } = await startEphemeralDashboardServer(t, {
    tempPrefix: 'darkfinances-operation-effects-',
    preloadBody: `
    const fs = require('fs');
    const path = require('path');
    const dataPath = require.resolve(path.join(process.env.TEST_DASHBOARD_ROOT, 'dataModule.js'));
    const mark = (value) => fs.appendFileSync(process.env.TEST_EFFECT_MARKER, value + '\\n');
    const mock = new Proxy({
      initApi: async () => ({ ok: true }),
      shutdownApi: async () => ({ ok: true }),
      getHealth: () => ({ ready: true }),
      syncSplitwiseShareExpenses: async (options) => {
        mark('splitwise:' + JSON.stringify(options));
        return { ok: true, created: 0, updated: 0, pruned: 0, needsSync: true, status: 'in_progress' };
      },
      getBulkOperationResult: () => ({
        ok: true,
        created: 0,
        updated: 0,
        pruned: 0,
        needsSync: false,
        status: 'completed',
      }),
      syncNow: async () => { mark('sync'); },
      bankSync: async (options) => {
        mark('bank:' + JSON.stringify(options));
        throw new Error('injected bank rejection');
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
  `,
  });
  const marker = path.join(dir, 'effects.log');

  const splitwiseKey = 'splitwise-structural';
  let result = await apiRequest(base, '/api/v1/splitwise/sync-shares', {
    method: 'POST',
    key: splitwiseKey,
    body: {},
  });
  assert.equal(result.response.status, 200);
  const effects = fs.readFileSync(marker, 'utf8').trim().split('\n');
  assert.match(effects[0], /^splitwise:\{"sync":false,"operationKey":"splitwise-structural"/);
  assert.equal(effects[1], 'sync');

  result = await apiRequest(base, `/api/v1/operations/${splitwiseKey}`);
  assert.equal(result.body.data.phase, 'completed');

  const bankKey = 'bank-sync-reject';
  result = await apiRequest(base, '/api/v1/bank-sync', {
    method: 'POST',
    key: bankKey,
    body: {},
  });
  assert.equal(result.response.status, 409);
  assert.equal(result.body.code, 'OUTCOME_UNKNOWN');
  assert.match(fs.readFileSync(marker, 'utf8'), /bank:\{"throwOnBankError":true\}/);

  result = await apiRequest(base, `/api/v1/operations/${bankKey}`);
  assert.equal(result.body.data.status, 'started');
  assert.equal(result.body.data.phase, 'sync_unknown');
  assert.equal(result.body.data.outcome, 'unknown');
});
