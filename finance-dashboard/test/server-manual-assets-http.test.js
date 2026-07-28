'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const os = require('os');
const path = require('path');
const { mock } = require('node:test');
const { startEphemeralDashboardServer } = require('./helpers/ephemeral-dashboard-server');
const {
  childWatchContext,
  markPrelude,
  sidecarReleasePrelude,
  waitForMarkerDir,
} = require('./helpers/test-sync-barriers');

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
  const text = await response.text();
  let parsed;
  try { parsed = JSON.parse(text); } catch (_) { parsed = text; }
  return { response, body: parsed };
}

function manualAssetsEnvForDir(dir) {
  return {
    FINANCE_TIME_ZONE: 'America/Los_Angeles',
    ACTUAL_API_PATH: path.join(__dirname, 'fixtures', 'account-projection-actual.js'),
    ACTUAL_DATA_DIR: path.join(dir, 'actual-cache'),
    SPLITWISE_MIRROR_ACCOUNT_ID: 'acc-splitwise',
    ACCOUNT_OVERRIDES_PATH: path.join(dir, 'account-overrides.json'),
    MANUAL_ASSETS_PATH: path.join(dir, 'manual-assets.json'),
    BILLS_PAID_PATH: path.join(dir, 'bills-paid.json'),
    BUDGET_SETTINGS_PATH: path.join(dir, 'budget-settings.json'),
    EVENTS_PATH: path.join(dir, 'events.json'),
    GOALS_PATH: path.join(dir, 'goals.json'),
    OWES_CONFIG_PATH: path.join(dir, 'owes-config.json'),
    OWES_TRUTH_PATH: path.join(dir, 'owes-truth.json'),
    PERSONAL_CONFIG_PATH: path.join(dir, 'personal-config.json'),
    RECEIPTS_PATH: path.join(dir, 'receipts.json'),
    RECON_PATH: path.join(dir, 'reconciliation.json'),
    REIMB_LINKS_PATH: path.join(dir, 'reimb-links.json'),
    REIMB_SUGGEST_PATH: path.join(dir, 'reimb-suggest.json'),
    RECURRING_OVERRIDES_PATH: path.join(dir, 'recurring-overrides.json'),
    REVIEW_STATE_PATH: path.join(dir, 'review-state.json'),
    TRANSACTION_SAGAS_PATH: path.join(dir, 'transaction-sagas.json'),
    VENMO_TRUTH_PATH: path.join(dir, 'venmo-truth.json'),
    DEBT_PLANNER_PATH: path.join(dir, 'debt-planner.json'),
  };
}

function seedManualAssetsFixtures(dir) {
  fs.writeFileSync(path.join(dir, 'account-overrides.json'), JSON.stringify({
    schemaVersion: 2,
    accounts: {
      'acc-check': { name: 'Everyday', role: 'operating_cash' },
      'acc-save': { role: 'protected_savings' },
      'acc-credit': { role: 'credit_card' },
      'acc-hidden': { hidden: true, role: 'credit_card' },
      'acc-excluded': { role: 'excluded' },
      'acc-splitwise': { role: 'operating_cash' },
    },
  }, null, 2));
  fs.writeFileSync(path.join(dir, 'manual-assets.json'), JSON.stringify({ items: [] }, null, 2));
}

test('HTTP manual-asset route integration warms, saves, deletes, and refreshes Today revisions', async (t) => {
  mock.timers.enable({ apis: ['Date'], now: new Date('2026-07-15T17:01:00-07:00') });
  try {
    const { base } = await startEphemeralDashboardServer(t, {
      tempPrefix: 'darkfinances-manual-assets-http-',
      demoOnly: false,
      extraEnvForDir: (dir) => {
        seedManualAssetsFixtures(dir);
        return manualAssetsEnvForDir(dir);
      },
    });

    const warmToday = await apiRequest(base, '/api/v1/today');
    const warmManual = await apiRequest(base, '/api/v1/manual-assets');
    assert.equal(warmToday.response.status, 200);
    assert.equal(warmManual.response.status, 200);
    const revBefore = warmToday.body.data.revision;
    const manualRevBefore = warmToday.body.data.scope.manualAssetsRevision;
    const accountRevBefore = warmToday.body.data.scope.accountProjectionRevision;
    const nwBefore = warmToday.body.data.metrics?.netWorth?.value;

    const save = await apiRequest(base, '/api/v1/manual-assets', {
      method: 'POST',
      key: 'manual-http-save',
      body: { name: 'Boat', value: 250, kind: 'asset' },
    });
    assert.equal(save.response.status, 200);

    const afterSaveToday = await apiRequest(base, '/api/v1/today');
    const afterSaveManual = await apiRequest(base, '/api/v1/manual-assets');
    assert.equal(afterSaveToday.response.status, 200);
    assert.equal(afterSaveManual.response.status, 200);
    assert.notEqual(afterSaveToday.body.data.revision, revBefore);
    assert.notEqual(afterSaveToday.body.data.scope.manualAssetsRevision, manualRevBefore);
    assert.equal(afterSaveToday.body.data.scope.accountProjectionRevision, accountRevBefore);
    assert.equal(afterSaveManual.body.data.items.length, 1);
    assert.ok((afterSaveToday.body.data.metrics?.netWorth?.value ?? 0) >= (nwBefore ?? 0));

    const assetId = afterSaveManual.body.data.items[0].id;
    const del = await apiRequest(base, `/api/v1/manual-assets/${encodeURIComponent(assetId)}`, {
      method: 'DELETE',
      key: 'manual-http-delete',
    });
    assert.equal(del.response.status, 200);

    const afterDeleteToday = await apiRequest(base, '/api/v1/today');
    const afterDeleteManual = await apiRequest(base, '/api/v1/manual-assets');
    assert.equal(afterDeleteManual.body.data.items.length, 0);
    assert.notEqual(afterDeleteToday.body.data.revision, afterSaveToday.body.data.revision);
    assert.notEqual(afterDeleteToday.body.data.scope.manualAssetsRevision, afterSaveToday.body.data.scope.manualAssetsRevision);
  } finally {
    mock.timers.reset();
  }
});

