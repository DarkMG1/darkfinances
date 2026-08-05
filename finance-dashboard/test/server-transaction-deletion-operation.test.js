'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const path = require('path');
const { startEphemeralDashboardServer } = require('./helpers/ephemeral-dashboard-server');

async function request(base, route, { method = 'GET', key } = {}) {
  const response = await fetch(`${base}${route}`, {
    method,
    headers: {
      'X-Finance-Token': 'test-api-token',
      ...(key ? { 'Idempotency-Key': key } : {}),
    },
  });
  return { response, body: await response.json() };
}

test('DELETE journals local apply, sync uncertainty, and status-only recovery', async (t) => {
  const { base, dir } = await startEphemeralDashboardServer(t, {
    tempPrefix: 'darkfinances-deletion-operation-',
    preloadBody: `
    const fs = require('fs');
    const path = require('path');
    const dataPath = require.resolve(path.join(process.env.TEST_DASHBOARD_ROOT, 'dataModule.js'));
    const {
      AccountNotFoundError,
      ImportedTransactionError,
      SplitLegDeleteError,
      SplitParentNotFoundError,
      TransactionNotFoundError,
    } = require(path.join(process.env.TEST_DASHBOARD_ROOT, 'lib/errors.js'));
    const mark = (value) => fs.appendFileSync(process.env.TEST_EFFECT_MARKER, value + '\\n');
    let currentId = null;
    const mock = new Proxy({
      initApi: async () => ({ ok: true }),
      shutdownApi: async () => ({ ok: true }),
      getHealth: () => ({ ready: true }),
      assertTransactionMutationAvailable: ({ ids }) => {
        currentId = String(ids[0]);
        mark('preflight:' + currentId);
      },
      preflightTransactionDeletion: async ({ id, accountId }) => {
        currentId = String(id);
        mark('domain-preflight:' + currentId);
        if (accountId === 'missing-account') throw new AccountNotFoundError();
        if (currentId === 'missing-transaction') throw new TransactionNotFoundError();
        if (currentId === 'imported') throw new ImportedTransactionError();
        if (currentId === 'split-leg') throw new SplitLegDeleteError();
        if (currentId === 'split-parent-missing') throw new SplitParentNotFoundError();
        return { ok: true };
      },
      deleteTransaction: async ({ id }) => {
        currentId = String(id);
        mark('local-delete:' + currentId);
        if (currentId === 'delete-throws') {
          mark('actual-delete-applied:' + currentId);
          throw new Error('delete response lost after apply');
        }
        return {
          ok: true,
          deleted: currentId,
          references: {
            receipts: 1,
            links: 0,
            suggestions: 0,
            reconciliation: 0,
            phantomSeen: 0,
      reviewState: 0,
            reviewState: 0,
          },
        };
      },
      syncNow: async () => {
        mark('sync:' + currentId);
        if (currentId === 'sync-fail') throw new Error('sync unavailable');
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

  for (const failure of [
    {
      id: 'missing-transaction',
      accountId: 'account',
      status: 404,
      code: 'TRANSACTION_NOT_FOUND',
      message: 'Transaction not found',
    },
    {
      id: 'imported',
      accountId: 'account',
      status: 409,
      code: 'IMPORTED_TRANSACTION',
      message: 'Bank-imported transactions can’t be deleted — only ones you added manually.',
    },
    {
      id: 'split-leg',
      accountId: 'account',
      status: 400,
      code: 'INVALID_REQUEST',
      message: 'Split legs cannot be deleted independently',
    },
    {
      id: 'split-parent-missing',
      accountId: 'account',
      status: 404,
      code: 'NOT_FOUND',
      message: 'Split parent not found',
    },
    {
      id: 'account-transaction',
      accountId: 'missing-account',
      status: 404,
      code: 'ACCOUNT_NOT_FOUND',
      message: 'Account not found',
    },
  ]) {
    const key = `delete-preflight-${failure.id}`;
    const route = `/api/v1/transactions/${failure.id}?accountId=${failure.accountId}&date=2026-07-10`;
    const effectsBefore = fs.existsSync(marker) ? fs.readFileSync(marker, 'utf8') : '';
    let failed = await request(base, route, { method: 'DELETE', key });
    assert.equal(failed.response.status, failure.status, failure.id);
    assert.equal(failed.body.code, failure.code, failure.id);
    assert.equal(failed.body.error, failure.message, failure.id);
    const effectsAfter = fs.readFileSync(marker, 'utf8');
    assert.notEqual(effectsAfter, effectsBefore, failure.id);
    assert.equal(effectsAfter.includes(`local-delete:${failure.id}`), false, failure.id);

    failed = await request(base, route, { method: 'DELETE', key });
    assert.equal(failed.response.status, failure.status, failure.id);
    assert.equal(failed.body.code, failure.code, failure.id);
    assert.equal(fs.readFileSync(marker, 'utf8'), effectsAfter, failure.id);

    const status = await request(base, `/api/v1/operations/${key}`);
    assert.equal(status.response.status, 200, failure.id);
    assert.equal(status.body.data.phase, 'failed', failure.id);
    assert.equal(status.body.data.outcome, 'failed', failure.id);
    assert.deepEqual(status.body.data.error, {
      code: failure.code,
      message: failure.message,
      status: failure.status,
    }, failure.id);
    const record = JSON.parse(
      fs.readFileSync(path.join(dir, 'operation-journal.json'), 'utf8'),
    ).operations[key];
    assert.equal(record.knownBeforeApply, true, failure.id);
    assert.equal(Object.hasOwn(record, 'localAppliedAt'), false, failure.id);
  }

  const successKey = 'delete-success';
  let result = await request(
    base,
    '/api/v1/transactions/success?accountId=account&date=2026-07-10',
    { method: 'DELETE', key: successKey },
  );
  assert.equal(result.response.status, 200);
  assert.deepEqual(result.body.data, {
    ok: true,
    deleted: 'success',
    references: {
      receipts: 1,
      links: 0,
      suggestions: 0,
      reconciliation: 0,
      phantomSeen: 0,
      reviewState: 0,
    },
  });
  assert.deepEqual(result.body.operation, { key: successKey, replayed: false });
  result = await request(base, `/api/v1/operations/${successKey}`);
  assert.equal(result.body.data.phase, 'completed');
  assert.equal(result.body.data.outcome, 'completed');

  const syncKey = 'delete-sync-failure';
  result = await request(
    base,
    '/api/v1/transactions/sync-fail?accountId=account&date=2026-07-10',
    { method: 'DELETE', key: syncKey },
  );
  assert.equal(result.response.status, 409);
  assert.equal(result.body.code, 'OUTCOME_UNKNOWN');
  result = await request(base, `/api/v1/operations/${syncKey}`);
  assert.equal(result.body.data.phase, 'sync_unknown');
  assert.equal(result.body.data.outcome, 'unknown');
  const effectsBeforeSyncRetry = fs.readFileSync(marker, 'utf8');
  result = await request(
    base,
    '/api/v1/transactions/sync-fail?accountId=account&date=2026-07-10',
    { method: 'DELETE', key: syncKey },
  );
  assert.equal(result.response.status, 409);
  assert.equal(result.body.code, 'OUTCOME_UNKNOWN');
  assert.equal(fs.readFileSync(marker, 'utf8'), effectsBeforeSyncRetry);

  const deleteKey = 'delete-response-lost';
  result = await request(
    base,
    '/api/v1/transactions/delete-throws?accountId=account&date=2026-07-10',
    { method: 'DELETE', key: deleteKey },
  );
  assert.equal(result.response.status, 409);
  assert.equal(result.body.code, 'OUTCOME_UNKNOWN');
  result = await request(base, `/api/v1/operations/${deleteKey}`);
  assert.equal(result.body.data.phase, 'started');
  assert.equal(result.body.data.outcome, 'unknown');
  const effectsBeforeDeleteRetry = fs.readFileSync(marker, 'utf8');
  result = await request(
    base,
    '/api/v1/transactions/delete-throws?accountId=account&date=2026-07-10',
    { method: 'DELETE', key: deleteKey },
  );
  assert.equal(result.response.status, 409);
  assert.equal(result.body.code, 'OUTCOME_UNKNOWN');
  assert.equal(fs.readFileSync(marker, 'utf8'), effectsBeforeDeleteRetry);

  const effects = fs.readFileSync(marker, 'utf8').trim().split('\n');
  const successStart = effects.indexOf('preflight:success');
  assert.deepEqual(effects.slice(successStart, successStart + 4), [
    'preflight:success',
    'domain-preflight:success',
    'local-delete:success',
    'sync:success',
  ]);
  assert.equal(effects.filter((value) => value === 'local-delete:sync-fail').length, 1);
  assert.equal(effects.filter((value) => value === 'sync:sync-fail').length, 1);
  assert.equal(effects.filter((value) => value === 'local-delete:delete-throws').length, 1);
  assert.equal(effects.filter((value) => value === 'actual-delete-applied:delete-throws').length, 1);
});
