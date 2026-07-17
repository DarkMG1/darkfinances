const test = require('node:test');
const assert = require('node:assert/strict');
const {
  NOTIFICATION_RECONCILIATION_STALE_CODE,
  activateNotificationScope,
  assertReconciliationCurrent,
  beginReconciliation,
  bindNotificationScopeSuspensionPersistence,
  bumpProfileGeneration,
  cancelReconciliation,
  cancelReconciliationLane,
  cancelAllReconciliationLanes,
  endReconciliation,
  getProfileGeneration,
  getReconciliationSessionId,
  isNotificationScopeSuspended,
  isReconciliationCurrent,
  NOTIFICATION_SCOPE_SUSPENSION_PERSISTENCE_REQUIRED,
  purgeProfileGeneration,
  readPersistedSuspensionGeneration,
  resetNotificationReconciliationState,
  simulateNotificationScopeSuspensionModuleReset,
  suspendNotificationScope,
  withReconciliationGuard,
} = require('../src/lib/notification-reconciliation');
const {
  SUSPENSION_KEY_PREFIX,
  hasPersistedSuspensionEvidence,
} = require('../src/lib/notification-scope-suspension');

function createSuspensionStore(options = {}) {
  const values = new Map();
  const baseSetString = (key, value) => {
    if (options.throwOnSuspensionWrite && key.startsWith(SUSPENSION_KEY_PREFIX) && value != null) {
      throw new Error('mmkv write failed');
    }
    if (value == null) values.delete(key);
    else values.set(key, value);
  };
  return {
    kv: {
      getString: (key) => (values.has(key) ? values.get(key) : null),
      setString: baseSetString,
    },
    storage: {
      getAllKeys: () => [...values.keys()],
      remove: (key) => values.delete(key),
    },
    values,
  };
}

test.beforeEach(() => {
  resetNotificationReconciliationState();
  bindNotificationScopeSuspensionPersistence(createSuspensionStore());
});

test('purgeProfileGeneration persists suspension before generation bump', () => {
  const store = createSuspensionStore();
  bindNotificationScopeSuspensionPersistence(store);
  const scope = 'server-a';
  const scheduled = beginReconciliation('scheduled', 0, scope);
  const priorGeneration = getProfileGeneration();
  const nextGeneration = purgeProfileGeneration(scope);
  assert.equal(store.kv.getString(`${SUSPENSION_KEY_PREFIX}${scope}`), String(priorGeneration));
  simulateNotificationScopeSuspensionModuleReset();
  assert.equal(isNotificationScopeSuspended(scope), true);
  assert.equal(isReconciliationCurrent(scheduled), false);
  assert.equal(getProfileGeneration(), nextGeneration);
  assert.throws(
    () => beginReconciliation('scheduled', nextGeneration, scope),
    (error) => error.code === NOTIFICATION_RECONCILIATION_STALE_CODE,
  );
});

test('activateNotificationScope clears persisted tombstone for same-scope reconnect only at current generation', () => {
  const store = createSuspensionStore();
  bindNotificationScopeSuspensionPersistence(store);
  const scope = 'server-a';
  purgeProfileGeneration(scope);
  const generation = getProfileGeneration();
  simulateNotificationScopeSuspensionModuleReset();
  assert.equal(readPersistedSuspensionGeneration(scope), 0);
  activateNotificationScope(scope, generation - 1);
  assert.equal(isNotificationScopeSuspended(scope), true);
  activateNotificationScope(scope, generation);
  assert.equal(isNotificationScopeSuspended(scope), false);
  assert.equal(readPersistedSuspensionGeneration(scope), null);
  beginReconciliation('scheduled', generation, scope);
});

test('suspendNotificationScope requires persistence binding', () => {
  resetNotificationReconciliationState();
  bindNotificationScopeSuspensionPersistence(null);
  assert.throws(
    () => suspendNotificationScope('server-a'),
    (error) => error.code === NOTIFICATION_SCOPE_SUSPENSION_PERSISTENCE_REQUIRED,
  );
  assert.equal(isNotificationScopeSuspended('server-a'), false);
});

test('suspendNotificationScope fails closed when persistence write throws', () => {
  const store = createSuspensionStore({ throwOnSuspensionWrite: true });
  bindNotificationScopeSuspensionPersistence(store);
  assert.throws(
    () => suspendNotificationScope('server-a'),
    (error) => error.message === 'mmkv write failed',
  );
  assert.equal(isNotificationScopeSuspended('server-a'), false);
  assert.equal(store.kv.getString(`${SUSPENSION_KEY_PREFIX}server-a`), null);
});

test('purgeProfileGeneration does not bump generation when suspension persistence fails', () => {
  const store = createSuspensionStore({ throwOnSuspensionWrite: true });
  bindNotificationScopeSuspensionPersistence(store);
  beginReconciliation('scheduled', 0, 'server-a');
  assert.throws(
    () => purgeProfileGeneration('server-a'),
    (error) => error.message === 'mmkv write failed',
  );
  assert.equal(getProfileGeneration(), 0);
  assert.equal(isNotificationScopeSuspended('server-a'), false);
});

