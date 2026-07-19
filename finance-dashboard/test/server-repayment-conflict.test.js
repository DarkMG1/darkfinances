'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const path = require('path');
const { startEphemeralDashboardServer } = require('./helpers/ephemeral-dashboard-server');

async function request(base, route, { method = 'GET', key, body } = {}) {
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

test('repayment confirmation ownership conflicts are terminal before operation effects', async (t) => {
  const { base, dir } = await startEphemeralDashboardServer(t, {
    tempPrefix: 'darkfinances-repay-conflict-',
    preloadBody: `
    const fs = require('fs');
    const path = require('path');
    const dataPath = require.resolve(path.join(process.env.TEST_DASHBOARD_ROOT, 'dataModule.js'));
    const { KnownPreApplyError } = require(path.join(process.env.TEST_DASHBOARD_ROOT, 'lib/errors.js'));
    const mark = (value) => fs.appendFileSync(process.env.TEST_EFFECT_MARKER, value + '\\n');
    const repaymentConflict = () => {
      throw new KnownPreApplyError('A repayment confirmation for this transaction is already in progress', {
        code: 'REPAYMENT_CONFIRMATION_IN_PROGRESS',
        status: 409,
      });
    };
    const mock = new Proxy({
      initApi: async () => ({ ok: true }),
      shutdownApi: async () => ({ ok: true }),
      getHealth: () => ({ ready: true }),
      assertTransactionMutationAvailable: ({ ids = [] }) => {
        mark('mutation-preflight:' + ids.filter(Boolean).join(','));
        if (ids.map(String).includes('repay-owned')) repaymentConflict();
      },
      confirmRepayment: async ({ id }) => {
        mark('confirm-mutation:' + id);
        return { ok: true, inflowId: 'repay-owned', linked: 1 };
      },
      setTransactionCategory: async ({ id }) => { mark('category-mutation:' + id); },
      addReimbLink: async ({ inflow }) => { mark('link-mutation:' + inflow.id); },
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
    };
  `,
  });
  const marker = path.join(dir, 'effects.log');

  const conflictCases = [
    { route: '/api/v1/repayments/sg_repay-owned/confirm', method: 'POST', key: 'confirm-key' },
    { route: '/api/v1/transactions/repay-owned/category', method: 'POST', key: 'category-key', body: { categoryId: 'cat' } },
    {
      route: '/api/v1/reimb-links',
      method: 'POST',
      key: 'link-key',
      body: {
        inflow: { id: 'repay-owned', amount: 10 },
        expense: { id: 'expense', amount: -10 },
        allocationCents: 1000,
      },
    },
  ];

  for (const conflictCase of conflictCases) {
    const result = await request(base, conflictCase.route, conflictCase);
    assert.equal(result.response.status, 409, conflictCase.route);
    assert.equal(result.body.code, 'REPAYMENT_CONFIRMATION_IN_PROGRESS', conflictCase.route);
  }

  const effects = fs.readFileSync(marker, 'utf8').trim().split('\n').filter(Boolean);
  assert.ok(effects.every((line) => line.startsWith('mutation-preflight:')));
  assert.equal(effects.some((line) => line.includes('confirm-mutation')), false);
  assert.equal(effects.some((line) => line.includes('category-mutation')), false);
  assert.equal(effects.some((line) => line.includes('link-mutation')), false);
});
