'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const net = require('net');
const os = require('os');
const path = require('path');
const { spawn } = require('child_process');
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

async function unusedPort() {
  return new Promise((resolve, reject) => {
    const server = net.createServer();
    server.once('error', reject);
    server.listen(0, '127.0.0.1', () => {
      const { port } = server.address();
      server.close((error) => (error ? reject(error) : resolve(port)));
    });
  });
}

async function waitForServer(base, child, logs) {
  const deadline = Date.now() + 10_000;
  while (Date.now() < deadline) {
    if (child.exitCode != null) throw new Error(`server exited early: ${logs.value}`);
    try {
      const response = await fetch(`${base}/auth/status`);
      if (response.ok) return;
    } catch (_) {}
    await new Promise((resolve) => setTimeout(resolve, 25));
  }
  throw new Error(`server startup timeout: ${logs.value}`);
}

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

function spawnServer(dir, port, preloadBody, extraEnv = {}) {
  const dashboardRoot = path.resolve(__dirname, '..');
  const preload = path.join(dir, 'mock-data-module.js');
  fs.writeFileSync(preload, preloadBody);
  const manifestPath = path.join(dir, 'release-manifest.json');
  fs.writeFileSync(manifestPath, JSON.stringify(manifestFor(dashboardRoot)));
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
      OPERATION_JOURNAL_PATH: path.join(dir, 'operation-journal.json'),
      PASSKEY_CREDENTIALS_FILE: path.join(dir, 'credentials.json'),
      TEST_DASHBOARD_ROOT: dashboardRoot,
      TEST_MARKER: path.join(dir, 'marker.log'),
      RELEASE_MANIFEST_PATH: manifestPath,
      ...extraEnv,
    },
    stdio: ['ignore', 'pipe', 'pipe'],
  });
  child.stdout.on('data', (chunk) => { logs.value += chunk; });
  child.stderr.on('data', (chunk) => { logs.value += chunk; });
  return { child, logs, base: `http://127.0.0.1:${port}`, marker: path.join(dir, 'marker.log') };
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
      await new Promise((resolve) => setTimeout(resolve, 20));
      return [{ id: 'a1', name: 'X', balance: 1 }];
    },
    financeTimeZone: 'America/Los_Angeles',
    deployIdentity: () => null,
  });
  const [first, second] = await Promise.all([service.runProbe(), service.runProbe()]);
  assert.equal(reads, 1);
  assert.equal(first.coalesced, false);
  assert.equal(second.coalesced, true);
});

test('warm cached accounts=A, source B without invalidation, reconnect GET then accounts returns B', async (t) => {
  const port = await unusedPort();
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'df-reconnect-ab-'));
  const markLine = `
    const mark = (value) => fs.appendFileSync(process.env.TEST_MARKER, value + '\\n');
  `;
  const sourceFile = path.join(dir, 'accounts-source.txt');
  fs.writeFileSync(sourceFile, 'A');
  const { child, logs, base, marker } = spawnServer(dir, port, accountsMockBody({ markLine, useSourceFile: true }), {
    TEST_ACCOUNTS_SOURCE_FILE: sourceFile,
  });
  t.after(() => {
    try { child.kill('SIGKILL'); } catch (_) {}
    fs.rmSync(dir, { recursive: true, force: true });
  });
  await waitForServer(base, child, logs);

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
  const port = await unusedPort();
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'df-reconnect-ping-clean-'));
  const { child, logs, base } = spawnServer(dir, port, accountsMockBody());
  t.after(() => {
    child.kill('SIGTERM');
    fs.rmSync(dir, { recursive: true, force: true });
  });
  await waitForServer(base, child, logs);
  const { body, response } = await apiRequest(base, '/api/v1/ping');
  assert.equal(response.status, 200);
  assert.equal(body.data.sourceFreshness, undefined);
  assert.equal(typeof body.data.actualCoordinator.generation, 'number');
});

test('reconnect probe serializes with queued mutation write without corrupting cache', async (t) => {
  const port = await unusedPort();
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'df-reconnect-write-race-'));
  const markLine = `
    const mark = (value) => fs.appendFileSync(process.env.TEST_MARKER, value + '\\n');
  `;
  const { child, logs, base, marker } = spawnServer(dir, port, accountsMockBody({ markLine }));
  t.after(() => {
    try { child.kill('SIGKILL'); } catch (_) {}
    fs.rmSync(dir, { recursive: true, force: true });
  });
  await waitForServer(base, child, logs);

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
  const port = await unusedPort();
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'df-reconnect-shutdown-'));
  const { child, logs, base } = spawnServer(dir, port, accountsMockBody());
  t.after(() => {
    try { child.kill('SIGKILL'); } catch (_) {}
    fs.rmSync(dir, { recursive: true, force: true });
  });
  await waitForServer(base, child, logs);
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
  const port = await unusedPort();
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'df-reconnect-control-flood-'));
  const { child, logs, base } = spawnServer(dir, port, accountsMockBody(), {
    FINANCE_ADMISSION_READ_GLOBAL_PENDING: '12',
    FINANCE_ADMISSION_READ_GLOBAL_RUNNING: '2',
    FINANCE_ADMISSION_READ_PRINCIPAL_PENDING: '4',
    FINANCE_ADMISSION_READ_PRINCIPAL_RUNNING: '2',
    FINANCE_ADMISSION_CONTROL_RESERVE: '2',
    FINANCE_ADMISSION_CHEAP_RESERVE: '2',
    FINANCE_ADMISSION_MAX_PENDING_DEPTH: '8',
    FINANCE_ADMISSION_MAX_WAIT_MS: '25',
  });
  t.after(() => {
    child.kill('SIGTERM');
    fs.rmSync(dir, { recursive: true, force: true });
  });
  await waitForServer(base, child, logs);

  const blocked = apiRequest(base, '/api/v1/accounts?month=2026-07');
  await new Promise((resolve) => setTimeout(resolve, 10));
  const ping = await apiRequest(base, '/api/v1/ping');
  const probe = await apiRequest(base, '/api/v1/reconnect-freshness');
  assert.equal(ping.response.status, 200);
  assert.equal(probe.response.status, 200);
  await blocked.catch(() => {});
});

test('repeated reconnect probes bump cache generation monotonically', async (t) => {
  const port = await unusedPort();
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'df-reconnect-repeat-'));
  const { child, logs, base } = spawnServer(dir, port, accountsMockBody());
  t.after(() => {
    child.kill('SIGTERM');
    fs.rmSync(dir, { recursive: true, force: true });
  });
  await waitForServer(base, child, logs);
  const first = await apiRequest(base, '/api/v1/reconnect-freshness');
  const second = await apiRequest(base, '/api/v1/reconnect-freshness');
  assert.ok(second.body.data.cacheGenerationAfter > first.body.data.cacheGenerationAfter);
  assert.equal(first.body.data.coalesced, false);
  assert.equal(second.body.data.coalesced, false);
});
