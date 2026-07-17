'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const os = require('os');
const path = require('path');
const NodeCache = require('node-cache');
const { resetActualCoordinator, getActualCoordinator } = require('../lib/actual-coordinator');

const FIXTURE = path.join(__dirname, 'fixtures', 'coordinator-actual.js');
const ENV_KEYS = [
  'ACTUAL_API_PATH',
  'ACTUAL_DATA_DIR',
  'ALLOW_RAW_ACTUAL_API',
  'OWES_TRUTH_PATH',
  'SPLITWISE_MIRROR_RESOLUTIONS_PATH',
  'SPLITWISE_CURRENCY',
  'OWES_SNAPSHOT_MAX_AGE_MS',
  'BULK_OPERATION_SAGAS_PATH',
  'TRANSACTION_DELETION_SAGAS_PATH',
  'TRANSACTION_SAGAS_PATH',
  'REPAYMENT_CONFIRMATION_SAGAS_PATH',
];
const savedEnv = Object.fromEntries(ENV_KEYS.map((key) => [key, process.env[key]]));

function restoreEnv() {
  for (const key of ENV_KEYS) {
    const value = savedEnv[key];
    if (value === undefined) delete process.env[key];
    else process.env[key] = value;
  }
}

function writeJson(file, value) {
  fs.writeFileSync(file, `${JSON.stringify(value, null, 2)}\n`);
}

function completeSnapshot() {
  return {
    schemaVersion: 2,
    generatedAt: new Date().toISOString(),
    manifest: {
      complete: true,
      itemizedComplete: true,
      resolvedEvents: 0,
      expectedEvents: 0,
      failedEvents: [],
      currency: 'USD',
    },
    othersPaidItems: [],
  };
}

function freshDataModule(dir, { allowRawApi = true } = {}) {
  process.env.ACTUAL_API_PATH = FIXTURE;
  process.env.ACTUAL_DATA_DIR = path.join(dir, 'actual-cache');
  if (allowRawApi) process.env.ALLOW_RAW_ACTUAL_API = '1';
  else delete process.env.ALLOW_RAW_ACTUAL_API;
  process.env.SPLITWISE_CURRENCY = 'USD';
  process.env.OWES_SNAPSHOT_MAX_AGE_MS = String(24 * 60 * 60 * 1000);
  process.env.OWES_TRUTH_PATH = path.join(dir, 'owes-truth.json');
  process.env.SPLITWISE_MIRROR_RESOLUTIONS_PATH = path.join(dir, 'splitwise-mirror-resolutions.json');
  process.env.BULK_OPERATION_SAGAS_PATH = path.join(dir, 'bulk-operation-sagas.json');
  process.env.TRANSACTION_DELETION_SAGAS_PATH = path.join(dir, 'transaction-deletion-sagas.json');
  process.env.TRANSACTION_SAGAS_PATH = path.join(dir, 'transaction-sagas.json');
  process.env.REPAYMENT_CONFIRMATION_SAGAS_PATH = path.join(dir, 'repayment-confirmation-sagas.json');
  writeJson(process.env.OWES_TRUTH_PATH, completeSnapshot());
  writeJson(process.env.SPLITWISE_MIRROR_RESOLUTIONS_PATH, { schemaVersion: 1, resolutions: [] });
  for (const file of [
    process.env.BULK_OPERATION_SAGAS_PATH,
    process.env.TRANSACTION_DELETION_SAGAS_PATH,
    process.env.TRANSACTION_SAGAS_PATH,
    process.env.REPAYMENT_CONFIRMATION_SAGAS_PATH,
  ]) {
    writeJson(file, { schemaVersion: 1, sagas: {} });
  }
  fs.mkdirSync(process.env.ACTUAL_DATA_DIR, { recursive: true });
  const dataPath = path.resolve(__dirname, '..', 'dataModule.js');
  delete require.cache[dataPath];
  delete require.cache[FIXTURE];
  resetActualCoordinator('integration-test');
  return require('../dataModule');
}

test.after(() => {
  restoreEnv();
});

test('real shutdownApi runs saga sync and api.shutdown after coordinator drain', async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'df-coordinator-shutdown-data-'));
  const data = freshDataModule(dir);
  const fixture = require(FIXTURE);
  await data.initApi({ skipRecover: true });
  await data.shutdownApi();
  const { shutdownCalls, events } = fixture.inspect();
  assert.equal(shutdownCalls, 1);
  assert.ok(events.includes('sync'));
  assert.ok(events.includes('shutdown'));
  assert.equal(getActualCoordinator().getHealth().shutdownFinalized, true);
  assert.equal(data.getHealth().ready, false);
});

test('preflightSplitwiseMirrorShareSync holds read lane through Actual enumeration', async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'df-preflight-lane-'));
  const data = freshDataModule(dir);
  const fixture = require(FIXTURE);
  let releasePreflight;
  const preflightGate = new Promise((resolve) => { releasePreflight = resolve; });
  fixture.configure({
    gates: {
      getAccounts: () => preflightGate,
    },
  });
  await data.initApi({ skipRecover: true });
  const events = [];
  const preflight = data.preflightSplitwiseMirrorShareSync().then(() => {
    events.push('preflight:done');
  });
  await new Promise((resolve) => setTimeout(resolve, 10));
  assert.ok(fixture.inspect().events.includes('getAccounts:start'));
  const blockedWrite = data.setBudgetAmount({ month: '2026-07', categoryId: 'food', amount: 1 }).then(() => {
    events.push('write:done');
  });
  await new Promise((resolve) => setTimeout(resolve, 10));
  assert.deepEqual(events, []);
  releasePreflight();
  await Promise.all([preflight, blockedWrite]);
  const order = [...fixture.inspect().events, ...events];
  assert.ok(order.includes('getAccounts:start'));
  assert.ok(order.indexOf('getAccounts:end') < order.indexOf('write:start'));
  assert.ok(order.includes('getCategoryGroups:start'));
});

