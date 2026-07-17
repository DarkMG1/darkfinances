const test = require('node:test');
const assert = require('node:assert/strict');
const crypto = require('node:crypto');
const fs = require('node:fs');
const path = require('node:path');
const { QueryClient, QueryObserver } = require('@tanstack/react-query');
const {
  classifyConnectivityPhase,
  createConnectivityTracker,
} = require('../src/lib/reconnect-connectivity');
const {
  extractSourceIdentity,
  identitiesEqual,
} = require('../src/lib/reconnect-source-identity');
const {
  createReconnectStaleWarningStore,
} = require('../src/lib/reconnect-stale-warning');
const {
  DEFAULT_DEBOUNCE_MS,
  DEFAULT_ONLINE_SETTLE_MS,
  createReconnectRefreshOwner,
  resetReconnectRefreshStateForTests,
} = require('../src/lib/reconnect-refresh');
const { createReconnectRefreshOwnerRunner } = require('../src/lib/reconnect-refresh-owner-runner');
const {
  FINANCE_QUERY_SCOPE_META_KEY,
  refreshActiveFinanceQueriesForScope,
} = require('../src/lib/foreground-operation-reconciliation');
const {
  createRequestOperationMachine,
} = require('../src/lib/request-operation-state');
const {
  noteReconnectForegroundCoincidence,
  registerReconnectForegroundCoincidence,
  registerReconnectRefreshRetry,
  resetReconnectRefreshRegistryForTests: resetRegistry,
} = require('../src/lib/reconnect-refresh-registry');

const SCOPE_A = 'server-aaaa';
const SCOPE_B = 'server-bbbb';
const operationScope = crypto.createHash('sha256').update('reconnect-profile').digest('hex');
const hash = (value) => crypto.createHash('sha256').update(value).digest('hex');

function sourcePayload(generation, revision = 'contract-a') {
  return {
    ok: true,
    ts: Date.now(),
    sourceFreshness: {
      cacheGeneration: generation,
      sourceRevision: revision,
      financeTimeZone: 'America/Los_Angeles',
      observedAt: Date.now(),
    },
  };
}

function queryClient() {
  return new QueryClient({
    defaultOptions: {
      queries: { retry: false, staleTime: Infinity },
    },
  });
}

function activateFinanceQuery(client, { key, scope, initialData, queryFn }) {
  client.setQueryData(key, initialData);
  const observer = new QueryObserver(client, {
    queryKey: key,
    queryFn,
    retry: false,
    staleTime: Infinity,
    meta: { [FINANCE_QUERY_SCOPE_META_KEY]: scope },
  });
  const unsubscribe = observer.subscribe(() => {});
  return {
    observer,
    query: () => client.getQueryCache().find({ queryKey: key, exact: true }),
    unsubscribe,
  };
}

function operationMachine() {
  let snapshot = null;
  let keyCreations = 0;
  const machine = createRequestOperationMachine({
    store: {
      read: () => snapshot,
      write: (next) => {
        snapshot = structuredClone(next);
      },
    },
    hash,
    keyFactory: () => {
      keyCreations += 1;
      return `ios-reconnect-${String(keyCreations).padStart(8, '0')}`;
    },
    now: (() => {
      let value = 1_700_000_000_000;
      return () => ++value;
    })(),
  });
  return { machine, keyCreations: () => keyCreations };
}

