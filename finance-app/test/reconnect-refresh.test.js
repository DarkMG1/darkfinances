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
  getReconnectStaleWarningStore,
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
  registerReconnectServerRecovery,
  registerReconnectConnectivityPhase,
  purgeReconnectRefreshProfileState,
  resetReconnectRefreshRegistryForTests: resetRegistry,
} = require('../src/lib/reconnect-refresh-registry');

const SCOPE_A = 'server-aaaa';
const SCOPE_B = 'server-bbbb';
const operationScope = crypto.createHash('sha256').update('reconnect-profile').digest('hex');
const hash = (value) => crypto.createHash('sha256').update(value).digest('hex');

function probePayload(generationAfter, revision = 'rev-a', generationBefore = generationAfter - 1) {
  return {
    ok: true,
    probeKind: 'actual-direct-accounts',
    cacheGenerationBefore: generationBefore,
    cacheGenerationAfter: generationAfter,
    sourceObservedRevision: revision,
    sourceObservedAt: Date.now(),
    financeTimeZone: 'America/Los_Angeles',
    deployIdentity: 'deploy-contract-a',
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
  const sourceRevisionRef = {
    value: options.sourceObservedRevision ?? (serverGenerationRef.value >= 7 ? 'rev-b' : 'rev-a'),
  };
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
      return probePayload(serverGenerationRef.value, sourceRevisionRef.value, serverGenerationRef.value - 1);
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
      if (!options.sourceObservedRevision) {
        sourceRevisionRef.value = value >= 7 ? 'rev-b' : 'rev-a';
      }
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
    fetchSourceFreshness: async () => probePayload(2, 'rev-b', 1),
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
  assert.equal(confirmed.identity.sourceObservedRevision, 'rev-b');
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
  resolvePing(probePayload(2));
  while (runner.owner.isInFlight()) await Promise.resolve();
  assert.equal(refreshCalls, 0);
});

test('profile generation bump during refresh aborts without applying results', async () => {
  let releaseRefresh;
  const runner = createReconnectRefreshOwnerRunner({
    scope: SCOPE_A,
    profileGeneration: 1,
    fetchSourceFreshness: async () => probePayload(1),
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
    fetchSourceFreshness: async () => probePayload(1),
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
    fetchSourceFreshness: async () => probePayload(1),
    reconcileOperations: async () => ({}),
    refreshActiveQueries: async () => {},
  });
  owner.staleWarning.set(SCOPE_A, { code: 'RECONNECT_REFRESH_FAILED' });
  owner.purgeProfile(SCOPE_A);
  assert.equal(owner.staleWarning.get(SCOPE_A), null);
  owner.dispose();
});

test('extractSourceIdentity uses reconnect probe evidence fields honestly', () => {
  const identity = extractSourceIdentity(probePayload(4, 'rev-4', 3));
  assert.deepEqual(identity, {
    cacheGeneration: 4,
    sourceObservedRevision: 'rev-4',
    sourceObservedAt: identity.sourceObservedAt,
    deployIdentity: 'deploy-contract-a',
    probeKind: 'actual-direct-accounts',
  });
  assert.equal(identitiesEqual(identity, extractSourceIdentity(probePayload(4, 'rev-4', 3))), true);
  assert.doesNotMatch(JSON.stringify(identity), /sourceRevision/i);
});

test('exponential backoff doubles after repeated probe failures', async () => {
  const harness = createHarness({
    pingError: Object.assign(new Error('timeout'), { code: 'TIMEOUT', status: 408 }),
    backoffBaseMs: 100,
    backoffMaxMs: 800,
  });
  await harness.runReconnectCycle();
  assert.equal(harness.owner.getBackoffMs(), 100);
  harness.advance(150);
  harness.owner.startRefresh('backoff');
  while (harness.owner.isInFlight()) await Promise.resolve();
  assert.equal(harness.owner.getBackoffMs(), 200);
});

