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

function readJournal(path) {
  return JSON.parse(fs.readFileSync(path, 'utf8'));
}

async function spawnReviewServer(t, { preloadBody } = {}) {
  let journal;
  let marker;
  let reviewState;
  const started = await startEphemeralDashboardServer(t, {
    tempPrefix: 'darkfinances-review-operation-',
    preloadBody,
    prepareDir: (dir) => {
      journal = path.join(dir, 'operation-journal.json');
      marker = path.join(dir, 'effects.log');
      reviewState = path.join(dir, 'review-state.json');
      fs.writeFileSync(reviewState, JSON.stringify({
        schemaVersion: 2,
        contentVersion: 1,
        dispositions: {},
        legacyDispositions: {},
      }, null, 2));
    },
    extraEnvForDir: (dir) => ({
      REVIEW_STATE_PATH: path.join(dir, 'review-state.json'),
    }),
  });
  return { ...started, journal, marker, reviewState };
}

function mockPreload({ extraMethods = '', extraRequires = '' } = {}) {
  return `
    const fs = require('fs');
    const path = require('path');
    const dataPath = require.resolve(path.join(process.env.TEST_DASHBOARD_ROOT, 'dataModule.js'));
    ${extraRequires}
    const mark = (value) => fs.appendFileSync(process.env.TEST_EFFECT_MARKER, value + '\\n');
    const mock = new Proxy({
      initApi: async () => ({ ok: true }),
      shutdownApi: async () => ({ ok: true }),
      getHealth: () => ({ ready: true }),
      prepareReviewDispositionAdmission: async (payload) => {
        mark('prepare:' + payload.id);
        return {
          preWriteRevision: 'rev-1',
          nextState: {
            schemaVersion: 2,
            contentVersion: 1,
            dispositions: {
              'uncategorized:imported:bank-abc': {
                disposition: payload.disposition,
                at: new Date().toISOString(),
                contentHash: payload.contentHash || null,
                kind: 'uncategorized',
                stableKey: 'uncategorized:imported:bank-abc',
              },
            },
            legacyDispositions: {},
          },
          result: { ok: true, id: payload.id, disposition: payload.disposition, contentHash: payload.contentHash || null },
        };
      },
      commitReviewDisposition: (admission) => {
        mark('commit:' + admission.result.id);
        fs.writeFileSync(process.env.REVIEW_STATE_PATH, JSON.stringify(admission.nextState, null, 2) + '\\n');
        return admission.result;
      },
      ${extraMethods}
    }, {
      get(target, property) {
        if (property in target) return target[property];
        return async () => ({ tasks: [], _allTasks: [], _maintenance: null });
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
  `;
}

test('review disposition prepares before commit and completes journal on success', async (t) => {
  const { base, journal, marker } = await spawnReviewServer(t, {
    preloadBody: mockPreload(),
  });

  const key = 'review-ack-key';
  const hash = 'a'.repeat(64);
  const result = await request(base, '/api/v1/review/dispositions', {
    key,
    body: {
      id: `${hash}@${hash}`,
      disposition: 'acknowledge',
      contentHash: hash,
    },
  });
  assert.equal(result.response.status, 200);
  assert.equal(result.body.data.ok, true);

  const effects = fs.readFileSync(marker, 'utf8').trim().split('\n');
  assert.deepEqual(effects, [
    `prepare:${hash}@${hash}`,
    `commit:${hash}@${hash}`,
  ]);
  assert.equal(readJournal(journal).operations[key].phase, 'completed');

  const replay = await request(base, '/api/v1/review/dispositions', {
    key,
    body: {
      id: `${hash}@${hash}`,
      disposition: 'acknowledge',
      contentHash: hash,
    },
  });
  assert.equal(replay.response.status, 200);
  assert.equal(replay.body.operation.replayed, true);
  assert.equal(fs.readFileSync(marker, 'utf8').trim().split('\n').length, 2);
});

test('semantic admission failures are terminal journal failures, not outcome unknown', async (t) => {
  const { base, child, logs, journal, marker } = await spawnReviewServer(t, {
    preloadBody: mockPreload({
      extraRequires: `
        const dispositionErrors = require(path.join(process.env.TEST_DASHBOARD_ROOT, 'lib/review-disposition.js'));
      `,
      extraMethods: `
      prepareReviewDispositionAdmission: async (payload) => {
        mark('prepare:' + payload.id);
        if (payload.id === 'legacy:missing-hash') {
          throw new dispositionErrors.ReviewDispositionLegacyRefetchError();
        }
        if (payload.id === 'missing-task') {
          throw new dispositionErrors.ReviewDispositionUnknownError();
        }
        if (payload.contentHash === '${'b'.repeat(64)}') {
          throw new dispositionErrors.ReviewDispositionStaleError();
        }
        if (payload.id === 'ambiguous:legacy') {
          throw new dispositionErrors.ReviewDispositionAmbiguousError();
        }
        return {
          preWriteRevision: 'rev-1',
          nextState: { schemaVersion: 2, contentVersion: 1, dispositions: {}, legacyDispositions: {} },
          result: { ok: true, id: payload.id, disposition: payload.disposition },
        };
      },
      commitReviewDisposition: () => {
        mark('commit-should-not-run');
        return { ok: true };
      },
      `,
    }),
  });

  const cases = [
    ['review-legacy-refetch', { id: 'legacy:missing-hash', disposition: 'acknowledge' }, 409, 'REVIEW_DISPOSITION_LEGACY_REFETCH'],
    ['review-unknown', { id: 'missing-task', disposition: 'acknowledge', contentHash: 'a'.repeat(64) }, 404, 'REVIEW_DISPOSITION_UNKNOWN'],
    ['review-stale', { id: 'task-1', disposition: 'acknowledge', contentHash: 'b'.repeat(64) }, 409, 'REVIEW_DISPOSITION_STALE'],
    ['review-ambiguous', { id: 'ambiguous:legacy', disposition: 'acknowledge', contentHash: 'a'.repeat(64) }, 409, 'REVIEW_DISPOSITION_AMBIGUOUS'],
  ];

  for (const [key, body, status, code] of cases) {
    const result = await request(base, '/api/v1/review/dispositions', { key, body });
    assert.equal(result.response.status, status, key);
    assert.equal(result.body.code, code, key);
    assert.equal(readJournal(journal).operations[key].phase, 'failed', key);
  }
  assert.equal(fs.readFileSync(marker, 'utf8').includes('commit-should-not-run'), false);
});

test('post-apply commit failure stays outcome unknown while pre-apply failures stay terminal', async (t) => {
  const { base, child, logs, journal, marker } = await spawnReviewServer(t, {
    preloadBody: mockPreload({
      extraMethods: `
      commitReviewDisposition: () => {
        mark('commit-throw');
        throw new Error('review state write lost after crossing effect boundary');
      },
      `,
    }),
  });

  const key = 'review-commit-throw';
  const hash = 'c'.repeat(64);
  const result = await request(base, '/api/v1/review/dispositions', {
    key,
    body: { id: `${hash}@${hash}`, disposition: 'snooze', until: '2099-01-01T00:00:00.000Z', contentHash: hash },
  });
  assert.equal(result.response.status, 409);
  assert.equal(result.body.code, 'OUTCOME_UNKNOWN');
  assert.equal(readJournal(journal).operations[key].phase, 'started');
  assert.match(fs.readFileSync(marker, 'utf8'), /commit-throw/);
});
