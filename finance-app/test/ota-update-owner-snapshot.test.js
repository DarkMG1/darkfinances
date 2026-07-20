const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const { createOtaUpdateOwner } = require('../src/lib/ota-update-owner');
const { createOtaUpdatePersistence } = require('../src/lib/ota-update-persistence');
const { OTA_UPDATE_PHASES } = require('../src/lib/ota-update-state');

const UPDATE_A = 'aaaaaaaa-aaaa-aaaa-aaaa-aaaaaaaaaaaa';
const NOW = 1_700_000_000_000;

function memoryStore() {
  const values = new Map();
  return {
    getString: (key) => values.get(key) ?? null,
    setString: (key, value) => {
      if (value == null) values.delete(key);
      else values.set(key, value);
    },
  };
}

function createMinimalOwner(options = {}) {
  const store = memoryStore();
  const persistence = createOtaUpdatePersistence(store);
  return createOtaUpdateOwner({
    isSupported: () => options.supported ?? true,
    persistence,
    now: () => NOW,
    checkForUpdate: async () => options.checkResult ?? { isAvailable: false, manifest: null },
    fetchUpdate: async () => ({ manifest: { id: UPDATE_A } }),
    reload: async () => {},
    showPrompt: () => {},
    getNativePending: () => options.nativePending ?? { pending: false, updateId: null },
    checkThrottleMs: options.checkThrottleMs ?? 0,
    deferCooldownMs: options.deferCooldownMs ?? 60_000,
    promptSettleMs: options.promptSettleMs ?? 0,
  });
}

function simulateSyncExternalStore(subscribe, getSnapshot) {
  let snapshot = getSnapshot();
  let revision = 0;
  const unsubscribe = subscribe(() => {
    const next = getSnapshot();
    if (!Object.is(next, snapshot)) {
      snapshot = next;
      revision += 1;
    }
  });
  return {
    getRevision: () => revision,
    getSnapshot: () => snapshot,
    unsubscribe,
  };
}

test('getSnapshot returns referentially stable object until state publication', async () => {
  const owner = createMinimalOwner({ supported: false });
  const first = owner.getSnapshot();
  const second = owner.getSnapshot();
  assert.ok(Object.is(first, second));

  owner.initialize();
  await owner.requestManualCheck();
  const third = owner.getSnapshot();
  assert.ok(!Object.is(first, third));
  assert.ok(Object.is(owner.getSnapshot(), third));
});

test('published snapshots are immutable and isolated from internal state', async () => {
  const owner = createMinimalOwner({
    checkResult: { isAvailable: true, manifest: { id: UPDATE_A } },
  });
  owner.initialize();
  owner.setPromptGateOpen(false);
  const published = owner.getSnapshot();
  assert.ok(Object.isFrozen(published));
  assert.throws(() => {
    'use strict';
    published.phase = OTA_UPDATE_PHASES.ERROR;
  }, TypeError);

  owner.maybeAutoCheck();
  await new Promise((resolve) => queueMicrotask(resolve));
  await new Promise((resolve) => setTimeout(resolve, 0));

  assert.equal(published.phase, OTA_UPDATE_PHASES.IDLE);
  assert.equal(owner.getSnapshot().phase, OTA_UPDATE_PHASES.DOWNLOADED);
  assert.ok(!Object.is(published, owner.getSnapshot()));
});

test('subscribe notifies only when snapshot identity changes', async () => {
  const owner = createMinimalOwner({
    checkResult: { isAvailable: true, manifest: { id: UPDATE_A } },
  });
  let calls = 0;
  owner.subscribe(() => {
    calls += 1;
  });

  owner.initialize();
  owner.setPromptGateOpen(true);
  owner.maybeAutoCheck();
  await new Promise((resolve) => queueMicrotask(resolve));
  await new Promise((resolve) => setTimeout(resolve, 0));
  assert.ok(calls >= 1);

  const before = calls;
  owner.getSnapshot();
  owner.getSnapshot();
  assert.equal(calls, before);
});