test('malformed persisted tombstone keeps scope suspended until explicit activation', () => {
  const store = createSuspensionStore();
  bindNotificationScopeSuspensionPersistence(store);
  store.kv.setString(`${SUSPENSION_KEY_PREFIX}server-a`, 'not-a-number');
  simulateNotificationScopeSuspensionModuleReset();

  assert.equal(readPersistedSuspensionGeneration('server-a'), null);
  assert.equal(hasPersistedSuspensionEvidence('server-a'), true);
  assert.equal(isNotificationScopeSuspended('server-a'), true);
  assert.throws(
    () => beginReconciliation('scheduled', 0, 'server-a'),
    (error) => error.code === NOTIFICATION_RECONCILIATION_STALE_CODE,
  );

  activateNotificationScope('server-a', getProfileGeneration());
  assert.equal(isNotificationScopeSuspended('server-a'), false);
  beginReconciliation('scheduled', 0, 'server-a');
});

test('profile generation bumps invalidate prior reconciliation tokens in both lanes', () => {
  const scheduled = beginReconciliation('scheduled', 0);
  const event = beginReconciliation('event', 0);
  bumpProfileGeneration();
  assert.equal(isReconciliationCurrent(scheduled), false);
  assert.equal(isReconciliationCurrent(event), false);
});

test('scheduled and event lanes run concurrently without cancelling each other', () => {
  const scheduled = beginReconciliation('scheduled', 0);
  const event = beginReconciliation('event', 0);
  assert.equal(isReconciliationCurrent(scheduled), true);
  assert.equal(isReconciliationCurrent(event), true);
  assert.equal(scheduled.sessionId, 1);
  assert.equal(event.sessionId, 1);
});

test('lane cleanup cancels only its own token', () => {
  const scheduled = beginReconciliation('scheduled', 0);
  const event = beginReconciliation('event', 0);
  cancelReconciliation(scheduled);
  assert.equal(isReconciliationCurrent(scheduled), false);
  assert.equal(isReconciliationCurrent(event), true);
});

test('cancel then begin within a lane invalidates only that lane prior session', () => {
  const first = beginReconciliation('scheduled', 0);
  cancelReconciliationLane('scheduled');
  const second = beginReconciliation('scheduled', 0);
  assert.equal(isReconciliationCurrent(first), false);
  assert.equal(isReconciliationCurrent(second), true);
  assert.equal(second.sessionId, 2);
});

test('endReconciliation with a stale scheduled token does not clear the active event session', () => {
  const scheduled = beginReconciliation('scheduled', 0);
  const event = beginReconciliation('event', 0);
  const replacement = beginReconciliation('scheduled', 0);
  endReconciliation(scheduled);
  assert.equal(isReconciliationCurrent(event), true);
  assert.equal(isReconciliationCurrent(replacement), true);
});

test('stale scheduled finally cannot end the active event session', async () => {
  const scheduled = beginReconciliation('scheduled', 0);
  const event = beginReconciliation('event', 0);
  beginReconciliation('scheduled', 0);
  await Promise.resolve();
  endReconciliation(scheduled);
  assert.equal(isReconciliationCurrent(event), true);
});

test('purgeProfileGeneration cancels all lanes and bumps generation', () => {
  const scheduled = beginReconciliation('scheduled', 0);
  const event = beginReconciliation('event', 0);
  const nextGeneration = purgeProfileGeneration();
  assert.equal(isReconciliationCurrent(scheduled), false);
  assert.equal(isReconciliationCurrent(event), false);
  assert.equal(getProfileGeneration(), nextGeneration);
});

test('withReconciliationGuard rejects stale work after async boundaries', async () => {
  const token = beginReconciliation('event', 0);
  await assert.rejects(
    () => withReconciliationGuard(token, async () => {
      bumpProfileGeneration();
    }),
    (error) => error.code === NOTIFICATION_RECONCILIATION_STALE_CODE,
  );
});

test('mid-await lane cancellation rejects guarded work for that lane only', async () => {
  const scheduled = beginReconciliation('scheduled', 0);
  const event = beginReconciliation('event', 0);
  const pending = withReconciliationGuard(scheduled, async () => {
    cancelReconciliation(scheduled);
    await Promise.resolve();
  });
  await assert.rejects(
    pending,
    (error) => error.code === NOTIFICATION_RECONCILIATION_STALE_CODE,
  );
  assert.equal(isReconciliationCurrent(event), true);
  cancelAllReconciliationLanes();
});

test('lane session ids are independent counters', () => {
  beginReconciliation('scheduled', 0);
  beginReconciliation('scheduled', 0);
  beginReconciliation('event', 0);
  assert.equal(getReconciliationSessionId('scheduled'), 2);
  assert.equal(getReconciliationSessionId('event'), 1);
});
