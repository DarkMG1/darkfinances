'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const path = require('path');
const {
  collectDeployedFiles,
  sha256Canonical,
} = require('../../scripts/release-manifest');
const {
  createReconnectFreshnessProbeService,
  deriveSourceObservedRevision,
} = require('../lib/reconnect-freshness-probe');
const { DASHBOARD_RUNTIME_FILES } = require('../lib/release-files');
const { ActualCoordinator } = require('../lib/actual-coordinator');
const NodeCache = require('node-cache');
const { startEphemeralDashboardServer } = require('./helpers/ephemeral-dashboard-server');

async function apiRequest(base, pathname, { method = 'GET', key, body, demo = false, token = 'test-api-token', headers = {} } = {}) {
  const response = await fetch(`${base}${pathname}`, {
    method,
    headers: {
      ...(demo ? { 'X-Demo-Mode': '1' } : {}),
      ...(token != null && token !== '' ? { 'X-Finance-Token': token } : {}),
      ...headers,
      ...(key ? { 'Idempotency-Key': key } : {}),
      ...(body === undefined ? {} : { 'Content-Type': 'application/json' }),
    },
    ...(body === undefined ? {} : { body: JSON.stringify(body) }),
  });
  const text = await response.text();
  let parsed;
  try {
    parsed = JSON.parse(text);
  } catch {
    parsed = text;
  }
  return { response, body: parsed };
}

function manifestFor(runtimeDir, contractFingerprint = 'a1b2c3d4e5f67890') {
  const content = {
    mode: 'dashboard',
    repository: {
      commit: '1234567890abcdef1234567890abcdef12345678',
      dirty: false,
      source: {
        algorithm: 'sha256',
        digest: 'a'.repeat(64),
        state: 'clean',
        trackedDirty: false,
        untrackedSource: false,
      },
    },
    lockfile: { path: 'package-lock.json', sha256: 'b'.repeat(64) },
    actual: { serverImage: '26.7.0', dashboardApi: '26.7.0', toolsApi: '26.7.0' },
    contract: { fingerprint: contractFingerprint },
    app: {
      variant: 'full',
      releaseProfile: 'production',
      version: '2.0.0',
      runtimeVersion: '2.0.0',
      updateChannel: 'production',
      iosBuildNumber: '5',
    },
    deployedFiles: collectDeployedFiles(runtimeDir, [...DASHBOARD_RUNTIME_FILES]),
  };
  return {
    kind: 'darkfinances-release',
    schemaVersion: 2,
    builtAt: '2026-02-02T00:00:00.000Z',
    content,
    contentDigest: {
      algorithm: 'sha256',
      canonicalization: 'darkfinances-canonical-json-v1',
      value: sha256Canonical(content),
    },
    display: { repository: { commitShort: '1234567', branch: null } },
  };
}

function accountsMockBody({ markLine = '', useSourceFile = false } = {}) {
  const sourceFileLogic = useSourceFile ? `
    getAccounts: async () => {
      const variant = fs.readFileSync(process.env.TEST_ACCOUNTS_SOURCE_FILE, 'utf8').trim();
      const entry = variant === 'B'
        ? { id: 'a1', name: 'Source-B', balance: 200 }
        : { id: 'a1', name: 'Source-A', balance: 100 };
      if (typeof mark === 'function') mark('probe:' + entry.name);
      return [{ ...entry }];
    },
  ` : `
      getAccounts: async () => {
        if (typeof mark === 'function') mark('probe:' + accountsSource[0].name);
        return accountsSource.map((entry) => ({ ...entry }));
      },
  `;
  return `
    ${markLine}
    const fs = require('fs');
    const path = require('path');
    const dataPath = require.resolve(path.join(process.env.TEST_DASHBOARD_ROOT, 'dataModule.js'));
    let accountsSource = [{ id: 'a1', name: 'Source-A', balance: 100 }];
    const mock = {
      initApi: async () => ({ ok: true }),
      shutdownApi: async () => { if (typeof mark === 'function') mark('shutdown'); return { ok: true }; },
      getHealth: () => ({ ready: true }),
      syncNow: async () => ({ ok: true }),
      ${sourceFileLogic}
      setRecurringOverride: async () => {
        if (typeof mark === 'function') mark('mutation:start');
        await new Promise((resolve) => setTimeout(resolve, 40));
        if (typeof mark === 'function') mark('mutation:end');
        return { ok: true };
      },
      __setAccountsSource(next) { accountsSource = next; },
    };
    require.cache[dataPath] = { id: dataPath, filename: dataPath, loaded: true, exports: mock, children: [], paths: [] };
  `;
}