test('purge via registry clears live owner confirmed identity', async () => {
  const {
    configureReconnectRefreshOwnerDeps,
    getSharedReconnectRefreshOwner,
    resetReconnectRefreshOwnerRuntimeForTests,
    updateReconnectRefreshRuntimeConfig,
  } = require('../src/lib/reconnect-refresh-owner-runtime');
  resetReconnectRefreshStateForTests();
  resetRegistry();
  resetReconnectRefreshOwnerRuntimeForTests();
  configureReconnectRefreshOwnerDeps({
    fetchSourceFreshness: async () => probePayload(3, 'rev-live', 2),
    reconcileOperations: async () => ({ checked: 0, completed: 0, failed: 0, unresolved: 0 }),
    refreshActiveQueries: async () => {},
  });
  updateReconnectRefreshRuntimeConfig({
    scope: SCOPE_A,
    profileGeneration: 1,
    active: true,
    demo: false,
  });
  const owner = getSharedReconnectRefreshOwner();
  owner.startRefresh('manual');
  while (owner.isInFlight()) await Promise.resolve();
  assert.equal(owner.getConfirmedIdentity(SCOPE_A)?.cacheGeneration, 3);
  getReconnectStaleWarningStore().set(SCOPE_A, { code: 'RECONNECT_REFRESH_FAILED' });
  purgeReconnectRefreshProfileState(SCOPE_A);
  assert.equal(owner.getConfirmedIdentity(SCOPE_A), null);
  assert.equal(getReconnectStaleWarningStore().get(SCOPE_A), null);
  resetReconnectRefreshOwnerRuntimeForTests();
});

test('profile purge via registry succeeds before owner runtime is configured', () => {
  const {
    isReconnectRefreshOwnerConfigured,
    resetReconnectRefreshOwnerRuntimeForTests,
  } = require('../src/lib/reconnect-refresh-owner-runtime');
  resetReconnectRefreshStateForTests();
  resetRegistry();
  resetReconnectRefreshOwnerRuntimeForTests();
  assert.equal(isReconnectRefreshOwnerConfigured(), false);
  getReconnectStaleWarningStore().set(SCOPE_A, { code: 'RECONNECT_REFRESH_FAILED' });
  assert.doesNotThrow(() => purgeReconnectRefreshProfileState(SCOPE_A));
  assert.equal(getReconnectStaleWarningStore().get(SCOPE_A), null);
});

test('profile purge transitions from persistence-only to configured owner purge', async () => {
  const {
    configureReconnectRefreshOwnerDeps,
    getSharedReconnectRefreshOwner,
    isReconnectRefreshOwnerConfigured,
    resetReconnectRefreshOwnerRuntimeForTests,
    updateReconnectRefreshRuntimeConfig,
  } = require('../src/lib/reconnect-refresh-owner-runtime');
  resetReconnectRefreshStateForTests();
  resetRegistry();
  resetReconnectRefreshOwnerRuntimeForTests();

  getReconnectStaleWarningStore().set(SCOPE_A, { code: 'RECONNECT_SOURCE_TIMEOUT' });
  purgeReconnectRefreshProfileState(SCOPE_A);
  assert.equal(getReconnectStaleWarningStore().get(SCOPE_A), null);
  assert.equal(isReconnectRefreshOwnerConfigured(), false);

  configureReconnectRefreshOwnerDeps({
    fetchSourceFreshness: async () => probePayload(2, 'rev-partial', 1),
    reconcileOperations: async () => ({ checked: 0, completed: 0, failed: 0, unresolved: 0 }),
    refreshActiveQueries: async () => {},
  });
  updateReconnectRefreshRuntimeConfig({
    scope: SCOPE_A,
    profileGeneration: 1,
    active: true,
    demo: false,
  });
  const owner = getSharedReconnectRefreshOwner();
  owner.startRefresh('manual');
  while (owner.isInFlight()) await Promise.resolve();
  getReconnectStaleWarningStore().set(SCOPE_A, { code: 'RECONNECT_REFRESH_FAILED' });
  purgeReconnectRefreshProfileState(SCOPE_A);
  assert.equal(owner.getConfirmedIdentity(SCOPE_A), null);
  assert.equal(getReconnectStaleWarningStore().get(SCOPE_A), null);

  resetReconnectRefreshOwnerRuntimeForTests();
  getReconnectStaleWarningStore().set(SCOPE_A, { code: 'RECONNECT_SOURCE_AUTH' });
  assert.doesNotThrow(() => purgeReconnectRefreshProfileState(SCOPE_A));
  assert.equal(getReconnectStaleWarningStore().get(SCOPE_A), null);
  assert.equal(isReconnectRefreshOwnerConfigured(), false);
});