test('listener reads new snapshot exactly when notified', async () => {
  const owner = createMinimalOwner({
    checkResult: { isAvailable: true, manifest: { id: UPDATE_A } },
  });
  const seen = [];
  owner.subscribe(() => seen.push(owner.getSnapshot()));

  owner.initialize();
  owner.setPromptGateOpen(false);
  owner.maybeAutoCheck();
  await new Promise((resolve) => queueMicrotask(resolve));
  await new Promise((resolve) => setTimeout(resolve, 0));

  assert.ok(seen.length >= 1);
  for (let index = 1; index < seen.length; index += 1) {
    assert.ok(!Object.is(seen[index - 1], seen[index]));
  }
  assert.equal(seen.at(-1).phase, OTA_UPDATE_PHASES.DOWNLOADED);
});

test('dispose and reinitialize reset snapshot identity and state', async () => {
  const owner = createMinimalOwner();
  owner.initialize();
  const afterInit = owner.getSnapshot();
  assert.equal(afterInit.phase, OTA_UPDATE_PHASES.IDLE);

  await owner.requestManualCheck();
  const afterDispatch = owner.getSnapshot();
  assert.ok(!Object.is(afterInit, afterDispatch));

  owner.dispose();
  const afterDispose = owner.getSnapshot();
  assert.ok(!Object.is(afterDispatch, afterDispose));
  assert.equal(afterDispose.phase, OTA_UPDATE_PHASES.IDLE);

  owner.initialize();
  const afterReinit = owner.getSnapshot();
  assert.ok(!Object.is(afterDispose, afterReinit));
});

test('useSyncExternalStore simulation stays stable across repeated reads without publication', () => {
  const owner = createMinimalOwner();
  owner.initialize();
  const store = simulateSyncExternalStore(owner.subscribe, owner.getSnapshot);
  const baseline = store.getRevision();

  owner.getSnapshot();
  owner.getSnapshot();
  owner.getSnapshot();
  assert.equal(store.getRevision(), baseline);
  store.unsubscribe();
});

test('useSyncExternalStore simulation advances only on real state transitions', async () => {
  const owner = createMinimalOwner({
    checkResult: { isAvailable: true, manifest: { id: UPDATE_A } },
  });
  owner.initialize();
  const store = simulateSyncExternalStore(owner.subscribe, owner.getSnapshot);
  const baseline = store.getRevision();

  owner.setPromptGateOpen(false);
  owner.maybeAutoCheck();
  await new Promise((resolve) => queueMicrotask(resolve));
  await new Promise((resolve) => setTimeout(resolve, 0));

  assert.ok(store.getRevision() > baseline);
  assert.equal(store.getSnapshot().phase, OTA_UPDATE_PHASES.DOWNLOADED);
  store.unsubscribe();
});

test('auto-update and OTA status hooks wire stable owner subscribe/getSnapshot references', () => {
  const autoUpdateSource = fs.readFileSync(
    path.join(__dirname, '../src/lib/auto-update.ts'),
    'utf8',
  );
  assert.match(autoUpdateSource, /useSyncExternalStore\(owner\.subscribe, owner\.getSnapshot, owner\.getSnapshot\)/);
  assert.doesNotMatch(autoUpdateSource, /useSyncExternalStore\(\s*\(\)\s*=>/);
  assert.doesNotMatch(autoUpdateSource, /useSyncExternalStore\(\s*\(\s*listener\s*\)\s*=>/);
});

test('reconnect stale banner stabilizes subscribe and getSnapshot with useCallback', () => {
  const banner = fs.readFileSync(
    path.join(__dirname, '../src/components/reconnect-stale-banner.tsx'),
    'utf8',
  );
  assert.match(banner, /const subscribe = useCallback\(\(listener: \(\) => void\) => store\.subscribe\(listener\), \[store\]\)/);
  assert.match(banner, /const getSnapshot = useCallback\(\(\) => store\.get\(scope\), \[store, scope\]\)/);
  assert.match(banner, /useSyncExternalStore\(subscribe, getSnapshot, getSnapshot\)/);
});

test('finance date provider stabilizes subscribe and getSnapshot with useCallback', () => {
  const provider = fs.readFileSync(
    path.join(__dirname, '../src/state/finance-date.tsx'),
    'utf8',
  );
  assert.match(provider, /const subscribe = useCallback\(\(listener: \(\) => void\) => store\.subscribe\(listener\), \[store\]\)/);
  assert.match(provider, /const getSnapshot = useCallback\(\(\) => store\.getSnapshot\(\), \[store\]\)/);
  assert.match(provider, /useSyncExternalStore\(subscribe, getSnapshot, getSnapshot\)/);
});