async function startReconnectServer(t, preloadBody, {
  extraEnv = {},
  extraEnvForDir: extraEnvForDirFn = null,
  prepareDir = null,
  tempPrefix = 'df-reconnect-',
} = {}) {
  const dashboardRoot = path.resolve(__dirname, '..');
  return startEphemeralDashboardServer(t, {
    tempPrefix,
    preloadBody,
    prepareDir,
    extraEnvForDir: (dir) => {
      const manifestPath = path.join(dir, 'release-manifest.json');
      fs.writeFileSync(manifestPath, JSON.stringify(manifestFor(dashboardRoot)));
      return {
        RELEASE_MANIFEST_PATH: manifestPath,
        ...extraEnv,
        ...(extraEnvForDirFn ? extraEnvForDirFn(dir) : {}),
      };
    },
  });
}

function barrierMockBody({ markLine = '' } = {}) {
  return `
    ${markLine}
    const fs = require('fs');
    const path = require('path');
    const dataPath = require.resolve(path.join(process.env.TEST_DASHBOARD_ROOT, 'dataModule.js'));
    let accountsSource = [{ id: 'a1', name: 'Source-A', balance: 100 }];
    const gatePath = (name) => path.join(path.dirname(process.env.TEST_MARKER), name + '.gate');
    const waitGate = async (name) => {
      while (!fs.existsSync(gatePath(name))) {
        await new Promise((resolve) => setImmediate(resolve));
      }
    };
    const mock = {
      initApi: async () => ({ ok: true }),
      shutdownApi: async () => ({ ok: true }),
      getHealth: () => ({ ready: true }),
      syncNow: async () => ({ ok: true }),
      getAccounts: async () => {
        const fromProbe = (new Error().stack || '').includes('reconnect-freshness-probe');
        if (fromProbe) {
          mark('probe:enter');
          await waitGate('probe');
          mark('probe:read:' + accountsSource[0].name);
        }
        return accountsSource.map((entry) => ({ ...entry }));
      },
      setRecurringOverride: async () => {
        mark('mutation:enter');
        accountsSource = [{ id: 'a1', name: 'Source-Write', balance: 300 }];
        await waitGate('mutation');
        mark('mutation:end');
        return { ok: true };
      },
    };
    require.cache[dataPath] = { id: dataPath, filename: dataPath, loaded: true, exports: mock, children: [], paths: [] };
  `;
}

function releaseGate(dir, name) {
  fs.writeFileSync(path.join(dir, `${name}.gate`), '1');
}

async function waitForMarkerLine(marker, line, timeoutMs = 10_000) {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    if (fs.existsSync(marker)) {
      const content = fs.readFileSync(marker, 'utf8');
      if (content.split('\n').includes(line)) return;
    }
    await new Promise((resolve) => setImmediate(resolve));
  }
  throw new Error(`marker line not seen: ${line}`);
}

test('deriveSourceObservedRevision changes when probe source changes', () => {
  const a = deriveSourceObservedRevision([{ id: 'a1', name: 'Source-A', balance: 100 }]);
  const b = deriveSourceObservedRevision([{ id: 'a1', name: 'Source-B', balance: 200 }]);
  assert.notEqual(a, b);
});

test('probe service advances generation and republishes accounts cache', async () => {
  const cache = new NodeCache();
  const coordinator = new ActualCoordinator('probe-unit');
  coordinator.bindCache(cache);
  let source = [{ id: 'a1', name: 'A', balance: 1 }];
  const service = createReconnectFreshnessProbeService({
    coordinator,
    readAccountsProbe: async () => source.map((entry) => ({ ...entry })),
    financeTimeZone: 'America/Los_Angeles',
    deployIdentity: () => ({ contract: 'deploy-1' }),
    now: () => 1_700_000_000_000,
  });
  await coordinator.cachedRead('accounts', async () => {
    source = [{ id: 'a1', name: 'A', balance: 1 }];
    return source;
  }, 300);
  source = [{ id: 'a1', name: 'B', balance: 2 }];
  const evidence = await service.runProbe();
  assert.equal(evidence.probeKind, 'actual-direct-accounts');
  assert.ok(evidence.cacheGenerationAfter > evidence.cacheGenerationBefore);
  assert.equal(coordinator.readCacheEntry('accounts')[0].name, 'B');
  assert.equal(evidence.deployIdentity, 'deploy-1');
  assert.equal(evidence.coalesced, false);
});

