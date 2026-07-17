'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const os = require('os');
const path = require('path');
const {
  SplitwiseMirrorResolutionError,
  loadSplitwiseMirrorResolutions,
  normalizeResolutionRecord,
} = require('../lib/splitwise-mirror');

const RESOLUTION_ENV_KEYS = [
  'ACTUAL_DATA_DIR',
  'ACTUAL_API_PATH',
  'SPLITWISE_MIRROR_RESOLUTIONS_PATH',
  'PERSONAL_CONFIG_PATH',
  'OWES_TRUTH_PATH',
  'BULK_OPERATION_SAGAS_PATH',
  'TRANSACTION_DELETION_SAGAS_PATH',
];
const savedResolutionEnv = Object.fromEntries(
  RESOLUTION_ENV_KEYS.map((key) => [key, process.env[key]]),
);

function restoreResolutionEnv() {
  for (const key of RESOLUTION_ENV_KEYS) {
    const value = savedResolutionEnv[key];
    if (value === undefined) delete process.env[key];
    else process.env[key] = value;
  }
}

test.after(() => {
  restoreResolutionEnv();
});

test('missing resolutions file defaults to empty schema v1', () => {
  const store = loadSplitwiseMirrorResolutions(null);
  assert.equal(store.schemaVersion, 1);
  assert.deepEqual(store.resolutions, []);
});

test('preserves unknown top-level fields on a valid sidecar', () => {
  const store = loadSplitwiseMirrorResolutions({
    schemaVersion: 1,
    operatorNote: 'keep-me',
    resolutions: [],
  });
  assert.equal(store.operatorNote, 'keep-me');
});

test('rejects wrong schema version before any mirror work', () => {
  assert.throws(
    () => loadSplitwiseMirrorResolutions({ schemaVersion: 2, resolutions: [] }),
    (error) => error instanceof SplitwiseMirrorResolutionError,
  );
});

test('rejects malformed resolution records instead of discarding them', () => {
  assert.throws(
    () => loadSplitwiseMirrorResolutions({
      schemaVersion: 1,
      resolutions: [{ sourceId: '123', keepTxnId: 'a' }],
    }),
    /malformed/i,
  );
});

test('rejects duplicate sourceId records', () => {
  const record = {
    sourceId: '123',
    keepTxnId: 'a',
    dropTxnIds: ['b'],
    observed: [
      { id: 'a', fingerprint: 'fa' },
      { id: 'b', fingerprint: 'fb' },
    ],
    reviewedAt: new Date().toISOString(),
  };
  assert.throws(
    () => loadSplitwiseMirrorResolutions({
      schemaVersion: 1,
      resolutions: [record, { ...record, keepTxnId: 'b', dropTxnIds: ['a'] }],
    }),
    /duplicate sourceId/i,
  );
});

test('normalizeResolutionRecord rejects keep/drop overlap and incomplete observed sets', () => {
  assert.equal(normalizeResolutionRecord({
    sourceId: '123',
    keepTxnId: 'a',
    dropTxnIds: ['a'],
    observed: [{ id: 'a', fingerprint: 'fa' }, { id: 'b', fingerprint: 'fb' }],
    reviewedAt: new Date().toISOString(),
  }), null);
  assert.equal(normalizeResolutionRecord({
    sourceId: '123',
    keepTxnId: 'a',
    dropTxnIds: ['b'],
    observed: [{ id: 'a', fingerprint: 'fa' }],
    reviewedAt: new Date().toISOString(),
  }), null);
});

test('file-backed pre-admission rejects malformed sidecar before saga write', async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'darkfinances-mirror-res-'));
  const actualDataDir = path.join(dir, 'actual-cache');
  fs.mkdirSync(actualDataDir, { recursive: true });
  process.env.ACTUAL_DATA_DIR = actualDataDir;
  process.env.ACTUAL_API_PATH = path.join(__dirname, 'fixtures', 'deletion-actual.js');
  process.env.SPLITWISE_MIRROR_RESOLUTIONS_PATH = path.join(dir, 'splitwise-mirror-resolutions.json');
  process.env.PERSONAL_CONFIG_PATH = path.join(dir, 'personal.json');
  process.env.OWES_TRUTH_PATH = path.join(dir, 'owes-truth.json');
  process.env.BULK_OPERATION_SAGAS_PATH = path.join(dir, 'bulk-operation-sagas.json');
  process.env.TRANSACTION_DELETION_SAGAS_PATH = path.join(dir, 'transaction-deletion-sagas.json');
  fs.writeFileSync(process.env.TRANSACTION_DELETION_SAGAS_PATH, '{"schemaVersion":1,"sagas":{}}\n');
  fs.writeFileSync(process.env.BULK_OPERATION_SAGAS_PATH, '{"schemaVersion":1,"sagas":{}}\n');
  fs.writeFileSync(process.env.SPLITWISE_MIRROR_RESOLUTIONS_PATH, JSON.stringify({
    schemaVersion: 1,
    resolutions: [{ sourceId: 'bad' }],
  }));
  fs.writeFileSync(process.env.OWES_TRUTH_PATH, JSON.stringify({
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
  }));
  delete require.cache[require.resolve('../dataModule')];
  const data = require('../dataModule');
  await data.initApi();
  await assert.rejects(
    data.syncSplitwiseShareExpenses({ sync: false }),
    (error) => error instanceof SplitwiseMirrorResolutionError,
  );
  assert.deepEqual(JSON.parse(fs.readFileSync(process.env.BULK_OPERATION_SAGAS_PATH, 'utf8')), {
    schemaVersion: 1,
    sagas: {},
  });
  fs.rmSync(dir, { recursive: true, force: true });
});
