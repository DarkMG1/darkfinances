const test = require('node:test');
const assert = require('node:assert/strict');
const { createOtaUpdatePersistence } = require('../src/lib/ota-update-persistence');
const { createOtaUpdateOwnerRunner } = require('../src/lib/ota-update-owner-runner');
const {
  DEFAULT_CHECK_THROTTLE_MS,
  DEFAULT_PROMPT_SETTLE_MS,
  OTA_UPDATE_PHASES,
} = require('../src/lib/ota-update-state');

const UPDATE_A = 'aaaaaaaa-aaaa-aaaa-aaaa-aaaaaaaaaaaa';
const UPDATE_B = 'bbbbbbbb-bbbb-bbbb-bbbb-bbbbbbbbbbbb';
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

function createHarness(options = {}) {
  let now = NOW;
  let supported = options.supported ?? true;
  let appActive = true;
  let promptGateOpen = options.promptGateOpen ?? true;
  let nativePending = options.nativePending ?? { pending: false, updateId: null };
  let checkCalls = 0;
  let fetchCalls = 0;
  let reloadCalls = 0;
  let checkResult = options.checkResult ?? { isAvailable: true, manifest: { id: UPDATE_A } };
  let fetchResult = options.fetchResult ?? { manifest: { id: UPDATE_A } };
  let checkDelay = options.checkDelay ?? 0;
  let fetchDelay = options.fetchDelay ?? 0;
  let checkError = options.checkError ?? null;
  let fetchError = options.fetchError ?? null;
  let reloadError = options.reloadError ?? null;
  let checkHeld = options.holdCheck ?? false;
  let fetchHeld = options.holdFetch ?? false;
  let resolveCheck = null;
  let resolveFetch = null;

  async function awaitNetworkStep(delayMs, held, setRelease) {
    if (held) {
      await new Promise((resolve) => {
        setRelease(resolve);
      });
      return;
    }
    if (delayMs > 0) {
      await new Promise((resolve) => setTimeout(resolve, delayMs));
      return;
    }
    await new Promise((resolve) => queueMicrotask(resolve));
  }

  const store = memoryStore();
  const runner = createOtaUpdateOwnerRunner({
    store,
    isSupported: () => supported,
    now: () => now,
    getNativePending: () => nativePending,
    checkForUpdate: async () => {
      checkCalls += 1;
      await awaitNetworkStep(checkDelay, checkHeld, (resolve) => {
        resolveCheck = resolve;
      });
      if (checkError) throw checkError;
      return checkResult;
    },
    fetchUpdate: async () => {
      fetchCalls += 1;
      await awaitNetworkStep(fetchDelay, fetchHeld, (resolve) => {
        resolveFetch = resolve;
      });
      if (fetchError) throw fetchError;
      return fetchResult;
    },
    reload: async () => {
      reloadCalls += 1;
      if (reloadError) throw reloadError;
    },
    checkThrottleMs: options.checkThrottleMs ?? DEFAULT_CHECK_THROTTLE_MS,
    deferCooldownMs: options.deferCooldownMs ?? 60_000,
    promptSettleMs: options.promptSettleMs ?? DEFAULT_PROMPT_SETTLE_MS,
  });

  const { owner } = runner;

  return {
    owner,
    runner,
    store,
    advance(ms) {
      now += ms;
    },
    setSupported(value) {
      supported = value;
    },
    setNativePending(value) {
      nativePending = value;
    },
    setPromptGateOpen(value) {
      promptGateOpen = value;
      owner.setPromptGateOpen(value);
    },
    setAppActive(value) {
      appActive = value;
      owner.setAppActive(value);
    },
    startup() {
      owner.initialize();
      owner.setAppActive(appActive);
      owner.setPromptGateOpen(promptGateOpen);
      owner.maybeAutoCheck();
    },
    awaitIdle() {
      return runner.whenIdle();
    },
    holdCheck() {
      checkHeld = true;
    },
    releaseCheck() {
      checkHeld = false;
      resolveCheck?.();
      resolveCheck = null;
    },
    holdFetch() {
      fetchHeld = true;
    },
    releaseFetch() {
      fetchHeld = false;
      resolveFetch?.();
      resolveFetch = null;
    },
    metrics: () => ({
      checkCalls,
      fetchCalls,
      reloadCalls,
    }),
    setCheckResult(value) {
      checkResult = value;
    },
    setFetchResult(value) {
      fetchResult = value;
    },
    setCheckError(value) {
      checkError = value;
    },
    setReloadError(value) {
      reloadError = value;
    },
  };
}