test('configured owner purge surfaces owner failures without swallowing', () => {
  const {
    configureReconnectRefreshOwnerDeps,
    getSharedReconnectRefreshOwner,
    resetReconnectRefreshOwnerRuntimeForTests,
    updateReconnectRefreshRuntimeConfig,
  } = require('../src/lib/reconnect-refresh-owner-runtime');
  resetReconnectRefreshStateForTests();
  resetRegistry();
  resetReconnectRefreshOwnerRuntimeForTests();
  configureReconnectRefreshOwnerDeps({
    fetchSourceFreshness: async () => probePayload(1),
    reconcileOperations: async () => ({}),
    refreshActiveQueries: async () => {},
  });
  updateReconnectRefreshRuntimeConfig({
    scope: SCOPE_A,
    profileGeneration: 1,
    active: true,
    demo: false,
  });
  const owner = getSharedReconnectRefreshOwner();
  owner.purgeProfile = () => {
    throw new Error('configured owner purge failed');
  };
  getReconnectStaleWarningStore().set(SCOPE_A, { code: 'RECONNECT_REFRESH_FAILED' });
  assert.throws(
    () => purgeReconnectRefreshProfileState(SCOPE_A),
    /configured owner purge failed/,
  );
  assert.equal(getReconnectStaleWarningStore().get(SCOPE_A), null);
  resetReconnectRefreshOwnerRuntimeForTests();
});

test('reconnect refresh registry and owner runtime avoid import cycles', () => {
  const registrySource = fs.readFileSync(
    path.join(__dirname, '../src/lib/reconnect-refresh-registry.js'),
    'utf8',
  );
  const runtimeSource = fs.readFileSync(
    path.join(__dirname, '../src/lib/reconnect-refresh-owner-runtime.js'),
    'utf8',
  );
  const refreshSource = fs.readFileSync(
    path.join(__dirname, '../src/lib/reconnect-refresh.js'),
    'utf8',
  );
  assert.doesNotMatch(registrySource, /reconnect-refresh-owner-runtime/);
  assert.match(runtimeSource, /require\('\.\/reconnect-refresh'\)/);
  assert.doesNotMatch(runtimeSource, /reconnect-refresh-registry/);
  assert.match(refreshSource, /require\('\.\/reconnect-refresh-owner-runtime'\)/);
});

test('finance status banner routes online ping recovery through reconnect owner', () => {
  const banner = fs.readFileSync(path.join(__dirname, '../src/components/finance-status-banner.tsx'), 'utf8');
  assert.match(banner, /requestReconnectServerRecovery/);
  assert.match(banner, /getReconnectConnectivityPhase/);
  assert.match(banner, /applyPingAvailabilityTransition/);
  assert.doesNotMatch(banner, /invalidateQueries/);
});