function createHarness(options = {}) {
  resetReconnectRefreshStateForTests();
  resetRegistry();

  let now = options.now ?? 1_700_000_000_000;
  let profileGeneration = options.profileGeneration ?? 1;
  let scope = options.scope ?? SCOPE_A;
  let pingCalls = 0;
  let reconcileCalls = 0;
  let refreshCalls = 0;
  let mutationRequests = 0;
  let statusRequests = 0;
  let hapticCalls = 0;
  const events = [];

  const serverGenerationRef = { value: options.serverGeneration ?? 1 };
  let pingError = options.pingError ?? null;
  const refreshErrorRef = { value: options.refreshError ?? null };
  const { machine, keyCreations } = operationMachine();

  const runner = createReconnectRefreshOwnerRunner({
    scope,
    profileGeneration,
    initialActive: options.initialActive ?? true,
    onlineSettleMs: options.onlineSettleMs ?? DEFAULT_ONLINE_SETTLE_MS,
    debounceMs: options.debounceMs ?? DEFAULT_DEBOUNCE_MS,
    backoffBaseMs: options.backoffBaseMs ?? 50,
    backoffMaxMs: options.backoffMaxMs ?? 400,
    now: () => now,
    onEvent: (event) => events.push(event),
    fetchSourceFreshness: async () => {
      pingCalls += 1;
      if (pingError) throw pingError;
      return sourcePayload(serverGenerationRef.value, options.sourceRevision ?? 'contract-a');
    },
    reconcileOperations: async () => {
      reconcileCalls += 1;
      if (options.pendingOperation) {
        const summary = await machine.reconcileProfile(operationScope, async (key) => {
          statusRequests += 1;
          return { status: 'completed', result: { transactionId: 'txn-1' } };
        });
        return summary;
      }
      return { checked: 0, completed: 0, failed: 0, unresolved: 0 };
    },
    refreshActiveQueries: async () => {
      refreshCalls += 1;
      if (refreshErrorRef.value) throw refreshErrorRef.value;
    },
  });

  registerReconnectRefreshRetry(() => runner.owner.startRefresh('manual'));
  registerReconnectForegroundCoincidence(() => runner.owner.noteForegroundCoincidence());

  return {
    runner,
    owner: runner.owner,
    machine,
    keyCreations,
    advance(ms) {
      now += ms;
    },
    setScope(next) {
      scope = next;
      runner.owner.setScope(next);
    },
    setProfileGeneration(next) {
      profileGeneration = next;
      runner.owner.setProfileGeneration(next);
    },
    goOffline() {
      runner.owner.handleConnectivitySnapshot({ isConnected: false, isInternetReachable: false });
    },
    goOnline() {
      runner.owner.handleConnectivitySnapshot({ isConnected: true, isInternetReachable: true });
    },
    goUnknown() {
      runner.owner.handleConnectivitySnapshot({ isConnected: true, isInternetReachable: null });
    },
    async runReconnectCycle() {
      this.goOffline();
      this.goOnline();
      runner.flushSchedules(DEFAULT_ONLINE_SETTLE_MS + DEFAULT_DEBOUNCE_MS);
      while (runner.owner.isInFlight()) {
        await Promise.resolve();
      }
    },
    setServerGeneration(value) {
      serverGenerationRef.value = value;
    },
    setRefreshError(value) {
      refreshErrorRef.value = value;
    },
    counts: () => ({
      pingCalls,
      reconcileCalls,
      refreshCalls,
      mutationRequests,
      statusRequests,
      hapticCalls,
    }),
    events: () => events,
  };
}

test('connectivity classifier requires connected and reachable for online', () => {
  assert.equal(classifyConnectivityPhase({ isConnected: true, isInternetReachable: true }), 'online');
  assert.equal(classifyConnectivityPhase({ isConnected: true, isInternetReachable: null }), 'unknown');
  assert.equal(classifyConnectivityPhase({ isConnected: false, isInternetReachable: true }), 'offline');
  assert.equal(classifyConnectivityPhase({ isConnected: true, isInternetReachable: false }), 'offline');
});

test('initial online connectivity does not schedule reconnect refresh', async () => {
  const harness = createHarness();
  harness.goOnline();
  harness.runner.flushSchedules(10_000);
  await Promise.resolve();
  assert.deepEqual(harness.counts(), {
    pingCalls: 0,
    reconcileCalls: 0,
    refreshCalls: 0,
    mutationRequests: 0,
    statusRequests: 0,
    hapticCalls: 0,
  });
});

test('confirmed offline to online runs bounded source check then refetch', async () => {
  const harness = createHarness();
  await harness.runReconnectCycle();
  assert.equal(harness.counts().pingCalls, 1);
  assert.equal(harness.counts().reconcileCalls, 1);
  assert.equal(harness.counts().refreshCalls, 1);
  assert.equal(harness.events().some((event) => event.type === 'refresh_succeeded'), true);
});