test('legacy duplicate concurrent auto checks collapse to one network check', async () => {
  const harness = createHarness({ checkDelay: 5 });
  harness.startup();
  harness.owner.maybeAutoCheck();
  harness.owner.maybeAutoCheck();
  harness.owner.setAppActive(true);
  await harness.awaitIdle();
  assert.equal(harness.metrics().checkCalls, 1);
  assert.equal(harness.metrics().fetchCalls, 1);
  assert.equal(harness.owner.getSnapshot().phase, OTA_UPDATE_PHASES.DOWNLOADED);
});

test('downloaded-on-start prompts once after privacy gate opens', async () => {
  const harness = createHarness({
    nativePending: { pending: true, updateId: UPDATE_A },
    promptGateOpen: false,
  });
  harness.startup();
  assert.equal(harness.runner.promptCount(), 0);
  harness.setPromptGateOpen(true);
  harness.runner.flushSchedules(DEFAULT_PROMPT_SETTLE_MS);
  assert.equal(harness.runner.promptCount(), 1);
  harness.runner.flushSchedules(DEFAULT_PROMPT_SETTLE_MS);
  assert.equal(harness.runner.promptCount(), 1);
});

test('check download prompt flow respects privacy gate transitions', async () => {
  const harness = createHarness({ promptGateOpen: false });
  harness.startup();
  await harness.awaitIdle();
  assert.equal(harness.owner.getSnapshot().phase, OTA_UPDATE_PHASES.DOWNLOADED);
  assert.equal(harness.runner.promptCount(), 0);
  harness.setPromptGateOpen(true);
  harness.runner.flushSchedules(DEFAULT_PROMPT_SETTLE_MS);
  assert.equal(harness.runner.promptCount(), 1);
});

test('Later persists cooldown and manual check still reports downloaded state', async () => {
  const harness = createHarness({ deferCooldownMs: 60_000 });
  harness.startup();
  await harness.awaitIdle();
  harness.runner.flushSchedules(DEFAULT_PROMPT_SETTLE_MS);
  harness.runner.lastPrompt().onLater();
  assert.equal(harness.owner.getSnapshot().phase, OTA_UPDATE_PHASES.DEFERRED);
  const persistence = createOtaUpdatePersistence(harness.store);
  assert.deepEqual(persistence.readDeferred(harness.owner.getSnapshot().deferredUntil - 1), {
    updateId: UPDATE_A,
    deferredUntil: NOW + 60_000,
  });
  const manual = await harness.owner.requestManualCheck();
  assert.equal(manual.manualStatus, 'Update downloaded; restart prompt ready');
  assert.equal(harness.metrics().checkCalls, 2);
});

test('a second update id prompts even when the first is deferred', async () => {
  const harness = createHarness({ deferCooldownMs: 60_000 });
  harness.startup();
  await harness.awaitIdle();
  harness.runner.flushSchedules(DEFAULT_PROMPT_SETTLE_MS);
  harness.runner.lastPrompt().onLater();
  harness.setCheckResult({ isAvailable: true, manifest: { id: UPDATE_B } });
  harness.setFetchResult({ manifest: { id: UPDATE_B } });
  await harness.owner.requestManualCheck();
  assert.equal(harness.owner.getSnapshot().updateId, UPDATE_B);
  assert.equal(harness.owner.getSnapshot().phase, OTA_UPDATE_PHASES.DOWNLOADED);
  harness.runner.flushSchedules(DEFAULT_PROMPT_SETTLE_MS);
  assert.equal(harness.runner.promptCount(), 2);
});

test('background transitions cancel pending prompt timers without duplicate prompts', async () => {
  const harness = createHarness({ promptGateOpen: true });
  harness.startup();
  await harness.awaitIdle();
  assert.equal(harness.runner.scheduledCount(), 1);
  harness.setAppActive(false);
  assert.equal(harness.runner.scheduledCount(), 0);
  harness.setAppActive(true);
  harness.runner.flushSchedules(DEFAULT_PROMPT_SETTLE_MS);
  assert.equal(harness.runner.promptCount(), 1);
});

