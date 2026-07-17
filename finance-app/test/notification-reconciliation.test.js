const test = require('node:test');
const assert = require('node:assert/strict');
const {
  NOTIFICATION_RECONCILIATION_STALE_CODE,
  activateNotificationScope,
  assertReconciliationCurrent,
  beginReconciliation,
  bumpProfileGeneration,
  cancelReconciliation,
  cancelReconciliationLane,
  cancelAllReconciliationLanes,
  endReconciliation,
  getProfileGeneration,
  getReconciliationSessionId,
  isNotificationScopeSuspended,
  isReconciliationCurrent,
  purgeProfileGeneration,
  resetNotificationReconciliationState,
  withReconciliationGuard,
} = require('../src/lib/notification-reconciliation');

test.beforeEach(() => {
  resetNotificationReconciliationState();
});

test('purgeProfileGeneration suspends scope before generation bump', () => {
  const scope = 'server-a';
  const scheduled = beginReconciliation('scheduled', 0, scope);
  const nextGeneration = purgeProfileGeneration(scope);
  assert.equal(isNotificationScopeSuspended(scope), true);
  assert.equal(isReconciliationCurrent(scheduled), false);
  assert.equal(getProfileGeneration(), nextGeneration);
  assert.throws(
    () => beginReconciliation('scheduled', nextGeneration, scope),
    (error) => error.code === NOTIFICATION_RECONCILIATION_STALE_CODE,
  );
});

test('activateNotificationScope clears tombstone for same-scope reconnect only at current generation', () => {
  const scope = 'server-a';
  purgeProfileGeneration(scope);
  const generation = getProfileGeneration();
  activateNotificationScope(scope, generation - 1);
  assert.equal(isNotificationScopeSuspended(scope), true);
  activateNotificationScope(scope, generation);
  assert.equal(isNotificationScopeSuspended(scope), false);
  beginReconciliation('scheduled', generation, scope);
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
