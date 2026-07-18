'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const os = require('os');
const path = require('path');
const net = require('net');
const { spawn } = require('child_process');

async function unusedPort() {
  return new Promise((resolve, reject) => {
    const server = net.createServer();
    server.once('error', reject);
    server.listen(0, '127.0.0.1', () => {
      const { port } = server.address();
      server.close((error) => error ? reject(error) : resolve(port));
    });
  });
}

async function waitForServer(base, child, logs) {
  for (let attempt = 0; attempt < 100; attempt += 1) {
    if (child.exitCode != null) throw new Error(`server exited early: ${logs.value}`);
    try {
      const response = await fetch(`${base}/api/v1/ping`, {
        headers: { 'X-Finance-Token': 'test-api-token' },
      });
      if (response.status === 200) return;
    } catch (_) {}
    await new Promise((resolve) => setTimeout(resolve, 25));
  }
  throw new Error(`server did not start: ${logs.value}`);
}

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

function spawnReviewServer(t, { preloadBody, reviewStatePath, journalPath, markerPath }) {
  const portPromise = unusedPort();
  return portPromise.then((port) => {
    const base = `http://127.0.0.1:${port}`;
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'darkfinances-review-operation-'));
    const dashboardRoot = path.resolve(__dirname, '..');
    const journal = journalPath || path.join(dir, 'operation-journal.json');
    const marker = markerPath || path.join(dir, 'effects.log');
    const reviewState = reviewStatePath || path.join(dir, 'review-state.json');
    const preload = path.join(dir, 'mock-data-module.js');
    fs.writeFileSync(preload, preloadBody);
    fs.writeFileSync(reviewState, JSON.stringify({
      schemaVersion: 2,
      contentVersion: 1,
      dispositions: {},
      legacyDispositions: {},
    }, null, 2));

    const logs = { value: '' };
    const child = spawn(process.execPath, ['server.js'], {
      cwd: dashboardRoot,
      env: {
        ...process.env,
        NODE_ENV: 'test',
        DEMO_ONLY: '1',
        NODE_OPTIONS: `${process.env.NODE_OPTIONS || ''} --require=${preload}`.trim(),
        PORT: String(port),
        PUBLIC_ORIGIN: `http://localhost:${port}`,
        WEBAUTHN_ORIGIN: `http://localhost:${port}`,
        WEBAUTHN_RP_ID: 'localhost',
        FINANCE_API_TOKEN: 'test-api-token',
        SESSION_SECRET: 'test-session-secret-with-sufficient-length',
        SESSION_DIR: path.join(dir, 'sessions'),
        OPERATION_JOURNAL_PATH: journal,
        REVIEW_STATE_PATH: reviewState,
        PASSKEY_CREDENTIALS_FILE: path.join(dir, 'credentials.json'),
        TEST_DASHBOARD_ROOT: dashboardRoot,
        TEST_EFFECT_MARKER: marker,
      },
      stdio: ['ignore', 'pipe', 'pipe'],
    });
    child.stdout.on('data', (chunk) => { logs.value += chunk; });
    child.stderr.on('data', (chunk) => { logs.value += chunk; });
    t.after(() => {
      child.kill('SIGTERM');
      fs.rmSync(dir, { recursive: true, force: true });
    });
    return { base, child, logs, journal, marker, reviewState, port, dir };
  });
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
  const { base, child, logs, journal, marker } = await spawnReviewServer(t, {
    preloadBody: mockPreload(),
  });
  await waitForServer(base, child, logs);

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
  await waitForServer(base, child, logs);

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
  await waitForServer(base, child, logs);

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