test('errors recover and manual retry succeeds', async () => {
  const harness = createHarness();
  harness.setCheckError(new Error('offline'));
  harness.startup();
  await harness.awaitIdle();
  assert.equal(harness.owner.getSnapshot().phase, OTA_UPDATE_PHASES.ERROR);
  harness.setCheckError(null);
  await harness.owner.requestManualCheck();
  await harness.awaitIdle();
  assert.equal(harness.owner.getSnapshot().phase, OTA_UPDATE_PHASES.DOWNLOADED);
});

test('restart now only runs from prompted state after successful download', async () => {
  const harness = createHarness();
  harness.startup();
  await harness.awaitIdle();
  await harness.owner.requestRestart();
  assert.equal(harness.metrics().reloadCalls, 0);
  harness.runner.flushSchedules(DEFAULT_PROMPT_SETTLE_MS);
  await harness.owner.requestRestart();
  assert.equal(harness.metrics().reloadCalls, 1);
  assert.equal(harness.owner.getSnapshot().phase, OTA_UPDATE_PHASES.RESTARTING);
});

test('unsupported builds never invoke update APIs', async () => {
  const harness = createHarness({ supported: false });
  harness.startup();
  await harness.owner.requestManualCheck();
  assert.equal(harness.metrics().checkCalls, 0);
  assert.match(harness.owner.getSnapshot().manualStatus, /release/);
});

test('manual and automatic checks share one owner without duplicate fetch', async () => {
  const harness = createHarness({ checkDelay: 10 });
  harness.startup();
  const manualPromise = harness.owner.requestManualCheck();
  harness.owner.maybeAutoCheck();
  await manualPromise;
  await harness.awaitIdle();
  assert.equal(harness.metrics().checkCalls, 1);
  assert.equal(harness.metrics().fetchCalls, 1);
});

test('cooldown expiry reopens automatic checking for the same update id', async () => {
  const harness = createHarness({ deferCooldownMs: 1_000, checkThrottleMs: DEFAULT_CHECK_THROTTLE_MS });
  harness.startup();
  await harness.awaitIdle();
  harness.runner.flushSchedules(DEFAULT_PROMPT_SETTLE_MS);
  harness.runner.lastPrompt().onLater();
  harness.advance(1_001);
  harness.runner.flushSchedules(1_001);
  await harness.awaitIdle();
  harness.setNativePending({ pending: true, updateId: UPDATE_A });
  harness.owner.syncNativePending();
  harness.setPromptGateOpen(true);
  harness.runner.flushSchedules(DEFAULT_PROMPT_SETTLE_MS);
  assert.equal(harness.runner.promptCount(), 2);
});

test('initialize clears prior prompt and cooldown timers across remount', async () => {
  const harness = createHarness({ deferCooldownMs: 60_000 });
  harness.startup();
  await harness.awaitIdle();
  harness.runner.flushSchedules(DEFAULT_PROMPT_SETTLE_MS);
  harness.runner.lastPrompt().onLater();
  assert.ok(harness.runner.scheduledCount() > 0);
  harness.owner.initialize();
  assert.equal(harness.runner.scheduledCount(), 0);
  harness.runner.flushSchedules(DEFAULT_PROMPT_SETTLE_MS);
  assert.equal(harness.runner.promptCount(), 1);
});

test('native pending hook update during active check waits for check completion', async () => {
  const harness = createHarness({
    holdCheck: true,
    checkResult: { isAvailable: false, manifest: null },
  });
  harness.startup();
  await new Promise((resolve) => queueMicrotask(resolve));
  assert.equal(harness.metrics().checkCalls, 1);
  harness.setNativePending({ pending: true, updateId: UPDATE_A });
  harness.owner.syncNativePending();
  assert.equal(harness.owner.getSnapshot().phase, OTA_UPDATE_PHASES.CHECKING);
  harness.releaseCheck();
  await harness.awaitIdle();
  assert.equal(harness.owner.getSnapshot().phase, OTA_UPDATE_PHASES.DOWNLOADED);
  assert.equal(harness.owner.getSnapshot().updateId, UPDATE_A);
});