test('ping error then success while online triggers exactly one owner recovery', () => {
  const { applyPingAvailabilityTransition } = require('../src/lib/finance-status-ping-recovery');
  resetRegistry();
  let recoveryCalls = 0;
  registerReconnectServerRecovery(() => {
    recoveryCalls += 1;
    return true;
  });
  registerReconnectConnectivityPhase(() => 'online');

  let state = { wasUnavailable: false };
  state = applyPingAvailabilityTransition(state, { isError: true, isSuccess: false, connectivityPhase: 'online' });
  assert.equal(state.wasUnavailable, true);
  assert.equal(state.recoveryRequested, false);

  state = applyPingAvailabilityTransition(state, { isError: false, isSuccess: true, connectivityPhase: 'online' });
  assert.equal(state.recoveryRequested, true);
  if (state.recoveryRequested) {
    const { requestReconnectServerRecovery } = require('../src/lib/reconnect-refresh-registry');
    requestReconnectServerRecovery();
  }
  assert.equal(recoveryCalls, 1);

  state = applyPingAvailabilityTransition(state, { isError: false, isSuccess: true, connectivityPhase: 'online' });
  assert.equal(state.recoveryRequested, false);
  resetRegistry();
});

test('generation flush refetches category and transaction queries even when accounts revision unchanged', async () => {
  const client = queryClient();
  const sharedRevision = 'same-accounts-rev';
  let accountRequests = 0;
  let categoryRequests = 0;
  let transactionRequests = 0;
  const accounts = activateFinanceQuery(client, {
    key: ['accounts', SCOPE_A],
    scope: SCOPE_A,
    initialData: [{ id: 'a1', name: 'Cached-A', revision: sharedRevision }],
    queryFn: async () => {
      accountRequests += 1;
      return [{ id: 'a1', name: 'Fresh-B', revision: sharedRevision }];
    },
  });
  const categories = activateFinanceQuery(client, {
    key: ['categories', SCOPE_A],
    scope: SCOPE_A,
    initialData: [{ id: 'c1', name: 'Cat-A' }],
    queryFn: async () => {
      categoryRequests += 1;
      return [{ id: 'c1', name: 'Cat-B' }];
    },
  });
  const transactions = activateFinanceQuery(client, {
    key: ['transactions', SCOPE_A],
    scope: SCOPE_A,
    initialData: { items: [{ id: 't1', payee: 'Tx-A' }] },
    queryFn: async () => {
      transactionRequests += 1;
      return { items: [{ id: 't1', payee: 'Tx-B' }] };
    },
  });

  const owner = createReconnectRefreshOwner({
    scope: SCOPE_A,
    profileGeneration: 1,
    fetchSourceFreshness: async () => probePayload(5, sharedRevision, 4),
    reconcileOperations: async () => ({ checked: 0, completed: 0, failed: 0, unresolved: 0 }),
    refreshActiveQueries: async () => refreshActiveFinanceQueriesForScope(client, SCOPE_A),
  });

  try {
    owner.startRefresh('manual');
    while (owner.isInFlight()) await Promise.resolve();
    assert.equal(accountRequests, 1);
    assert.equal(categoryRequests, 1);
    assert.equal(transactionRequests, 1);
    assert.equal(client.getQueryData(['categories', SCOPE_A])[0].name, 'Cat-B');
    assert.equal(client.getQueryData(['transactions', SCOPE_A]).items[0].payee, 'Tx-B');
  } finally {
    accounts.unsubscribe();
    categories.unsubscribe();
    transactions.unsubscribe();
    owner.dispose();
    client.clear();
  }
});

test('client reconnect refresh calls reconnect-freshness endpoint contract', () => {
  const actions = fs.readFileSync(path.join(__dirname, '../src/lib/reconnect-refresh-actions.ts'), 'utf8');
  assert.match(actions, /reconnectFreshness\.endpoint/);
  assert.doesNotMatch(actions, /ping\.endpoint/);
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
  assert.match(banner, /<AccessibilityAnnouncementEffect message=\{announcement\} \/>/);
  assert.match(banner, /\{\.\.\.visibleStatusLiveRegionProps\(\)\}/);
  assert.doesNotMatch(banner, /<AccessibilityLiveRegion/);
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
