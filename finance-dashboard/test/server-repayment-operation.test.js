'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const path = require('path');
const { startEphemeralDashboardServer } = require('./helpers/ephemeral-dashboard-server');

async function request(base, route, { method = 'POST', key, body } = {}) {
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

function readJournal(journalPath) {
  return JSON.parse(fs.readFileSync(journalPath, 'utf8'));
}

async function startRepaymentServer(t, { tempPrefix, preloadBody, withSagaPath = false }) {
  let journalPath;
  let sagaPath;
  const started = await startEphemeralDashboardServer(t, {
    tempPrefix,
    preloadBody,
    extraEnvForDir: (dir) => {
      journalPath = path.join(dir, 'operation-journal.json');
      sagaPath = withSagaPath ? path.join(dir, 'repayment-confirmation-sagas.json') : undefined;
      return withSagaPath ? { REPAYMENT_CONFIRMATION_SAGAS_PATH: sagaPath } : {};
    },
  });
  return {
    ...started,
    journalPath,
    sagaPath,
    marker: started.effectMarkerPath,
  };
}

test('repayment confirm validates before applyLocal and correlates saga identity to the journal key', async (t) => {
  const { base, journalPath, sagaPath, marker } = await startRepaymentServer(t, {
    tempPrefix: 'darkfinances-repay-operation-',
    withSagaPath: true,
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
      assertTransactionMutationAvailable: ({ ids = [] }) => {
        mark('preflight:' + ids.filter(Boolean).join(','));
      },
      validateRepaymentConfirmationAdmission: async ({ id }) => {
        mark('validate:' + id);
        return {
          accountId: 'account',
          suggestionId: id,
          reimbCategoryId: 'reimb-category',
          person: 'alex',
          inflowTransaction: { id: 'repay-inflow', date: '2026-07-10', amount: 5000, payeeName: 'Alex' },
          expenseTransactions: {},
          allocations: [],
          existingLinks: [],
        };
      },
      confirmRepayment: async ({ operationIdentity, admission }) => {
        mark('confirm:' + operationIdentity + ':' + admission.suggestionId);
        fs.writeFileSync(process.env.REPAYMENT_CONFIRMATION_SAGAS_PATH, JSON.stringify({
          schemaVersion: 1,
          sagas: {
            [operationIdentity]: {
              id: operationIdentity,
              recordVersion: 1,
              phase: 'sync_pending',
              suggestionId: admission.suggestionId,
            },
          },
        }, null, 2) + '\\n');
        return { ok: true, inflowId: 'repay-inflow', linked: 0 };
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

  const key = 'repay-confirm-op-key';
  const result = await request(base, '/api/v1/repayments/sg_repay-inflow/confirm', { key });
  assert.equal(result.response.status, 200);
  assert.equal(result.body.data.inflowId, 'repay-inflow');

  const effects = fs.readFileSync(marker, 'utf8').trim().split('\n');
  assert.deepEqual(effects, [
    'preflight:repay-inflow',
    'validate:sg_repay-inflow',
    'confirm:repay-confirm-op-key:sg_repay-inflow',
    'sync',
  ]);

  const saga = readJournal(journalPath).operations[key];
  assert.equal(saga.phase, 'completed');
  assert.equal(JSON.parse(fs.readFileSync(sagaPath, 'utf8')).sagas[key].id, key);
});

test('stale repayment admission is a terminal known pre-apply failure; post-apply failures stay unknown', async (t) => {
  const { base, journalPath, marker } = await startRepaymentServer(t, {
    tempPrefix: 'darkfinances-repay-operation-failures-',
    preloadBody: `
    const fs = require('fs');
    const path = require('path');
    const dataPath = require.resolve(path.join(process.env.TEST_DASHBOARD_ROOT, 'dataModule.js'));
    const {
      RepaymentSuggestionInvalidError,
    } = require(path.join(process.env.TEST_DASHBOARD_ROOT, 'lib/repayment-confirmation-admission.js'));
    const mark = (value) => fs.appendFileSync(process.env.TEST_EFFECT_MARKER, value + '\\n');
    const mock = new Proxy({
      initApi: async () => ({ ok: true }),
      shutdownApi: async () => ({ ok: true }),
      getHealth: () => ({ ready: true }),
      assertTransactionMutationAvailable: () => {},
      validateRepaymentConfirmationAdmission: async ({ id }) => {
        mark('validate:' + id);
        if (id === 'sg_missing') throw new RepaymentSuggestionInvalidError();
        return {
          accountId: 'account',
          suggestionId: id,
          reimbCategoryId: 'reimb-category',
          person: 'alex',
          inflowTransaction: { id: 'repay-inflow', date: '2026-07-10', amount: 5000 },
          expenseTransactions: {},
          allocations: [],
          existingLinks: [],
        };
      },
      confirmRepayment: async () => {
        mark('confirm-throw');
        throw new Error('saga write lost after crossing effect boundary');
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

  const staleKey = 'repay-stale-key';
  const stale = await request(base, '/api/v1/repayments/sg_missing/confirm', { key: staleKey });
  assert.equal(stale.response.status, 409);
  assert.equal(stale.body.code, 'REPAYMENT_SUGGESTION_INVALID');
  assert.equal(readJournal(journalPath).operations[staleKey].phase, 'failed');
  assert.equal(fs.readFileSync(marker, 'utf8').includes('confirm-throw'), false);

  const unknownKey = 'repay-unknown-key';
  const unknown = await request(base, '/api/v1/repayments/sg_repay-inflow/confirm', { key: unknownKey });
  assert.equal(unknown.response.status, 409);
  assert.equal(unknown.body.code, 'OUTCOME_UNKNOWN');
  assert.equal(readJournal(journalPath).operations[unknownKey].phase, 'started');
  assert.match(fs.readFileSync(marker, 'utf8'), /confirm-throw/);
});

test('invalid allocation plan is a terminal known pre-apply failure with no saga or effects', async (t) => {
  const { base, journalPath, sagaPath, marker } = await startRepaymentServer(t, {
    tempPrefix: 'darkfinances-repay-operation-plan-',
    withSagaPath: true,
    preloadBody: `
    const fs = require('fs');
    const path = require('path');
    const dataPath = require.resolve(path.join(process.env.TEST_DASHBOARD_ROOT, 'dataModule.js'));
    const {
      RepaymentAllocationPlanInvalidError,
    } = require(path.join(process.env.TEST_DASHBOARD_ROOT, 'lib/repayment-confirmation-admission.js'));
    const mark = (value) => fs.appendFileSync(process.env.TEST_EFFECT_MARKER, value + '\\n');
    const mock = new Proxy({
      initApi: async () => ({ ok: true }),
      shutdownApi: async () => ({ ok: true }),
      getHealth: () => ({ ready: true }),
      assertTransactionMutationAvailable: () => {},
      validateRepaymentConfirmationAdmission: async ({ id }) => {
        mark('validate:' + id);
        throw new RepaymentAllocationPlanInvalidError('allocation plan exceeds inflow amount');
      },
      confirmRepayment: async () => {
        mark('confirm-should-not-run');
      },
      syncNow: async () => { mark('sync-should-not-run'); },
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

  const key = 'repay-plan-invalid-key';
  const result = await request(base, '/api/v1/repayments/sg_repay-inflow/confirm', { key });
  assert.equal(result.response.status, 409);
  assert.equal(result.body.code, 'REPAYMENT_ALLOCATION_PLAN_INVALID');
  assert.equal(readJournal(journalPath).operations[key].phase, 'failed');
  assert.equal(fs.existsSync(sagaPath), false);
  assert.deepEqual(fs.readFileSync(marker, 'utf8').trim().split('\n'), ['validate:sg_repay-inflow']);
});
