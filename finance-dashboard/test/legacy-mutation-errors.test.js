'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const path = require('path');
const { startEphemeralDashboardServer } = require('./helpers/ephemeral-dashboard-server');

function manualAssetsEnvForDir(dir) {
  return {
    FINANCE_TIME_ZONE: 'America/Los_Angeles',
    ACTUAL_API_PATH: path.join(__dirname, 'fixtures', 'account-projection-actual.js'),
    ACTUAL_DATA_DIR: path.join(dir, 'actual-cache'),
    SPLITWISE_MIRROR_ACCOUNT_ID: 'acc-splitwise',
    ACCOUNT_OVERRIDES_PATH: path.join(dir, 'account-overrides.json'),
    MANUAL_ASSETS_PATH: path.join(dir, 'manual-assets.json'),
    GOALS_PATH: path.join(dir, 'goals.json'),
    SELFTEST: '1',
  };
}

function seedFixtures(dir) {
  fs.writeFileSync(path.join(dir, 'account-overrides.json'), JSON.stringify({
    schemaVersion: 2,
    accounts: {
      'acc-open': { name: 'Open', role: 'operating_cash' },
      'acc-closed': { name: 'Closed', role: 'operating_cash', closed: true },
    },
  }, null, 2));
  fs.writeFileSync(path.join(dir, 'manual-assets.json'), JSON.stringify({ items: [] }, null, 2));
  fs.writeFileSync(path.join(dir, 'goals.json'), JSON.stringify([], null, 2));
}

async function legacyPost(base, pathname, body) {
  const response = await fetch(`${base}${pathname}`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(body),
  });
  return { response, body: await response.json() };
}

async function v1Post(base, pathname, { key, body } = {}) {
  const response = await fetch(`${base}${pathname}`, {
    method: 'POST',
    headers: {
      'X-Finance-Token': 'test-api-token',
      'Content-Type': 'application/json',
      ...(key ? { 'Idempotency-Key': key } : {}),
    },
    body: JSON.stringify(body),
  });
  return { response, body: await response.json() };
}

function journalRecord(journalPath, key) {
  return JSON.parse(fs.readFileSync(journalPath, 'utf8')).operations[key];
}

async function assertTerminalFailedReplay(base, journalPath, key, expected) {
  let result = await v1Post(base, expected.path, { key, body: expected.body });
  assert.equal(result.response.status, expected.status);
  assert.equal(result.body.code, expected.code);
  assert.equal(result.body.error, expected.error);

  result = await v1Post(base, expected.path, { key, body: expected.body });
  assert.equal(result.response.status, expected.status);
  assert.equal(result.body.code, expected.code);
  assert.equal(result.body.error, expected.error);

  const operation = await fetch(`${base}/api/v1/operations/${key}`, {
    headers: { 'X-Finance-Token': 'test-api-token' },
  });
  assert.equal(operation.status, 200);
  const operationBody = await operation.json();
  assert.equal(operationBody.data.status, 'failed');
  assert.equal(operationBody.data.phase, 'failed');
  assert.equal(operationBody.data.terminal, true);
  assert.equal(operationBody.data.outcome, 'failed');
  assert.deepEqual(operationBody.data.error, {
    code: expected.code,
    message: expected.error,
    status: expected.status,
  });

  const record = journalRecord(journalPath, key);
  assert.equal(record.knownBeforeApply, true);
  assert.equal(Object.hasOwn(record, 'localAppliedAt'), false);
  assert.equal(Object.hasOwn(record, 'provisionalResult'), false);
  assert.notEqual(record.phase, 'started');
  assert.notEqual(result.body.code, 'OUTCOME_UNKNOWN');
  return record;
}

test('legacy manual-asset update with unknown id returns typed 404 envelope', async (t) => {
  const { base } = await startEphemeralDashboardServer(t, {
    tempPrefix: 'darkfinances-legacy-manual-asset-404-',
    demoOnly: false,
    extraEnvForDir: (dirPath) => {
      seedFixtures(dirPath);
      return manualAssetsEnvForDir(dirPath);
    },
  });

  const result = await legacyPost(base, '/api/manual-assets', {
    id: 'missing-manual-asset',
    name: 'Boat',
    value: 250,
    kind: 'asset',
  });
  assert.equal(result.response.status, 404);
  assert.equal(result.body.code, 'NOT_FOUND');
  assert.equal(result.body.error, 'Manual asset not found');
  assert.match(result.body.requestId, /^[0-9a-f-]{36}$/i);
});

