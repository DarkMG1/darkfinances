'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const { mock } = require('node:test');
const fs = require('fs');
const os = require('os');
const path = require('path');

process.env.FINANCE_TIME_ZONE = 'America/Los_Angeles';

const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'darkfinances-today-manual-assets-'));
process.env.ACTUAL_API_PATH = path.join(__dirname, 'fixtures', 'account-projection-actual.js');
process.env.ACTUAL_DATA_DIR = path.join(dir, 'actual-cache');
process.env.SPLITWISE_MIRROR_ACCOUNT_ID = 'acc-splitwise';
for (const [env, filename] of Object.entries({
  ACCOUNT_OVERRIDES_PATH: 'account-overrides.json',
  BILLS_PAID_PATH: 'bills-paid.json',
  BUDGET_SETTINGS_PATH: 'budget-settings.json',
  EVENTS_PATH: 'events.json',
  GOALS_PATH: 'goals.json',
  OWES_CONFIG_PATH: 'owes-config.json',
  OWES_TRUTH_PATH: 'owes-truth.json',
  PERSONAL_CONFIG_PATH: 'personal-config.json',
  RECEIPTS_PATH: 'receipts.json',
  RECON_PATH: 'reconciliation.json',
  REIMB_LINKS_PATH: 'reimb-links.json',
  REIMB_SUGGEST_PATH: 'reimb-suggest.json',
  RECURRING_OVERRIDES_PATH: 'recurring-overrides.json',
  REVIEW_STATE_PATH: 'review-state.json',
  TRANSACTION_SAGAS_PATH: 'transaction-sagas.json',
  MANUAL_ASSETS_PATH: 'manual-assets.json',
  VENMO_TRUTH_PATH: 'venmo-truth.json',
  DEBT_PLANNER_PATH: 'debt-planner.json',
})) process.env[env] = path.join(dir, filename);

const {
  getToday,
  getManualAssets,
  saveManualAsset,
  deleteManualAsset,
  resetApi,
} = require('../dataModule');
const { manualAssetsRevision, validateManualAssetsStore } = require('../lib/manual-assets-projection');

test.after(() => fs.rmSync(dir, { recursive: true, force: true }));

function writeJson(file, value) {
  fs.writeFileSync(file, `${JSON.stringify(value, null, 2)}\n`);
}

async function withFinanceAnchor(fn) {
  mock.timers.enable({ apis: ['Date'], now: new Date('2026-07-15T17:01:00-07:00') });
  try {
    return await fn();
  } finally {
    mock.timers.reset();
  }
}

test('manual asset save/delete changes Today revision and manualAssetsRevision only', async () => {
  await withFinanceAnchor(async () => {
    resetApi();
    writeJson(process.env.ACCOUNT_OVERRIDES_PATH, {
      schemaVersion: 2,
      accounts: {
        'acc-check': { name: 'Everyday', role: 'operating_cash' },
        'acc-save': { role: 'protected_savings' },
        'acc-credit': { role: 'credit_card' },
        'acc-hidden': { hidden: true, role: 'credit_card' },
        'acc-excluded': { role: 'excluded' },
        'acc-splitwise': { role: 'operating_cash' },
      },
    });
    writeJson(process.env.MANUAL_ASSETS_PATH, { items: [] });

    const before = await getToday();
    const accountRevBefore = before.scope.accountProjectionRevision;
    const manualRevBefore = before.scope.manualAssetsRevision;
    assert.ok(accountRevBefore);
    assert.ok(manualRevBefore);

    saveManualAsset({ name: 'Boat', value: 250, kind: 'asset' });
    const afterSave = await getToday();
    assert.notEqual(afterSave.revision, before.revision);
    assert.notEqual(afterSave.scope.manualAssetsRevision, manualRevBefore);
    assert.equal(afterSave.scope.accountProjectionRevision, accountRevBefore);
    if (before.metrics.netWorth.complete && afterSave.metrics.netWorth.complete) {
      assert.ok((afterSave.metrics.netWorth.value ?? 0) > (before.metrics.netWorth.value ?? 0));
    }

    const assets = getManualAssets();
    const savedId = assets.items[0].id;
    deleteManualAsset({ id: savedId });
    const afterDelete = await getToday();
    assert.notEqual(afterDelete.revision, afterSave.revision);
    assert.notEqual(afterDelete.scope.manualAssetsRevision, afterSave.scope.manualAssetsRevision);
    assert.equal(afterDelete.scope.accountProjectionRevision, accountRevBefore);
    assert.equal(
      afterDelete.scope.manualAssetsRevision,
      manualAssetsRevision(validateManualAssetsStore({ items: [] })),
    );
  });
});
