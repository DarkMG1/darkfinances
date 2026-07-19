const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const { createOtaUpdatePersistence } = require('../src/lib/ota-update-persistence');
const { createOtaUpdateOwnerRunner } = require('../src/lib/ota-update-owner-runner');
const {
  DEFAULT_PROMPT_SETTLE_MS,
  OTA_UPDATE_PHASES,
} = require('../src/lib/ota-update-state');

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

function purgeOtaProfileStateLikeAutoUpdate({ persistence, owner, runner, nativePendingRef }) {
  persistence.clearDeferred();
  if (nativePendingRef) nativePendingRef.current = { pending: false, updateId: null };
  owner.dispose();
}

test('profile purge clears persisted Later cooldown and disposes OTA owner timers', async () => {
  const store = memoryStore();
  const persistence = createOtaUpdatePersistence(store);
  const runner = createOtaUpdateOwnerRunner({
    store,
    isSupported: () => true,
    now: () => NOW,
    deferCooldownMs: 60_000,
    promptGateOpen: true,
    checkForUpdate: async () => ({ isAvailable: true, manifest: { id: UPDATE_A } }),
    fetchUpdate: async () => ({ manifest: { id: UPDATE_A } }),
  });
  const { owner } = runner;
  const nativePendingRef = { current: { pending: false, updateId: null } };

  owner.initialize();
  owner.setPromptGateOpen(true);
  owner.maybeAutoCheck();
  await runner.whenIdle();
  runner.flushSchedules(DEFAULT_PROMPT_SETTLE_MS);
  runner.lastPrompt().onLater();

  assert.equal(owner.getSnapshot().phase, OTA_UPDATE_PHASES.DEFERRED);
  assert.ok(persistence.readDeferred(NOW + 1));

  purgeOtaProfileStateLikeAutoUpdate({ persistence, owner, runner, nativePendingRef });

  assert.equal(persistence.readDeferred(NOW + 1), null);
  assert.deepEqual(nativePendingRef.current, { pending: false, updateId: null });
  assert.equal(runner.scheduledCount(), 0);

  owner.initialize();
  owner.setPromptGateOpen(true);
  assert.equal(owner.getSnapshot().phase, OTA_UPDATE_PHASES.IDLE);
  assert.equal(owner.getSnapshot().deferredUntil, null);
});

test('profile purge wires OTA purge after notification generation suspension', () => {
  const purgeSource = fs.readFileSync(
    path.join(__dirname, '../src/lib/profile-purge.ts'),
    'utf8',
  );
  assert.match(purgeSource, /purgeOtaProfileState\(\)/);
  assert.ok(
    purgeSource.indexOf('purgeProfileGeneration(scope)')
      < purgeSource.indexOf('purgeOtaProfileState()'),
  );
  assert.ok(
    purgeSource.indexOf('purgeOtaProfileState()')
      < purgeSource.indexOf('purgeNotificationProfileState(scope)'),
  );
  assert.ok(
    purgeSource.indexOf('prepareFinanceOperationProfilePurge(operationScope)')
      < purgeSource.indexOf('purgeProfileGeneration(scope)'),
  );
});

test('root layout mounts notification reconciliation owner and OTA auto-update hook', () => {
  const layoutSource = fs.readFileSync(
    path.join(__dirname, '../src/app/_layout.tsx'),
    'utf8',
  );
  const settingsSource = fs.readFileSync(
    path.join(__dirname, '../src/app/(tabs)/settings.tsx'),
    'utf8',
  );
  assert.match(layoutSource, /NotificationReconciliationOwner/);
  assert.match(layoutSource, /useAutoUpdate\(canPromptForUpdate\)/);
  assert.doesNotMatch(settingsSource, /Updates\.checkForUpdateAsync/);
  assert.doesNotMatch(settingsSource, /Updates\.fetchUpdateAsync/);
  assert.match(settingsSource, /checkForUpdatesManual/);
  assert.match(settingsSource, /useOtaUpdateStatus/);
});