test('concurrent probe requests coalesce to one direct read', async () => {
  const coordinator = new ActualCoordinator('probe-coalesce');
  let reads = 0;
  const service = createReconnectFreshnessProbeService({
    coordinator,
    readAccountsProbe: async () => {
      reads += 1;
      await new Promise((resolve) => setImmediate(resolve));
      return [{ id: 'a1', name: 'X', balance: 1 }];
    },
    financeTimeZone: 'America/Los_Angeles',
    deployIdentity: () => null,
  });
  const [first, second] = await Promise.all([service.runProbe('token:api'), service.runProbe('token:api')]);
  assert.equal(reads, 1);
  assert.equal(first.coalesced, false);
  assert.equal(second.coalesced, true);
});

test('probe coalescing is scoped per principal and never crosses auth', async () => {
  const coordinator = new ActualCoordinator('probe-principal');
  let reads = 0;
  const service = createReconnectFreshnessProbeService({
    coordinator,
    readAccountsProbe: async () => {
      reads += 1;
      await new Promise((resolve) => setImmediate(resolve));
      return [{ id: 'a1', name: `Read-${reads}`, balance: reads }];
    },
    financeTimeZone: 'America/Los_Angeles',
    deployIdentity: () => null,
  });
  const [tokenA, tokenB, demoA] = await Promise.all([
    service.runProbe('token:api'),
    service.runProbe('token:api'),
    service.runProbe('demo'),
  ]);
  assert.equal(reads, 2);
  assert.equal(tokenB.coalesced, true);
  assert.equal(demoA.coalesced, false);
  assert.notEqual(tokenA.sourceObservedRevision, demoA.sourceObservedRevision);
});

test('warm cached accounts=A, source B without invalidation, reconnect GET then accounts returns B', async (t) => {
  const markLine = `
    const mark = (value) => fs.appendFileSync(process.env.TEST_MARKER, value + '\\n');
  `;
  const { base, dir, markerPath: marker } = await startReconnectServer(t, accountsMockBody({ markLine, useSourceFile: true }), {
    tempPrefix: 'df-reconnect-ab-',
    prepareDir: (serverDir) => fs.writeFileSync(path.join(serverDir, 'accounts-source.txt'), 'A'),
    extraEnvForDir: (serverDir) => ({ TEST_ACCOUNTS_SOURCE_FILE: path.join(serverDir, 'accounts-source.txt') }),
  });
  const sourceFile = path.join(dir, 'accounts-source.txt');

  const warm = await apiRequest(base, '/api/v1/accounts');
  assert.equal(warm.response.status, 200);
  assert.equal(warm.body.data[0].name, 'Source-A');

  fs.writeFileSync(sourceFile, 'B');

  const stale = await apiRequest(base, '/api/v1/accounts');
  assert.equal(stale.body.data[0].name, 'Source-A');

  const probe = await apiRequest(base, '/api/v1/reconnect-freshness');
  assert.equal(probe.response.status, 200);
  assert.equal(probe.body.data.probeKind, 'actual-direct-accounts');
  assert.ok(probe.body.data.cacheGenerationAfter > probe.body.data.cacheGenerationBefore);
  assert.equal(probe.body.data.deployIdentity, 'a1b2c3d4e5f67890');
  assert.match(fs.readFileSync(marker, 'utf8'), /probe:Source-B/);

  const fresh = await apiRequest(base, '/api/v1/accounts');
  assert.equal(fresh.body.data[0].name, 'Source-B');
});