test('restart reload rejection clears defer state and safely re-prompts', async () => {
  const harness = createHarness({ reloadError: new Error('reload blocked') });
  harness.startup();
  await harness.awaitIdle();
  harness.runner.flushSchedules(DEFAULT_PROMPT_SETTLE_MS);
  const persistence = createOtaUpdatePersistence(harness.store);
  persistence.writeDeferred({ updateId: UPDATE_A, deferredUntil: NOW + 60_000 });
  await harness.runner.lastPrompt().onRestart();
  assert.equal(harness.metrics().reloadCalls, 1);
  assert.equal(persistence.readDeferred(NOW + 1), null);
  assert.equal(harness.owner.getSnapshot().phase, OTA_UPDATE_PHASES.DOWNLOADED);
  harness.runner.flushSchedules(DEFAULT_PROMPT_SETTLE_MS);
  assert.equal(harness.runner.promptCount(), 2);
});

test('automatic foreground check during defer discovers a different update id', async () => {
  const harness = createHarness({ deferCooldownMs: 60_000, checkThrottleMs: DEFAULT_CHECK_THROTTLE_MS });
  harness.startup();
  await harness.awaitIdle();
  harness.runner.flushSchedules(DEFAULT_PROMPT_SETTLE_MS);
  harness.runner.lastPrompt().onLater();
  assert.equal(harness.owner.getSnapshot().phase, OTA_UPDATE_PHASES.DEFERRED);

  harness.setCheckResult({ isAvailable: true, manifest: { id: UPDATE_A } });
  harness.advance(DEFAULT_CHECK_THROTTLE_MS + 1);
  harness.owner.maybeAutoCheck();
  await harness.awaitIdle();
  assert.equal(harness.owner.getSnapshot().phase, OTA_UPDATE_PHASES.DEFERRED);
  assert.equal(harness.metrics().fetchCalls, 1);

  harness.setCheckResult({ isAvailable: true, manifest: { id: UPDATE_B } });
  harness.setFetchResult({ manifest: { id: UPDATE_B } });
  harness.advance(DEFAULT_CHECK_THROTTLE_MS + 1);
  harness.owner.maybeAutoCheck();
  await harness.awaitIdle();
  assert.equal(harness.owner.getSnapshot().updateId, UPDATE_B);
  assert.equal(harness.owner.getSnapshot().phase, OTA_UPDATE_PHASES.DOWNLOADED);
  assert.equal(harness.metrics().fetchCalls, 2);
  harness.runner.flushSchedules(DEFAULT_PROMPT_SETTLE_MS);
  assert.equal(harness.runner.promptCount(), 2);
});

test('deferred auto checks respect throttle and avoid polling storms', async () => {
  const harness = createHarness({ deferCooldownMs: 60_000, checkThrottleMs: DEFAULT_CHECK_THROTTLE_MS });
  harness.startup();
  await harness.awaitIdle();
  harness.runner.flushSchedules(DEFAULT_PROMPT_SETTLE_MS);
  harness.runner.lastPrompt().onLater();

  harness.owner.maybeAutoCheck();
  harness.owner.maybeAutoCheck();
  harness.owner.setAppActive(true);
  assert.equal(harness.metrics().checkCalls, 1);

  harness.advance(DEFAULT_CHECK_THROTTLE_MS + 1);
  harness.owner.maybeAutoCheck();
  await harness.awaitIdle();
  assert.equal(harness.metrics().checkCalls, 2);
});

test('whenIdle resolves after dispose cancels a held check', async () => {
  const harness = createHarness();
  harness.holdCheck();
  harness.startup();
  const idlePromise = harness.awaitIdle();
  await new Promise((resolve) => queueMicrotask(resolve));
  assert.equal(harness.metrics().checkCalls, 1);
  harness.owner.dispose();
  await idlePromise;
});

test('whenIdle resolves after dispose cancels a held fetch', async () => {
  const harness = createHarness({ promptGateOpen: true });
  harness.holdFetch();
  harness.startup();
  while (harness.owner.getSnapshot().phase !== OTA_UPDATE_PHASES.DOWNLOADING) {
    await new Promise((resolve) => queueMicrotask(resolve));
  }
  const idlePromise = harness.awaitIdle();
  harness.owner.dispose();
  await idlePromise;
});