test('unknown reachability transitions do not trigger refresh', async () => {
  const harness = createHarness();
  harness.goUnknown();
  harness.runner.flushSchedules(10_000);
  harness.goOffline();
  harness.goUnknown();
  harness.runner.flushSchedules(10_000);
  await Promise.resolve();
  assert.equal(harness.counts().pingCalls, 0);
});

test('cache A vs server source B refreshes active current-profile queries', async () => {
  const client = queryClient();
  let requests = 0;
  const active = activateFinanceQuery(client, {
    key: ['today', SCOPE_A],
    scope: SCOPE_A,
    initialData: { revision: 'cache-a', balance: 10 },
    queryFn: async () => {
      requests += 1;
      return { revision: 'source-b', balance: 20 };
    },
  });
  const inactive = activateFinanceQuery(client, {
    key: ['accounts', SCOPE_A],
    scope: SCOPE_A,
    initialData: { version: 'cache-a' },
    queryFn: async () => ({ version: 'source-b' }),
  });
  inactive.observer.setOptions({ enabled: false });

  const owner = createReconnectRefreshOwner({
    scope: SCOPE_A,
    profileGeneration: 1,
    fetchSourceFreshness: async () => sourcePayload(2, 'contract-b'),
    reconcileOperations: async () => ({ checked: 0, completed: 0, failed: 0, unresolved: 0 }),
    refreshActiveQueries: async () => refreshActiveFinanceQueriesForScope(client, SCOPE_A),
  });

  try {
    owner.handleConnectivitySnapshot({ isConnected: false, isInternetReachable: false });
    owner.handleConnectivitySnapshot({ isConnected: true, isInternetReachable: true });
    await new Promise((resolve) => setTimeout(resolve, DEFAULT_ONLINE_SETTLE_MS + DEFAULT_DEBOUNCE_MS + 50));
    while (owner.isInFlight()) await Promise.resolve();

    assert.equal(requests, 1);
    assert.deepEqual(client.getQueryData(['today', SCOPE_A]), { revision: 'source-b', balance: 20 });
    assert.deepEqual(client.getQueryData(['accounts', SCOPE_A]), { version: 'cache-a' });
    assert.equal(owner.getConfirmedIdentity()?.cacheGeneration, 2);
  } finally {
    active.unsubscribe();
    inactive.unsubscribe();
    owner.dispose();
    client.clear();
  }
});

test('stale cache generation on server is detected before refetch succeeds', async () => {
  const harness = createHarness({ serverGeneration: 3 });
  await harness.runReconnectCycle();
  harness.setServerGeneration(7);
  harness.goOffline();
  harness.goOnline();
  harness.runner.flushSchedules(DEFAULT_ONLINE_SETTLE_MS + DEFAULT_DEBOUNCE_MS);
  while (harness.owner.isInFlight()) await Promise.resolve();
  const confirmed = harness.events().filter((event) => event.type === 'source_identity_confirmed').at(-1);
  assert.equal(confirmed.changed, true);
  assert.equal(confirmed.identity.cacheGeneration, 7);
});

test('ping timeout records redacted stale warning without clearing cache', async () => {
  const harness = createHarness({
    pingError: Object.assign(new Error('timeout'), { code: 'TIMEOUT', status: 408, token: 'secret' }),
  });
  await harness.runReconnectCycle();
  const warning = harness.owner.staleWarning.get(SCOPE_A);
  assert.equal(warning.code, 'RECONNECT_SOURCE_TIMEOUT');
  assert.equal(warning.status, 408);
  assert.doesNotMatch(JSON.stringify(warning), /secret/i);
});

test('auth failure records stale warning', async () => {
  const harness = createHarness({
    pingError: Object.assign(new Error('auth'), { status: 403, body: { token: 'secret' } }),
  });
  await harness.runReconnectCycle();
  assert.equal(harness.owner.staleWarning.get(SCOPE_A).code, 'RECONNECT_SOURCE_AUTH');
});

