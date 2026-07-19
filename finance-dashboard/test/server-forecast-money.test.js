'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const { startEphemeralDashboardServer } = require('./helpers/ephemeral-dashboard-server');

const FORECAST_ERROR_PRELOAD = `
    const path = require('path');
    const dataPath = require.resolve(path.join(process.env.TEST_DASHBOARD_ROOT, 'dataModule.js'));
    const { ForecastMoneyValidationError } = require(path.join(process.env.TEST_DASHBOARD_ROOT, 'lib/errors'));
    require.cache[dataPath] = {
      id: dataPath,
      filename: dataPath,
      loaded: true,
      exports: {
        initApi: async () => ({ ok: true }),
        shutdownApi: async () => ({ ok: true }),
        getHealth: () => ({ ready: true }),
        getForecast: async () => { throw new ForecastMoneyValidationError(); },
      },
      children: [],
      paths: [],
    };
  `;

test('forecast endpoint returns controlled unavailable error for invalid money', async (t) => {
  const { base } = await startEphemeralDashboardServer(t, {
    tempPrefix: 'darkfinances-forecast-money-',
    demoOnly: false,
    extraEnvForDir: () => ({ SELFTEST: '1' }),
    preloadBody: FORECAST_ERROR_PRELOAD,
  });

  const response = await fetch(`${base}/api/v1/forecast?days=30`, {
    headers: { 'X-Finance-Token': 'test-api-token' },
  });
  const body = await response.json();
  assert.equal(response.status, 400);
  assert.equal(body.code, 'FORECAST_MONEY_INVALID');
  assert.equal(body.error, 'Forecast money input is invalid');
  assert.equal(JSON.stringify(body).includes(String(Number.MAX_VALUE)), false);
});

test('forecast endpoint returns complete assumptions aliases for valid demo forecast', async (t) => {
  const { base } = await startEphemeralDashboardServer(t, {
    tempPrefix: 'darkfinances-forecast-demo-',
    extraEnvForDir: () => ({ SELFTEST: '1' }),
  });

  const response = await fetch(`${base}/api/v1/forecast?days=30`, {
    headers: { 'X-Demo-Mode': '1' },
  });
  const payload = await response.json();
  assert.equal(response.status, 200);
  const assumptions = payload.data.assumptions;
  assert.equal(assumptions.stsContainment.complete, false);
  assert.ok(assumptions.stsContainment.incompleteReasons.includes('budget_data_unavailable'));
  assert.equal(assumptions.projectionContainment.complete, false);
  assert.equal(assumptions.projectionContainment.stsContainmentIncomplete, true);
  assert.equal(assumptions.genericBudget.complete, false);
  assert.equal(assumptions.genericBudgetTarget, assumptions.genericBudget.target);
  assert.ok(payload.data.warnings.some((warning) => /Safe-to-Spend containment incomplete/.test(warning)));
  assert.ok(!payload.data.warnings.some((warning) => /category amounts are not safe integer cents/.test(warning)));
});
