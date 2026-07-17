const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const os = require('os');
const path = require('path');
const { statePath } = require('../lib/state-registry');
const { writeRuntimeState, resetWriteGuards } = require('../lib/runtime-state-store');
const { readAccountOverrides, migrateAccountOverrides } = require('../lib/account-overrides');

function tempEnv(t) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'darkfinances-account-overrides-'));
  const env = { ...process.env, ACCOUNT_OVERRIDES_PATH: path.join(dir, 'account-overrides.json') };
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
  return { dir, env, file: env.ACCOUNT_OVERRIDES_PATH };
}

test('account overrides v2 envelope migrates legacy flat map', () => {
  const migrated = migrateAccountOverrides({ acct1: { hidden: true, role: 'operating_cash' } });
  assert.deepEqual(migrated, {
    schemaVersion: 2,
    accounts: { acct1: { hidden: true, role: 'operating_cash' } },
  });
});

test('readAccountOverrides routes through runtime-state API', (t) => {
  resetWriteGuards();
  const { env, file } = tempEnv(t);
  writeRuntimeState('accountOverrides', {
    schemaVersion: 2,
    accounts: { hidden1: { hidden: true }, visible1: { role: 'operating_cash' } },
  }, { env, file });
  const store = readAccountOverrides(file);
  assert.equal(store.schemaVersion, 2);
  assert.equal(store.accounts.hidden1.hidden, true);
});

test('getTrends hidden-account filter uses v2 accountOverrides.accounts', async (t) => {
  resetWriteGuards();
  const { env, file } = tempEnv(t);
  writeRuntimeState('accountOverrides', {
    schemaVersion: 2,
    accounts: { hidden1: { hidden: true }, visible1: { role: 'operating_cash' } },
  }, { env, file });

  const overrides = readAccountOverrides(file).accounts;
  const accounts = [
    { id: 'hidden1', name: 'Hidden', offbudget: false },
    { id: 'visible1', name: 'Visible', offbudget: false },
  ].filter((account) => !overrides[account.id]?.hidden);

  assert.deepEqual(accounts.map((account) => account.id), ['visible1']);

  const dataModulePath = path.join(__dirname, '..', 'dataModule.js');
  const source = fs.readFileSync(dataModulePath, 'utf8');
  assert.match(source, /readAccountOverrides\(ACCOUNT_OVERRIDES_PATH\)\.accounts/);
  assert.doesNotMatch(source, /readJsonSafe\(ACCOUNT_OVERRIDES_PATH/);
});
