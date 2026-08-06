'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const path = require('path');
const { startEphemeralDashboardServer } = require('./helpers/ephemeral-dashboard-server');

const server = fs.readFileSync(path.resolve(__dirname, '..', 'server.js'), 'utf8');
const types = fs.readFileSync(
  path.resolve(__dirname, '..', '..', 'finance-app', 'src', 'api', 'generated', 'types.ts'),
  'utf8',
);

const REVIEW_CACHE_PRELOAD = `
  const fs = require('fs');
  const path = require('path');
  const root = process.env.TEST_DASHBOARD_ROOT;
  const dataPath = require.resolve(path.join(root, 'dataModule.js'));
  const real = require(dataPath);
  let maintenancePersisted = false;
  const record = (entry) => fs.appendFileSync(process.env.TEST_MARKER, JSON.stringify(entry) + '\\n');
  require.cache[dataPath] = {
    id: dataPath,
    filename: dataPath,
    loaded: true,
    exports: new Proxy(real, {
      get(target, property) {
        if (property === 'getReview') {
          return async ({ month } = {}) => {
            record({ kind: 'get-review', month: month || null });
            const needsMaintenance = month === '2026-02' && !maintenancePersisted;
            return {
              month: month || 'current',
              tasks: [{ id: 'visible-task', title: 'Visible' }],
              summary: { total: 1 },
              _allTasks: [{ id: 'hidden-task', title: 'Private cache detail' }],
              _maintenance: needsMaintenance
                ? { expectedRevision: 7, expiredSnoozeKeys: ['private-snooze-key'] }
                : null,
            };
          };
        }
        if (property === 'persistReviewStateMaintenance') {
          return async (payload) => {
            maintenancePersisted = true;
            record({ kind: 'maintenance', payload });
            return { ok: true };
          };
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
`;

async function fetchReview(base, month) {
  const response = await fetch(`${base}/api/v1/review?month=${month}`, {
    headers: { 'X-Finance-Token': 'test-api-token' },
  });
  return { response, body: await response.json() };
}

test('review disposition admission runs before applyLocal inside projection lane', () => {
  assert.match(server, /prepareReviewDispositionAdmission/);
  assert.match(server, /commitReviewDisposition/);
  assert.match(server, /runActualProjectionMutation\(async \(\) => \{[\s\S]*prepareReviewDispositionAdmission[\s\S]*commitReviewDisposition/);
});

test('review GET persists snooze cleanup on write lane, not inside cached read', () => {
  assert.match(server, /loadReviewInbox/);
  assert.match(server, /persistReviewStateMaintenance/);
  assert.match(server, /actualCoordinator\.runWrite/);
  assert.match(server, /publicReviewInbox/);
  assert.match(server, /onCacheHit: fn === resolvers\.review/);
  assert.doesNotMatch(server, /delete state\.dispositions\[task\.id\]/);
});

test('cold and warm review responses match without cache-private fields and maintenance persists once', async (t) => {
  const { base, markerPath } = await startEphemeralDashboardServer(t, {
    tempPrefix: 'darkfinances-review-cache-shape-',
    preloadBody: REVIEW_CACHE_PRELOAD,
  });

  const cold = await fetchReview(base, '2026-01');
  const warm = await fetchReview(base, '2026-01');
  assert.equal(cold.response.status, 200);
  assert.equal(warm.response.status, 200);
  assert.deepEqual(warm.body, cold.body);
  for (const result of [cold, warm]) {
    assert.equal(Object.hasOwn(result.body.data, '_allTasks'), false);
    assert.equal(Object.hasOwn(result.body.data, '_maintenance'), false);
    assert.equal(JSON.stringify(result.body).includes('hidden-task'), false);
    assert.equal(JSON.stringify(result.body).includes('private-snooze-key'), false);
  }

  const maintenanceCold = await fetchReview(base, '2026-02');
  const maintenanceAfterWrite = await fetchReview(base, '2026-02');
  const maintenanceWarm = await fetchReview(base, '2026-02');
  assert.equal(maintenanceCold.response.status, 200);
  assert.deepEqual(maintenanceAfterWrite.body, maintenanceCold.body);
  assert.deepEqual(maintenanceWarm.body, maintenanceCold.body);
  for (const result of [maintenanceCold, maintenanceAfterWrite, maintenanceWarm]) {
    assert.equal(Object.hasOwn(result.body.data, '_allTasks'), false);
    assert.equal(Object.hasOwn(result.body.data, '_maintenance'), false);
  }

  const events = fs.readFileSync(markerPath, 'utf8')
    .trim()
    .split('\n')
    .filter(Boolean)
    .map((line) => JSON.parse(line));
  assert.equal(events.filter((entry) => entry.kind === 'get-review' && entry.month === '2026-01').length, 1);
  assert.equal(events.filter((entry) => entry.kind === 'get-review' && entry.month === '2026-02').length, 2);
  const maintenanceEvents = events.filter((entry) => entry.kind === 'maintenance');
  assert.equal(maintenanceEvents.length, 1);
  assert.deepEqual(maintenanceEvents[0].payload, {
    expectedRevision: 7,
    expiredSnoozeKeys: ['private-snooze-key'],
  });
});

test('review disposition validation accepts optional contentHash', () => {
  const validation = fs.readFileSync(path.resolve(__dirname, '..', 'lib', 'validation.js'), 'utf8');
  assert.match(validation, /contentHash: z\.string\(\)\.regex/);
});

test('generated ReviewTask includes fingerprint fields', () => {
  assert.match(types, /contentHash: string;/);
  assert.match(types, /stableKey: string;/);
  assert.match(types, /contentVersion: number;/);
});