test('manual asset OUTCOME_UNKNOWN still serves persisted mutation on subsequent reads', async (t) => {
  const { base, dir } = await startEphemeralDashboardServer(t, {
    tempPrefix: 'darkfinances-manual-assets-unknown-',
    demoOnly: false,
    extraEnvForDir: (dirPath) => {
      seedManualAssetsFixtures(dirPath);
      return manualAssetsEnvForDir(dirPath);
    },
    preloadBody: `
      const fs = require('fs');
      const path = require('path');
      const root = process.env.TEST_DASHBOARD_ROOT;
      const journalModPath = require.resolve(path.join(root, 'lib/operation-journal.js'));
      const journalMod = require(journalModPath);
      const OrigJournal = journalMod.OperationJournal;
      journalMod.OperationJournal = class PatchedOperationJournal extends OrigJournal {
        constructor(file, options = {}) {
          super(file, options);
          this._patchedWriteCount = 0;
        }
        writePruned(state) {
          this._patchedWriteCount += 1;
          if (this._patchedWriteCount === 2) {
            const error = new Error('injected local_applied journal failure');
            error.code = 'INJECTED_WRITE_FAILURE';
            throw error;
          }
          return super.writePruned(state);
        }
      };
    `,
  });

  const warmManual = await apiRequest(base, '/api/v1/manual-assets');
  assert.equal(warmManual.body.data.items.length, 0);

  const mutate = await apiRequest(base, '/api/v1/manual-assets', {
    method: 'POST',
    key: 'manual-unknown-save',
    body: { name: 'Boat', value: 250, kind: 'asset' },
  });
  assert.equal(mutate.response.status, 409);
  assert.equal(mutate.body.code, 'OUTCOME_UNKNOWN');

  const freshManual = await apiRequest(base, '/api/v1/manual-assets');
  const freshToday = await apiRequest(base, '/api/v1/today');
  assert.equal(freshManual.response.status, 200);
  assert.equal(freshToday.response.status, 200);
  assert.equal(freshManual.body.data.items.length, 1);
  assert.equal(freshManual.body.data.items[0].name, 'Boat');
  assert.ok(freshToday.body.data.scope.manualAssetsRevision);
  assert.ok(fs.existsSync(path.join(dir, 'manual-assets.json')));
});

test('in-flight manual-assets fill cannot publish post-mutation snapshot', async (t) => {
  const markLine = `
    const fs = require('fs');
    ${markPrelude()}
    ${sidecarReleasePrelude()}
  `;
  const started = await startEphemeralDashboardServer(t, {
    tempPrefix: 'darkfinances-manual-assets-race-',
    extraEnvForDir: (dirPath) => ({ TEST_RELEASE_PATH: path.join(dirPath, 'release.fill') }),
    preloadBody: `
      ${markLine}
      const path = require('path');
      const dataPath = require.resolve(path.join(process.env.TEST_DASHBOARD_ROOT, 'dataModule.js'));
      let manualNet = 0;
      let manualFillCount = 0;
      const mock = {
        initApi: async () => ({ ok: true }),
        shutdownApi: async () => ({ ok: true }),
        getHealth: () => ({ ready: true }),
        syncNow: async () => ({ ok: true }),
        getManualAssets: async () => {
          manualFillCount += 1;
          mark('manualAssets:fill:' + manualFillCount);
          if (manualFillCount === 1) await waitSidecarRelease();
          mark('manualAssets:done:' + manualFillCount + ':' + manualNet);
          return {
            items: manualNet ? [{ id: 'm1', name: 'Boat', value: manualNet, kind: 'asset' }] : [],
            assets: manualNet,
            liabilities: 0,
            net: manualNet,
            complete: true,
          };
        },
        getToday: async () => ({ manualNet }),
        assertManualAssetMutationAvailable: () => {},
        saveManualAsset: async ({ value }) => {
          mark('saveManualAsset');
          manualNet = value;
          return { ok: true, id: 'm1' };
        },
        deleteManualAsset: async () => ({ ok: true, removed: 1 }),
      };
      require.cache[dataPath] = { id: dataPath, filename: dataPath, loaded: true, exports: mock, children: [], paths: [] };
    `,
  });
  const { base, child, logs, dir, childState } = started;
  const releaseFill = () => fs.writeFileSync(path.join(dir, 'release.fill'), '1');

  const readPromise = apiRequest(base, '/api/v1/manual-assets');
  await waitForMarkerDir(dir, 'manualAssets:fill:1', childWatchContext({ child, logs, childState }));
  const mutatePromise = apiRequest(base, '/api/v1/manual-assets', {
    method: 'POST',
    key: 'manual-assets-race',
    body: { name: 'Boat', value: 250, kind: 'asset' },
  });
  releaseFill();
  const [{ body: inFlightBody }, { response: mutateResponse }] = await Promise.all([readPromise, mutatePromise]);
  assert.equal(mutateResponse.status, 200);
  assert.equal(inFlightBody.data.items.length, 0, 'in-flight manual-assets fill must not publish post-mutation snapshot');

  const freshManual = await apiRequest(base, '/api/v1/manual-assets');
  assert.equal(freshManual.body.data.items.length, 1);
  assert.equal(freshManual.body.data.items[0].value, 250);
});