test('ping no longer claims source freshness metadata', async (t) => {
  const { base, markerPath: marker } = await startReconnectServer(t, accountsMockBody(), {
    tempPrefix: 'df-reconnect-ping-clean-',
  });

  const { body, response } = await apiRequest(base, '/api/v1/ping');
  assert.equal(response.status, 200);
  assert.equal(body.data.sourceFreshness, undefined);
  assert.equal(typeof body.data.actualCoordinator.generation, 'number');
});

test('reconnect probe serializes with queued mutation write without corrupting cache', async (t) => {
  const markLine = `
    const mark = (value) => fs.appendFileSync(process.env.TEST_MARKER, value + '\\n');
  `;
  const { base, markerPath: marker } = await startReconnectServer(t, accountsMockBody({ markLine }), {
    tempPrefix: 'df-reconnect-write-race-',
  });

  const probe = await apiRequest(base, '/api/v1/reconnect-freshness');
  const mutation = await apiRequest(base, '/api/v1/recurring/r1/override', {
    method: 'POST',
    key: 'reconnect-write-race',
    body: { status: 'active', hidden: false },
  });
  const markerText = fs.readFileSync(marker, 'utf8');
  assert.equal(probe.response.status, 200);
  assert.equal(mutation.response.status, 200);
  assert.match(markerText, /probe:/);
  assert.match(markerText, /mutation:end/);
});

test('reconnect probe rejects after coordinator shutdown finalizes', async (t) => {
  const { base, child } = await startReconnectServer(t, accountsMockBody(), {
    tempPrefix: 'df-reconnect-shutdown-',
  });
  child.kill('SIGTERM');
  await new Promise((resolve) => setTimeout(resolve, 300));
  let probeStatus = 0;
  try {
    const probe = await apiRequest(base, '/api/v1/reconnect-freshness');
    probeStatus = probe.response.status;
  } catch {
    probeStatus = 0;
  }
  assert.ok(probeStatus === 0 || probeStatus >= 500);
});

test('control-lane flood keeps reconnect freshness and ping responsive', async (t) => {
  const { base } = await startReconnectServer(t, accountsMockBody(), {
    tempPrefix: 'df-reconnect-control-flood-',
    extraEnv: {
      FINANCE_ADMISSION_READ_GLOBAL_PENDING: '12',
      FINANCE_ADMISSION_READ_GLOBAL_RUNNING: '2',
      FINANCE_ADMISSION_READ_PRINCIPAL_PENDING: '4',
      FINANCE_ADMISSION_READ_PRINCIPAL_RUNNING: '2',
      FINANCE_ADMISSION_CONTROL_RESERVE: '2',
      FINANCE_ADMISSION_CHEAP_RESERVE: '2',
      FINANCE_ADMISSION_MAX_PENDING_DEPTH: '8',
      FINANCE_ADMISSION_MAX_WAIT_MS: '25',
    },
  });

  const blocked = apiRequest(base, '/api/v1/accounts?month=2026-07');
  await new Promise((resolve) => setTimeout(resolve, 10));
  const ping = await apiRequest(base, '/api/v1/ping');
  const probe = await apiRequest(base, '/api/v1/reconnect-freshness');
  assert.equal(ping.response.status, 200);
  assert.equal(probe.response.status, 200);
  await blocked.catch(() => {});
});

test('repeated reconnect probes bump cache generation monotonically', async (t) => {
  const { base } = await startReconnectServer(t, accountsMockBody(), {
    tempPrefix: 'df-reconnect-repeat-',
  });
  const first = await apiRequest(base, '/api/v1/reconnect-freshness');
  const second = await apiRequest(base, '/api/v1/reconnect-freshness');
  assert.ok(second.body.data.cacheGenerationAfter > first.body.data.cacheGenerationAfter);
  assert.equal(first.body.data.coalesced, false);
  assert.equal(second.body.data.coalesced, false);
});