test('legacy goal save returns typed account-link errors instead of generic 500', async (t) => {
  const { base } = await startEphemeralDashboardServer(t, {
    tempPrefix: 'darkfinances-legacy-goal-errors-',
    demoOnly: false,
    preloadBody: `
      const path = require('path');
      const actualPath = require.resolve(process.env.ACTUAL_API_PATH);
      const actual = require(actualPath);
      require.cache[actualPath] = {
        id: actualPath,
        filename: actualPath,
        loaded: true,
        exports: {
          ...actual,
          async getAccounts() {
            return [
              ...(await actual.getAccounts()),
              { id: 'acc-closed', name: 'Closed', closed: true, offbudget: false },
            ];
          },
        },
        children: [],
        paths: [],
      };
    `,
    extraEnvForDir: (dirPath) => {
      seedFixtures(dirPath);
      return manualAssetsEnvForDir(dirPath);
    },
  });

  let result = await legacyPost(base, '/api/goals', {
    name: 'Vacation',
    target: 5000,
    current: 0,
    accountId: 'missing-account',
  });
  assert.equal(result.response.status, 404);
  assert.equal(result.body.code, 'ACCOUNT_NOT_FOUND');
  assert.equal(result.body.error, 'Linked account not found');

  result = await legacyPost(base, '/api/goals', {
    name: 'Vacation',
    target: 5000,
    current: 0,
    accountId: 'acc-closed',
  });
  assert.equal(result.response.status, 409);
  assert.equal(result.body.code, 'ACCOUNT_CLOSED');
  assert.equal(result.body.error, 'Linked account is closed');
});

test('legacy unknown internal failures stay generic 500 envelopes', async (t) => {
  const { base } = await startEphemeralDashboardServer(t, {
    tempPrefix: 'darkfinances-legacy-internal-500-',
    demoOnly: false,
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
            if (property === 'saveManualAsset') {
              return async () => { throw new Error('injected internal manual asset failure'); };
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
    extraEnvForDir: (dirPath) => {
      seedFixtures(dirPath);
      return manualAssetsEnvForDir(dirPath);
    },
  });

  const result = await legacyPost(base, '/api/manual-assets', {
    name: 'Boat',
    value: 250,
    kind: 'asset',
  });
  assert.equal(result.response.status, 500);
  assert.equal(result.body.code, 'INTERNAL_ERROR');
  assert.equal(result.body.error, 'Request failed');
  assert.equal(String(JSON.stringify(result.body)).includes('injected'), false);
});

test('v1 manual-asset update with unknown id journals knownBeforeApply and replays without mutation', async (t) => {
  let journalPath;
  let manualAssetsPath;
  const { base } = await startEphemeralDashboardServer(t, {
    tempPrefix: 'darkfinances-v1-manual-asset-404-',
    demoOnly: false,
    extraEnvForDir: (dirPath) => {
      seedFixtures(dirPath);
      journalPath = path.join(dirPath, 'operation-journal.json');
      manualAssetsPath = path.join(dirPath, 'manual-assets.json');
      return {
        ...manualAssetsEnvForDir(dirPath),
        OPERATION_JOURNAL_PATH: journalPath,
      };
    },
  });

  const before = fs.readFileSync(manualAssetsPath, 'utf8');
  await assertTerminalFailedReplay(base, journalPath, 'v1-manual-asset-missing', {
    path: '/api/v1/manual-assets',
    status: 404,
    code: 'NOT_FOUND',
    error: 'Manual asset not found',
    body: {
      id: 'missing-manual-asset',
      name: 'Boat',
      value: 250,
      kind: 'asset',
    },
  });
  assert.equal(fs.readFileSync(manualAssetsPath, 'utf8'), before);
});

test('v1 goal save journals typed account-link failures before applyLocal', async (t) => {
  let journalPath;
  let goalsPath;
  const { base } = await startEphemeralDashboardServer(t, {
    tempPrefix: 'darkfinances-v1-goal-errors-',
    demoOnly: false,
    preloadBody: `
      const path = require('path');
      const actualPath = require.resolve(process.env.ACTUAL_API_PATH);
      const actual = require(actualPath);
      require.cache[actualPath] = {
        id: actualPath,
        filename: actualPath,
        loaded: true,
        exports: {
          ...actual,
          async getAccounts() {
            return [
              ...(await actual.getAccounts()),
              { id: 'acc-closed', name: 'Closed', closed: true, offbudget: false },
            ];
          },
        },
        children: [],
        paths: [],
      };
    `,
    extraEnvForDir: (dirPath) => {
      seedFixtures(dirPath);
      journalPath = path.join(dirPath, 'operation-journal.json');
      goalsPath = path.join(dirPath, 'goals.json');
      return {
        ...manualAssetsEnvForDir(dirPath),
        OPERATION_JOURNAL_PATH: journalPath,
      };
    },
  });

  const before = fs.readFileSync(goalsPath, 'utf8');
  await assertTerminalFailedReplay(base, journalPath, 'v1-goal-missing-account', {
    path: '/api/v1/goals',
    status: 404,
    code: 'ACCOUNT_NOT_FOUND',
    error: 'Linked account not found',
    body: {
      name: 'Vacation',
      target: 5000,
      current: 0,
      accountId: 'missing-account',
    },
  });
  assert.equal(fs.readFileSync(goalsPath, 'utf8'), before);

  await assertTerminalFailedReplay(base, journalPath, 'v1-goal-closed-account', {
    path: '/api/v1/goals',
    status: 409,
    code: 'ACCOUNT_CLOSED',
    error: 'Linked account is closed',
    body: {
      name: 'Vacation',
      target: 5000,
      current: 0,
      accountId: 'acc-closed',
    },
  });
  assert.equal(fs.readFileSync(goalsPath, 'utf8'), before);
});
