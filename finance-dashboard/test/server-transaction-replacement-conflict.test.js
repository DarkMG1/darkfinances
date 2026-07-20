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

test('replacement conflict is a terminal 409 before the operation effect boundary', async (t) => {
  const { base, dir } = await startEphemeralDashboardServer(t, {
    tempPrefix: 'darkfinances-replacement-conflict-',
    preloadBody: `
    const fs = require('fs');
    const path = require('path');
    const dataPath = require.resolve(path.join(process.env.TEST_DASHBOARD_ROOT, 'dataModule.js'));
    const { KnownPreApplyError } = require(path.join(process.env.TEST_DASHBOARD_ROOT, 'lib/errors.js'));
    const mark = (value) => fs.appendFileSync(process.env.TEST_EFFECT_MARKER, value + '\\n');
    const mock = new Proxy({
      initApi: async () => ({ ok: true }),
      shutdownApi: async () => ({ ok: true }),
      getHealth: () => ({ ready: true }),
      assertTransactionMutationAvailable: () => {
        mark('conflict-preflight');
        throw new KnownPreApplyError('A replacement for this transaction is already in progress', {
          code: 'TRANSACTION_REPLACEMENT_IN_PROGRESS',
          status: 409,
        });
      },
      splitTransaction: async () => {
        mark('split-mutation');
        return { ok: true };
      },
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
  `,
  });
  const marker = path.join(dir, 'effects.log');

  const key = 'replacement-conflict-second-key';
  let result = await apiRequest(base, '/api/v1/transactions/old-parent/split', {
    method: 'POST',
    key,
    body: {
      accountId: 'account',
      date: '2026-07-09',
      legs: [
        { amount: -4, categoryId: 'category-1' },
        { amount: -6, categoryId: 'category-2' },
      ],
    },
  });
  assert.equal(result.response.status, 409);
  assert.equal(result.body.code, 'TRANSACTION_REPLACEMENT_IN_PROGRESS');
  assert.equal(fs.readFileSync(marker, 'utf8').trim(), 'conflict-preflight');

  result = await apiRequest(base, `/api/v1/operations/${key}`);
  assert.equal(result.body.data.phase, 'failed');
  assert.equal(result.body.data.outcome, 'failed');
  assert.equal(result.body.data.error.code, 'TRANSACTION_REPLACEMENT_IN_PROGRESS');
  assert.equal(result.body.data.error.status, 409);
});