test('Promise.all probe then write serializes with barriers and write wins cache', async (t) => {
  const markLine = `const mark = (value) => fs.appendFileSync(process.env.TEST_MARKER, value + '\\n');`;
  const { base, dir, markerPath: marker } = await startReconnectServer(t, barrierMockBody({ markLine }), {
    tempPrefix: 'df-reconnect-probe-first-',
  });
  await apiRequest(base, '/api/v1/accounts');

  const probePromise = apiRequest(base, '/api/v1/reconnect-freshness');
  await waitForMarkerLine(marker, 'probe:enter');
  const mutationPromise = apiRequest(base, '/api/v1/recurring/r1/override', {
    method: 'POST',
    key: 'probe-first-barrier',
    body: { status: 'active', hidden: false },
  });
  assert.equal(
    fs.existsSync(marker) && fs.readFileSync(marker, 'utf8').includes('mutation:enter'),
    false,
    'mutation must wait behind in-flight probe read',
  );
  releaseGate(dir, 'probe');
  await waitForMarkerLine(marker, 'probe:read:Source-A');
  await waitForMarkerLine(marker, 'mutation:enter');
  releaseGate(dir, 'mutation');
  const [probe, mutation] = await Promise.all([probePromise, mutationPromise]);
  assert.equal(probe.response.status, 200);
  assert.equal(mutation.response.status, 200);

  const markerLines = fs.readFileSync(marker, 'utf8').trim().split('\n');
  assert.ok(markerLines.indexOf('probe:enter') < markerLines.indexOf('mutation:end'));
  assert.ok(markerLines.indexOf('probe:read:Source-A') < markerLines.indexOf('mutation:end'));

  const accounts = await apiRequest(base, '/api/v1/accounts');
  assert.equal(accounts.body.data[0].name, 'Source-Write');
  assert.ok(probe.body.data.cacheGenerationAfter > probe.body.data.cacheGenerationBefore);
});

test('Promise.all write then probe serializes with barriers and write wins cache', async (t) => {
  const markLine = `const mark = (value) => fs.appendFileSync(process.env.TEST_MARKER, value + '\\n');`;
  const { base, dir, markerPath: marker } = await startReconnectServer(t, barrierMockBody({ markLine }), {
    tempPrefix: 'df-reconnect-write-first-',
  });
  await apiRequest(base, '/api/v1/accounts');

  const mutationPromise = apiRequest(base, '/api/v1/recurring/r1/override', {
    method: 'POST',
    key: 'write-first-barrier',
    body: { status: 'active', hidden: false },
  });
  await waitForMarkerLine(marker, 'mutation:enter');
  const probePromise = apiRequest(base, '/api/v1/reconnect-freshness');
  assert.equal(
    fs.existsSync(marker) && fs.readFileSync(marker, 'utf8').includes('probe:enter'),
    false,
    'probe must wait behind in-flight mutation write',
  );
  releaseGate(dir, 'mutation');
  await waitForMarkerLine(marker, 'mutation:end');
  await waitForMarkerLine(marker, 'probe:enter');
  releaseGate(dir, 'probe');
  await waitForMarkerLine(marker, 'probe:read:Source-Write');
  const [mutation, probe] = await Promise.all([mutationPromise, probePromise]);
  assert.equal(mutation.response.status, 200);
  assert.equal(probe.response.status, 200);

  const markerLines = fs.readFileSync(marker, 'utf8').trim().split('\n');
  assert.ok(markerLines.indexOf('mutation:end') < markerLines.indexOf('probe:read:Source-Write'));

  const accounts = await apiRequest(base, '/api/v1/accounts');
  assert.equal(accounts.body.data[0].name, 'Source-Write');
});

test('demo and token principals do not coalesce reconnect probe responses', async (t) => {
  const markLine = `const mark = (value) => fs.appendFileSync(process.env.TEST_MARKER, value + '\\n');`;
  const { base, markerPath: marker } = await startReconnectServer(t, accountsMockBody({ markLine }), {
    tempPrefix: 'df-reconnect-principal-',
  });
  const [tokenProbe, demoProbe] = await Promise.all([
    apiRequest(base, '/api/v1/reconnect-freshness'),
    apiRequest(base, '/api/v1/reconnect-freshness', { demo: true, token: null }),
  ]);
  assert.equal(tokenProbe.response.status, 200);
  assert.equal(demoProbe.response.status, 404);
  assert.equal(demoProbe.body.code, 'RECONNECT_FRESHNESS_DEMO_UNSUPPORTED');
  assert.equal(tokenProbe.body.data.coalesced, false);
  assert.equal(tokenProbe.body.data.probeKind, 'actual-direct-accounts');
  assert.match(fs.readFileSync(marker, 'utf8'), /probe:Source-A/);
});