test('whenIdle after auto pipeline sets throttle before duplicate auto checks run', async () => {
  const harness = createHarness({
    deferCooldownMs: 60_000,
    checkThrottleMs: DEFAULT_CHECK_THROTTLE_MS,
    promptGateOpen: true,
  });
  harness.holdFetch();
  harness.startup();
  while (harness.owner.getSnapshot().phase !== OTA_UPDATE_PHASES.DOWNLOADING) {
    await new Promise((resolve) => queueMicrotask(resolve));
  }
  const idlePromise = harness.awaitIdle();
  harness.releaseFetch();
  await idlePromise;
  harness.owner.maybeAutoCheck();
  harness.owner.maybeAutoCheck();
  harness.owner.setAppActive(true);
  assert.equal(harness.metrics().checkCalls, 1);
});

test('manual and auto requests during download do not start a second network check', async () => {
  const harness = createHarness({ promptGateOpen: true });
  harness.holdFetch();
  harness.startup();
  while (harness.owner.getSnapshot().phase !== OTA_UPDATE_PHASES.DOWNLOADING) {
    await new Promise((resolve) => queueMicrotask(resolve));
  }
  assert.equal(harness.metrics().checkCalls, 1);
  assert.equal(harness.metrics().fetchCalls, 1);
  harness.owner.maybeAutoCheck();
  harness.owner.setAppActive(true);
  const manual = await harness.owner.requestManualCheck();
  assert.match(manual.manualStatus, /in progress/);
  assert.equal(harness.metrics().checkCalls, 1);
  assert.equal(harness.metrics().fetchCalls, 1);
  harness.releaseFetch();
  await harness.awaitIdle();
  assert.equal(harness.owner.getSnapshot().phase, OTA_UPDATE_PHASES.DOWNLOADED);
});

test('exported runCheck stays no-op while check pipeline download is in flight', async () => {
  const harness = createHarness({ promptGateOpen: true });
  harness.holdFetch();
  harness.startup();
  while (harness.owner.getSnapshot().phase !== OTA_UPDATE_PHASES.DOWNLOADING) {
    await new Promise((resolve) => queueMicrotask(resolve));
  }
  void harness.owner.runCheck(harness.owner.CHECK_SOURCES.MANUAL);
  await new Promise((resolve) => queueMicrotask(resolve));
  assert.equal(harness.metrics().checkCalls, 1);
  harness.releaseFetch();
  await harness.awaitIdle();
  assert.equal(harness.owner.getSnapshot().phase, OTA_UPDATE_PHASES.DOWNLOADED);
});

test('standalone runDownload is rejected while check pipeline download is in flight', async () => {
  const harness = createHarness({ promptGateOpen: true });
  harness.holdFetch();
  harness.startup();
  while (harness.owner.getSnapshot().phase !== OTA_UPDATE_PHASES.DOWNLOADING) {
    await new Promise((resolve) => queueMicrotask(resolve));
  }
  await harness.owner.runDownload();
  assert.equal(harness.metrics().fetchCalls, 1);
  harness.releaseFetch();
  await harness.awaitIdle();
  assert.equal(harness.owner.getSnapshot().phase, OTA_UPDATE_PHASES.DOWNLOADED);
});

test('stale download completion does not clear a newer in-flight check', async () => {
  const harness = createHarness({ promptGateOpen: true });
  harness.holdFetch();
  harness.startup();
  while (harness.owner.getSnapshot().phase !== OTA_UPDATE_PHASES.DOWNLOADING) {
    await new Promise((resolve) => queueMicrotask(resolve));
  }
  harness.owner.dispose();
  harness.owner.initialize();
  harness.owner.setAppActive(true);
  harness.owner.setPromptGateOpen(true);
  harness.owner.maybeAutoCheck();
  await new Promise((resolve) => queueMicrotask(resolve));
  assert.equal(harness.metrics().checkCalls, 2);
  assert.equal(harness.owner.getSnapshot().phase, OTA_UPDATE_PHASES.CHECKING);
  harness.releaseFetch();
  await harness.awaitIdle();
  assert.equal(harness.owner.getSnapshot().phase, OTA_UPDATE_PHASES.DOWNLOADED);
  assert.equal(harness.metrics().fetchCalls, 2);
});

test('dispose clears timers listeners and allows HMR-style reset', () => {
  const harness = createHarness();
  const listener = () => {};
  harness.owner.subscribe(listener);
  harness.startup();
  harness.owner.dispose();
  assert.equal(harness.runner.scheduledCount(), 0);
  harness.owner.subscribe(listener);
  harness.owner.initialize();
  assert.equal(harness.owner.getSnapshot().phase, OTA_UPDATE_PHASES.IDLE);
});