test('refetch failure leaves stale warning until a later success clears it', async () => {
  const harness = createHarness({
    refreshError: Object.assign(new Error('fail'), { code: 'RECONNECT_REFETCH_FAILED', status: 503 }),
  });
  await harness.runReconnectCycle();
  assert.equal(harness.owner.staleWarning.get(SCOPE_A).code, 'RECONNECT_REFETCH_FAILED');

  harness.setRefreshError(null);
  harness.advance(100);
  harness.owner.startRefresh('manual');
  while (harness.owner.isInFlight()) await Promise.resolve();
  assert.equal(harness.owner.staleWarning.get(SCOPE_A), null);
});

test('successful source-fresh refetch clears stale warning', async () => {
  const harness = createHarness();
  harness.owner.staleWarning.set(SCOPE_A, { code: 'RECONNECT_REFRESH_FAILED', status: 500 });
  await harness.runReconnectCycle();
  assert.equal(harness.owner.staleWarning.get(SCOPE_A), null);
});

test('profile switch during ping aborts stale work for old profile', async () => {
  let resolvePing;
  let refreshCalls = 0;
  const runner = createReconnectRefreshOwnerRunner({
    scope: SCOPE_A,
    profileGeneration: 1,
    fetchSourceFreshness: () => new Promise((resolve) => {
      resolvePing = resolve;
    }),
    reconcileOperations: async () => ({ checked: 0, completed: 0, failed: 0, unresolved: 0 }),
    refreshActiveQueries: async () => {
      refreshCalls += 1;
    },
  });

  runner.owner.handleConnectivitySnapshot({ isConnected: false, isInternetReachable: false });
  runner.owner.handleConnectivitySnapshot({ isConnected: true, isInternetReachable: true });
  runner.flushSchedules(DEFAULT_ONLINE_SETTLE_MS + DEFAULT_DEBOUNCE_MS);
  assert.equal(runner.owner.isInFlight(), true);
  runner.owner.setScope(SCOPE_B);
  resolvePing(sourcePayload(2));
  while (runner.owner.isInFlight()) await Promise.resolve();
  assert.equal(refreshCalls, 0);
});

test('profile generation bump during refresh aborts without applying results', async () => {
  let releaseRefresh;
  const runner = createReconnectRefreshOwnerRunner({
    scope: SCOPE_A,
    profileGeneration: 1,
    fetchSourceFreshness: async () => sourcePayload(1),
    reconcileOperations: async () => ({ checked: 0, completed: 0, failed: 0, unresolved: 0 }),
    refreshActiveQueries: () => new Promise((resolve) => {
      releaseRefresh = resolve;
    }),
  });

  runner.owner.handleConnectivitySnapshot({ isConnected: false, isInternetReachable: false });
  runner.owner.handleConnectivitySnapshot({ isConnected: true, isInternetReachable: true });
  runner.flushSchedules(DEFAULT_ONLINE_SETTLE_MS + DEFAULT_DEBOUNCE_MS);
  await Promise.resolve();
  await Promise.resolve();
  assert.equal(typeof releaseRefresh, 'function');
  runner.owner.setProfileGeneration(99);
  releaseRefresh();
  await Promise.resolve();
  assert.equal(runner.owner.getConfirmedIdentity(), null);
});

test('repeated connectivity flaps coalesce to single-flight refresh', async () => {
  const harness = createHarness();
  harness.goOffline();
  harness.goOnline();
  harness.goOffline();
  harness.goOnline();
  harness.runner.flushSchedules(DEFAULT_ONLINE_SETTLE_MS + DEFAULT_DEBOUNCE_MS);
  while (harness.owner.isInFlight()) await Promise.resolve();
  await Promise.resolve();
  assert.equal(harness.counts().pingCalls, 1);
});

test('foreground coincidence coalesces with pending reconnect refresh', async () => {
  const harness = createHarness();
  harness.goOffline();
  harness.goOnline();
  harness.runner.flushSchedules(DEFAULT_ONLINE_SETTLE_MS);
  noteReconnectForegroundCoincidence();
  harness.runner.flushSchedules(DEFAULT_DEBOUNCE_MS);
  while (harness.owner.isInFlight()) await Promise.resolve();
  assert.equal(harness.counts().pingCalls, 1);
});