test('concurrent preflight read blocks write until Actual enumeration completes', async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'df-preflight-write-block-'));
  const data = freshDataModule(dir);
  const fixture = require(FIXTURE);
  let release;
  fixture.configure({
    gates: {
      getCategoryGroups: () => new Promise((resolve) => { release = resolve; }),
    },
  });
  await data.initApi({ skipRecover: true });
  const preflight = data.preflightSplitwiseMirrorShareSync();
  await new Promise((resolve) => setTimeout(resolve, 10));
  assert.ok(fixture.inspect().events.includes('getAccounts:end'));
  let writeStarted = false;
  const write = data.createTransaction({
    accountId: 'sw-account',
    amount: -1,
    payee: 'test',
    date: '2026-07-10',
    categoryId: 'sw-category',
  }, { sync: false }).then(() => { writeStarted = true; });
  await new Promise((resolve) => setTimeout(resolve, 15));
  assert.equal(writeStarted, false);
  release();
  await Promise.all([preflight, write]);
  assert.equal(writeStarted, true);
});

test('syncNow invalidates generation before post-sync reads can cache-hit stale data', async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'df-sync-invalidate-'));
  const data = freshDataModule(dir);
  const coordinator = getActualCoordinator();
  const cache = new NodeCache();
  coordinator.bindCache(cache);
  await data.initApi({ skipRecover: true });
  await coordinator.cachedRead('accounts', async () => ({ value: 1 }), 30);
  assert.equal(coordinator.readCacheEntry('accounts').value, 1);
  await data.syncNow();
  assert.equal(coordinator.readCacheEntry('accounts'), undefined);
  let loadCount = 0;
  const fresh = await coordinator.cachedRead('accounts', async () => {
    loadCount += 1;
    return { value: 2 };
  }, 30);
  assert.equal(loadCount, 1);
  assert.equal(fresh.value, 2);
});

test('cache fill interleaving discards stale publish when generation bumps during I/O', async () => {
  const coordinator = resetActualCoordinator('sync-interleave');
  const cache = new NodeCache();
  coordinator.bindCache(cache);
  let release;
  const gate = new Promise((resolve) => { release = resolve; });
  const slow = coordinator.cachedRead('accounts', async () => {
    await gate;
    return { value: 'late' };
  }, 30);
  await new Promise((resolve) => setTimeout(resolve, 5));
  coordinator.invalidateGeneration();
  release();
  const result = await slow;
  assert.equal(result.value, 'late');
  assert.equal(coordinator.readCacheEntry('accounts').value, 'late');
  assert.equal(coordinator.getHealth().stats.staleFillsDiscarded, 1);
  assert.equal(coordinator.getHealth().stats.staleFillRetries, 1);
});

test('generation gate rejects stale publish even when cache flush omits generation bump', async () => {
  const coordinator = resetActualCoordinator('flush-only-regression');
  const cache = new NodeCache();
  coordinator.bindCache(cache);
  let release;
  const gate = new Promise((resolve) => { release = resolve; });
  const slow = coordinator.runRead(async ({ generation }) => {
    await gate;
    cache.flushAll();
    coordinator.publishCacheEntry('accounts', { stale: true }, 30, generation);
    return { stale: true };
  }, { label: 'slow' });
  await new Promise((resolve) => setTimeout(resolve, 5));
  coordinator.invalidateGeneration();
  release();
  await slow;
  assert.equal(coordinator.readCacheEntry('accounts'), undefined);
  assert.equal(coordinator.getHealth().stats.staleFillsDiscarded, 1);
});

test('direct data.api export is blocked without ALLOW_RAW_ACTUAL_API', async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'df-api-gate-'));
  const data = freshDataModule(dir, { allowRawApi: false });
  assert.throws(() => data.api, /Direct data\.api access bypasses/);
  process.env.ALLOW_RAW_ACTUAL_API = '1';
});

test('runActualRead serializes concurrent Actual enumeration', async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'df-run-actual-read-'));
  const data = freshDataModule(dir);
  const fixture = require(FIXTURE);
  let release;
  fixture.configure({
    gates: {
      getAccounts: () => new Promise((resolve) => { release = resolve; }),
    },
  });
  await data.initApi({ skipRecover: true });
  const first = data.runActualRead(async (actualApi) => actualApi.getAccounts());
  await new Promise((resolve) => setTimeout(resolve, 10));
  let secondStarted = false;
  const second = data.runActualRead(async (actualApi) => {
    secondStarted = true;
    return actualApi.getCategoryGroups();
  });
  await new Promise((resolve) => setTimeout(resolve, 10));
  assert.equal(secondStarted, false);
  release();
  await Promise.all([first, second]);
  assert.equal(secondStarted, true);
});