test('unresolved operation reconciliation uses status GET only and zero mutation requests', async () => {
  const { machine, keyCreations } = operationMachine();
  const record = machine.prepare({
    scopeDigest: operationScope,
    method: 'POST',
    endpoint: '/api/v1/transactions',
    body: { amount: 12 },
  });
  machine.markDispatching(record.requestDigest);

  let statusRequests = 0;
  const runner = createReconnectRefreshOwnerRunner({
    scope: SCOPE_A,
    profileGeneration: 1,
    fetchSourceFreshness: async () => sourcePayload(1),
    reconcileOperations: async () => machine.reconcileProfile(operationScope, async () => {
      statusRequests += 1;
      return { status: 'completed', result: { transactionId: 'txn-1' } };
    }),
    refreshActiveQueries: async () => {},
  });

  runner.owner.handleConnectivitySnapshot({ isConnected: false, isInternetReachable: false });
  runner.owner.handleConnectivitySnapshot({ isConnected: true, isInternetReachable: true });
  runner.flushSchedules(DEFAULT_ONLINE_SETTLE_MS + DEFAULT_DEBOUNCE_MS);
  while (runner.owner.isInFlight()) await Promise.resolve();

  assert.equal(statusRequests, 1);
  assert.equal(keyCreations(), 1);
  assert.equal(machine.listRecords(operationScope).length, 0);
});

test('purge clears confirmed identity and stale warning for scope', () => {
  resetReconnectRefreshStateForTests();
  const owner = createReconnectRefreshOwner({
    scope: SCOPE_A,
    profileGeneration: 1,
    fetchSourceFreshness: async () => sourcePayload(1),
    reconcileOperations: async () => ({}),
    refreshActiveQueries: async () => {},
  });
  owner.staleWarning.set(SCOPE_A, { code: 'RECONNECT_REFRESH_FAILED' });
  owner.purgeProfile(SCOPE_A);
  assert.equal(owner.staleWarning.get(SCOPE_A), null);
  owner.dispose();
});

test('extractSourceIdentity prefers explicit sourceFreshness contract', () => {
  const identity = extractSourceIdentity(sourcePayload(4, 'rev-4'));
  assert.deepEqual(identity, {
    cacheGeneration: 4,
    sourceRevision: 'rev-4',
    financeTimeZone: 'America/Los_Angeles',
    observedAt: identity.observedAt,
  });
  assert.equal(identitiesEqual(identity, extractSourceIdentity(sourcePayload(4, 'rev-4'))), true);
});

test('root layout mounts reconnect refresh owner exactly once', () => {
  const layout = fs.readFileSync(path.join(__dirname, '../src/app/_layout.tsx'), 'utf8');
  const matches = layout.match(/<ReconnectRefreshOwner\s*\/>/g) ?? [];
  assert.equal(matches.length, 1);
  assert.match(layout, /noteReconnectForegroundCoincidence\(\)/);
  assert.doesNotMatch(fs.readFileSync(path.join(__dirname, '../src/components/finance-status-banner.tsx'), 'utf8'), /invalidateQueries/);
});

test('reconnect stale banner exposes accessible status surface', () => {
  const banner = fs.readFileSync(path.join(__dirname, '../src/components/reconnect-stale-banner.tsx'), 'utf8');
  assert.match(banner, /accessibilityRole="button"/);
  assert.match(banner, /accessibilityLiveRegion="polite"/);
  assert.match(banner, /testID="reconnect-stale-banner"/);
});

test('connectivity tracker ignores initial unknown to online', () => {
  const tracker = createConnectivityTracker({ initialPhase: 'unknown' });
  const first = tracker.applySnapshot({ isConnected: true, isInternetReachable: true });
  assert.equal(first.confirmedOfflineToOnline, false);
  tracker.applySnapshot({ isConnected: false, isInternetReachable: false });
  const third = tracker.applySnapshot({ isConnected: true, isInternetReachable: true });
  assert.equal(third.confirmedOfflineToOnline, true);
});
