const test = require('node:test');
const assert = require('node:assert/strict');
const { classifyBillReminder, billSameDayKey } = require('../src/lib/notification-scheduling');
const { createNotificationReconciler, parseNotificationRoute } = require('../src/lib/notification-reconcile');
const {
  activateNotificationScope,
  beginReconciliation,
  bindNotificationScopeSuspensionPersistence,
  bumpProfileGeneration,
  cancelReconciliation,
  getProfileGeneration,
  isNotificationScopeSuspended,
  isReconciliationCurrent,
  purgeProfileGeneration,
  NOTIFICATION_SCOPE_SUSPENSION_PERSISTENCE_REQUIRED,
  readPersistedSuspensionGeneration,
  resetNotificationReconciliationState,
  simulateNotificationScopeSuspensionModuleReset,
  withReconciliationGuard,
  assertReconciliationCurrent,
} = require('../src/lib/notification-reconciliation');
const { SUSPENSION_KEY_PREFIX } = require('../src/lib/notification-scope-suspension');
const { createNotificationReconciliationOwnerRunner } = require('../src/lib/notification-reconciliation-owner');
const {
  createRedactedNotificationReconciliationError,
  reportUnexpectedReconciliationError,
} = require('../src/lib/notification-reconciliation-errors');

function bill(dueDate, overrides = {}) {
  return {
    key: 'rent',
    payee: 'landlord',
    amount: 1200,
    category: 'Housing',
    dueDate,
    paid: false,
    ...overrides,
  };
}

function deferred() {
  let resolve;
  const promise = new Promise((res) => {
    resolve = res;
  });
  return { promise, resolve };
}

function createStorage() {
  const values = new Map();
  return {
    kv: {
      getString: (key) => (values.has(key) ? values.get(key) : null),
      setString: (key, value) => {
        if (value == null) values.delete(key);
        else values.set(key, value);
      },
      getBool: (key, fallback = false) => {
        if (!values.has(key)) return fallback;
        return values.get(key) === 'true';
      },
      setBool: (key, value) => values.set(key, value ? 'true' : 'false'),
    },
    storage: {
      getAllKeys: () => [...values.keys()],
      remove: (key) => values.delete(key),
    },
    values,
  };
}

function createNotificationsApi() {
  const scheduled = [];
  const cancelled = [];
  const presented = [];
  let lastResponse = null;
  let permissionDelay = null;
  let scheduleDelay = null;
  let permissionGranted = true;
  let rejectImmediatePresent = false;
  let nextScheduleId = 0;
  const cancelRejectIds = new Set();
  const cancelApplyThenThrowIds = new Set();
  let enumFails = false;
  let omitEnumeration = false;

  const api = {
    scheduled,
    cancelled,
    presented,
    get lastResponse() {
      return lastResponse;
    },
    setPermissionGranted(value) {
      permissionGranted = value;
    },
    setPermissionDelay(delay) {
      permissionDelay = delay;
    },
    setScheduleDelay(delay) {
      scheduleDelay = delay;
    },
    setRejectImmediatePresent(value) {
      rejectImmediatePresent = value;
    },
    rejectCancelFor(id) {
      cancelRejectIds.add(id);
    },
    clearCancelFaults() {
      cancelRejectIds.clear();
      cancelApplyThenThrowIds.clear();
      enumFails = false;
      omitEnumeration = false;
    },
    applyThenThrowCancelFor(id) {
      cancelApplyThenThrowIds.add(id);
    },
    setEnumFails(value) {
      enumFails = value;
    },
    setOmitEnumeration(value) {
      omitEnumeration = value;
    },
    SchedulableTriggerInputTypes: { DATE: 'date', WEEKLY: 'weekly' },
    async getPermissionsAsync() {
      if (permissionDelay) await permissionDelay.promise;
      return { granted: permissionGranted };
    },
    async cancelScheduledNotificationAsync(id) {
      if (cancelRejectIds.has(id)) {
        throw new Error(`cancel rejected: ${id}`);
      }
      if (cancelApplyThenThrowIds.has(id)) {
        cancelled.push(id);
        const index = scheduled.findIndex((entry) => entry.id === id);
        if (index >= 0) scheduled.splice(index, 1);
        throw new Error(`cancel threw after apply: ${id}`);
      }
      cancelled.push(id);
      const index = scheduled.findIndex((entry) => entry.id === id);
      if (index >= 0) scheduled.splice(index, 1);
    },
    async scheduleNotificationAsync(request) {
      if (scheduleDelay) await scheduleDelay.promise;
      if (request.trigger == null && rejectImmediatePresent) {
        throw new Error('present failed');
      }
      nextScheduleId += 1;
      const id = `scheduled-${nextScheduleId}`;
      scheduled.push({ id, request });
      return id;
    },
    async getAllScheduledNotificationsAsync() {
      if (omitEnumeration) {
        throw new Error('enumeration unavailable');
      }
      if (enumFails) {
        throw new Error('enumeration failed');
      }
      return scheduled.map((entry) => ({
        identifier: entry.id,
        content: entry.request.content,
      }));
    },
    async getPresentedNotificationsAsync() {
      return presented;
    },
    async dismissNotificationAsync(id) {
      const index = presented.findIndex((item) => item.request.identifier === id);
      if (index >= 0) presented.splice(index, 1);
    },
    clearLastNotificationResponse() {
      lastResponse = null;
    },
    getLastNotificationResponseAsync: async () => lastResponse,
    setLastNotificationResponse(response) {
      lastResponse = response;
    },
  };

  return api;
}

function baseSettings(overrides = {}) {
  return {
    bills: false,
    largeCharge: false,
    newSub: false,
    weekly: false,
    lowBalance: false,
    repayments: false,
    threshold: 200,
    lowBalanceThreshold: 100,
    privacy: 'private',
    ...overrides,
  };
}

function createReconciler(store, notificationsApi, options = {}) {
  return createNotificationReconciler({
    notifications: notificationsApi,
    kv: store.kv,
    storage: store.storage,
    assertReconciliationCurrent,
    withReconciliationGuard,
    classifyBillReminder,
    buildBillNotificationContent: (b, kind) => ({
      title: kind === 'overdue' ? 'Bill overdue' : 'Bill due today',
      body: b.payee,
    }),
    buildLargeChargeNotificationContent: () => ({
      title: 'Large charge detected',
      body: 'review',
    }),
    buildLowBalanceNotificationContent: () => ({
      title: 'Low balance',
      body: 'review',
    }),
    buildRepaymentNotificationContent: () => ({
      title: 'Repayment to review',
      body: 'review',
    }),
    buildSubscriptionNotificationContent: () => ({
      title: 'New subscription detected',
      body: 'review',
    }),
    isCashAccount: (account) => account.role === 'operating_cash',
    onStageEvent: options.onStageEvent,
  });
}

function osLiveIdsFromApi(notificationsApi) {
  const cancelled = new Set(notificationsApi.cancelled);
  return notificationsApi.scheduled
    .filter((entry) => !cancelled.has(entry.id))
    .map((entry) => entry.id);
}

function assertOsMatchesKvTrackedLive(reconciler, scope, category, notificationsApi) {
  const { osLiveIds } = require('../src/lib/notification-scheduled-stage');
  const kvLive = osLiveIds(reconciler.readCategoryScheduleState(scope, category));
  assert.deepEqual([...kvLive].sort(), [...osLiveIdsFromApi(notificationsApi)].sort());
}

function assertKvEvidenceCoversOsLive(reconciler, scope, category, notificationsApi) {
  const { osLiveIds } = require('../src/lib/notification-scheduled-stage');
  const kvLive = new Set(osLiveIds(reconciler.readCategoryScheduleState(scope, category)));
  for (const id of osLiveIdsFromApi(notificationsApi)) {
    assert.ok(kvLive.has(id), `KV must track possibly-live OS id ${id}`);
  }
}

let suspensionStore = createStorage();

test.beforeEach(() => {
  resetNotificationReconciliationState();
  suspensionStore = createStorage();
  bindNotificationScopeSuspensionPersistence(suspensionStore);
});

test('classifyBillReminder scopes same-day dedupe keys by profile', () => {
  const now = Date.parse('2026-07-16T12:00:00');
  assert.equal(
    classifyBillReminder(bill('2026-07-16'), now, 'server-a').sameDayKey,
    billSameDayKey('server-a', 'rent', '2026-07-16'),
  );
  assert.notEqual(
    classifyBillReminder(bill('2026-07-16'), now, 'server-a').sameDayKey,
    classifyBillReminder(bill('2026-07-16'), now, 'server-b').sameDayKey,
  );
});

test('owner runner keeps scheduled and event lanes alive in one commit', async () => {
  const store = createStorage();
  const notificationsApi = createNotificationsApi();
  const reconciler = createReconciler(store, notificationsApi);
  const scheduledDelay = deferred();
  notificationsApi.setScheduleDelay(scheduledDelay);

  const runner = createNotificationReconciliationOwnerRunner({
    generation: 0,
    reconcileScheduled: (input) => reconciler.reconcileScheduledNotifications(input),
    reconcileEvent: (input) => reconciler.reconcileEventNotifications(input),
  });

  const { scheduled, event } = runner.startBothInOneCommit(
    {
      scope: 'server-a',
      settings: baseSettings({ weekly: true }),
      billsReady: false,
    },
    {
      scope: 'server-a',
      settings: baseSettings({ largeCharge: true }),
      transactions: [{ id: 'txn-1', amount: -500, payee: 'Store' }],
    },
  );

  assert.equal(isReconciliationCurrent(scheduled.token), true);
  assert.equal(isReconciliationCurrent(event.token), true);

  scheduledDelay.resolve(undefined);
  await Promise.all([scheduled.run, event.run]);

  assert.ok(notificationsApi.scheduled.some((entry) => entry.request.content.data.category === 'weekly'));
  assert.ok(store.kv.getString('notif.lastSeenTxnIds.v3.server-a'));
});

test('scheduled cleanup does not cancel an in-flight event lane', async () => {
  const store = createStorage();
  const notificationsApi = createNotificationsApi();
  const reconciler = createReconciler(store, notificationsApi);
  const eventDelay = deferred();
  notificationsApi.setScheduleDelay(eventDelay);
  store.kv.setString('notif.lastSeenTxnIds.v3.server-a', JSON.stringify(['txn-old']));

  const runner = createNotificationReconciliationOwnerRunner({
    generation: 0,
    reconcileScheduled: (input) => reconciler.reconcileScheduledNotifications(input),
    reconcileEvent: (input) => reconciler.reconcileEventNotifications(input),
  });

  const scheduled = runner.startScheduled({
    scope: 'server-a',
    settings: baseSettings({ weekly: true }),
    billsReady: false,
  });
  const event = runner.startEvent({
    scope: 'server-a',
    settings: baseSettings({ largeCharge: true }),
    transactions: [{ id: 'txn-1', amount: -500, payee: 'Store' }],
  });

  runner.cleanupScheduled();
  await scheduled.run.catch(() => {});

  assert.equal(isReconciliationCurrent(event.token), true);
  eventDelay.resolve(undefined);
  await event.run;
});

test('bills query completion reschedules without cancelling event lane', async () => {
  const store = createStorage();
  const notificationsApi = createNotificationsApi();
  const reconciler = createReconciler(store, notificationsApi);

  const runner = createNotificationReconciliationOwnerRunner({
    generation: 0,
    reconcileScheduled: (input) => reconciler.reconcileScheduledNotifications(input),
    reconcileEvent: (input) => reconciler.reconcileEventNotifications(input),
  });

  const event = runner.startEvent({
    scope: 'server-a',
    settings: baseSettings({ largeCharge: true }),
    transactions: [{ id: 'txn-1', amount: -500, payee: 'Store' }],
  });
  const scheduled = runner.startScheduled({
    scope: 'server-a',
    settings: baseSettings({ bills: true }),
    bills: [bill('2026-07-20')],
    billsReady: true,
  });

  await Promise.all([scheduled.run, event.run]);
  assert.equal(isReconciliationCurrent(event.token), false);
  assert.ok(notificationsApi.scheduled.some((entry) => entry.request.content.data.category === 'bills'));
});

test('weekly-only scheduled run does not require bills data', async () => {
  const store = createStorage();
  const notificationsApi = createNotificationsApi();
  const reconciler = createReconciler(store, notificationsApi);
  const token = beginReconciliation('scheduled', 0, 'server-a');

  await reconciler.reconcileScheduledNotifications({
    token,
    scope: 'server-a',
    settings: baseSettings({ weekly: true }),
    billsReady: false,
  });

  assert.equal(notificationsApi.scheduled.length, 1);
  assert.equal(notificationsApi.scheduled[0].request.content.data.category, 'weekly');
});

test('loading bills preserves existing tracked bill schedules', async () => {
  const store = createStorage();
  const notificationsApi = createNotificationsApi();
  const reconciler = createReconciler(store, notificationsApi);
  store.kv.setString(
    'notif.scheduledIds.v1.server-a',
    JSON.stringify({ bills: ['tracked-bill-1'] }),
  );

  const token = beginReconciliation('scheduled', 0, 'server-a');
  await reconciler.reconcileScheduledNotifications({
    token,
    scope: 'server-a',
    settings: baseSettings({ bills: true }),
    billsReady: false,
  });

  assert.deepEqual(notificationsApi.cancelled, []);
});

test('purge one profile does not clear another profile billSameDay dedupe', async () => {
  const store = createStorage();
  const notificationsApi = createNotificationsApi();
  const reconciler = createReconciler(store, notificationsApi);

  store.kv.setBool(billSameDayKey('server-a', 'rent', '2026-07-16'), true);
  store.kv.setBool(billSameDayKey('server-b', 'rent', '2026-07-16'), true);
  store.kv.setBool('notif.billSameDay.rent-2026-07-16', true);

  await reconciler.purgeNotificationProfileState('server-a');

  assert.equal(store.kv.getBool(billSameDayKey('server-a', 'rent', '2026-07-16'), false), false);
  assert.equal(store.kv.getBool(billSameDayKey('server-b', 'rent', '2026-07-16'), false), true);
  assert.equal(store.kv.getBool('notif.billSameDay.rent-2026-07-16', false), true);
});

test('legacy unscoped billSameDay keys are cleaned during scheduled reconcile', async () => {
  const store = createStorage();
  const notificationsApi = createNotificationsApi();
  const reconciler = createReconciler(store, notificationsApi);
  store.kv.setBool('notif.billSameDay.rent-2026-07-16', true);

  const token = beginReconciliation('scheduled', 0, 'server-a');
  await reconciler.reconcileScheduledNotifications({
    token,
    scope: 'server-a',
    settings: baseSettings(),
    billsReady: false,
  });

  assert.equal(store.kv.getString('notif.billSameDay.rent-2026-07-16'), null);
});

test('unexpected reconcile errors are redacted while stale cancellation is ignored', () => {
  const recorded = [];
  const redacted = createRedactedNotificationReconciliationError(Object.assign(new Error('secret txn'), {
    code: 'NOTIFICATION_RECONCILE_FAILED',
    status: 503,
    token: 'secret',
  }));
  assert.equal(redacted.code, 'NOTIFICATION_RECONCILE_FAILED');
  assert.equal(JSON.stringify(redacted).includes('secret'), false);

  reportUnexpectedReconciliationError(
    Object.assign(new Error('stale'), { code: 'NOTIFICATION_RECONCILIATION_STALE' }),
    (value) => recorded.push(value),
  );
  assert.equal(recorded.length, 0);

  reportUnexpectedReconciliationError(
    Object.assign(new Error('boom'), { code: 'NOTIFICATION_RECONCILE_FAILED', status: 500 }),
    (value) => recorded.push(value),
  );
  assert.equal(recorded.length, 1);
  assert.equal(recorded[0].code, 'NOTIFICATION_RECONCILE_FAILED');
});

test('profile purge via owner runner cancels both lanes', async () => {
  const store = createStorage();
  const notificationsApi = createNotificationsApi();
  const reconciler = createReconciler(store, notificationsApi);
  const runner = createNotificationReconciliationOwnerRunner({
    generation: 0,
    reconcileScheduled: (input) => reconciler.reconcileScheduledNotifications(input),
    reconcileEvent: (input) => reconciler.reconcileEventNotifications(input),
  });

  const { scheduled, event } = runner.startBothInOneCommit(
    {
      scope: 'server-a',
      settings: baseSettings({ weekly: true }),
      billsReady: false,
    },
    {
      scope: 'server-a',
      settings: baseSettings({ largeCharge: true }),
      transactions: [{ id: 'txn-1', amount: -500, payee: 'Store' }],
    },
  );

  runner.purgeProfile('server-a');
  await Promise.allSettled([scheduled.run, event.run]);
  if (scheduled.token) assert.equal(isReconciliationCurrent(scheduled.token), false);
  if (event.token) assert.equal(isReconciliationCurrent(event.token), false);
});

test('event reconciliation does not cancel tracked bill schedules', async () => {
  const store = createStorage();
  const notificationsApi = createNotificationsApi();
  const reconciler = createReconciler(store, notificationsApi);
  store.kv.setString(
    'notif.scheduledIds.v1.server-a',
    JSON.stringify({ bills: ['tracked-bill-1'], weekly: ['tracked-weekly-1'] }),
  );

  const token = beginReconciliation('event', 0, 'server-a');
  await reconciler.reconcileEventNotifications({
    token,
    scope: 'server-a',
    settings: baseSettings({ largeCharge: true }),
    transactions: [{ id: 'txn-1', amount: -500, payee: 'Store' }],
  });

  assert.deepEqual(notificationsApi.cancelled, []);
});

test('parseNotificationRoute rejects non-finance payloads for router isolation', () => {
  assert.deepEqual(parseNotificationRoute({
    route: '/bills',
    category: 'bills',
    scope: 'server-a',
  }), {
    route: '/bills',
    category: 'bills',
    scope: 'server-a',
  });
  assert.equal(parseNotificationRoute({
    route: '/calendar',
    category: 'calendar',
    scope: 'server-a',
  }), null);
});

test('partial bill scheduling rolls back newly scheduled IDs on lane cancellation', async () => {
  const store = createStorage();
  const notificationsApi = createNotificationsApi();
  const originalSchedule = notificationsApi.scheduleNotificationAsync.bind(notificationsApi);
  let scheduleCount = 0;

  const token = beginReconciliation('scheduled', 0, 'server-a');
  notificationsApi.scheduleNotificationAsync = async (request) => {
    scheduleCount += 1;
    const id = await originalSchedule(request);
    if (scheduleCount === 1) cancelReconciliation(token);
    return id;
  };

  const reconciler = createReconciler(store, notificationsApi);
  store.kv.setString(
    'notif.scheduledIds.v1.server-a',
    JSON.stringify({ bills: ['tracked-bill-1'] }),
  );

  await assert.rejects(
    reconciler.reconcileScheduledNotifications({
      token,
      scope: 'server-a',
      settings: baseSettings({ bills: true }),
      bills: [bill('2026-07-20'), bill('2026-07-21')],
      billsReady: true,
    }),
    (error) => error.code === 'NOTIFICATION_RECONCILIATION_STALE',
  );

  assert.equal(notificationsApi.cancelled.filter((id) => id.startsWith('scheduled-')).length, 1);
  assert.deepEqual(JSON.parse(store.kv.getString('notif.scheduledIds.v1.server-a')), { bills: ['tracked-bill-1'] });
});

test('permission denied skips scheduling but still disables categories and refreshes status', async () => {
  const store = createStorage();
  const notificationsApi = createNotificationsApi();
  notificationsApi.setPermissionGranted(false);
  notificationsApi.scheduled.push(
    { id: 'tracked-weekly', request: { content: { data: { route: '/review', category: 'weekly', scope: 'server-a' } }, trigger: {} } },
    { id: 'tracked-bill', request: { content: { data: { route: '/bills', category: 'bills', scope: 'server-a' } }, trigger: {} } },
    {
      id: 'legacy-finance-1',
      request: {
        content: {
          data: { route: '/bills', category: 'bills', scope: 'server-a' },
        },
      },
    },
  );
  store.kv.setString(
    'notif.scheduledIds.v1.server-a',
    JSON.stringify({ weekly: ['tracked-weekly'], bills: ['tracked-bill'] }),
  );
  const reconciler = createReconciler(store, notificationsApi);
  const token = beginReconciliation('scheduled', 0, 'server-a');

  await reconciler.reconcileScheduledNotifications({
    token,
    scope: 'server-a',
    settings: baseSettings({ weekly: false, bills: false }),
    billsReady: false,
  });

  assert.equal(notificationsApi.scheduled.length, 0);
  assert.deepEqual(
    [...new Set(notificationsApi.cancelled)].sort(),
    ['legacy-finance-1', 'tracked-bill', 'tracked-weekly'].sort(),
  );
  assert.deepEqual(JSON.parse(store.kv.getString('notif.scheduledIds.v1.server-a')), {});
  assert.equal(store.kv.getBool('notif.legacyScheduleMigration.v1', false), true);
  const status = JSON.parse(store.kv.getString('notif.status.v2.server-a'));
  assert.equal(status.permissionGranted, false);
  assert.equal(status.scheduledCount, 0);
});

test('permission denied never schedules enabled categories', async () => {
  const store = createStorage();
  const notificationsApi = createNotificationsApi();
  notificationsApi.setPermissionGranted(false);
  const reconciler = createReconciler(store, notificationsApi);
  const token = beginReconciliation('scheduled', 0, 'server-a');

  await reconciler.reconcileScheduledNotifications({
    token,
    scope: 'server-a',
    settings: baseSettings({ weekly: true, bills: true }),
    bills: [bill('2026-07-20')],
    billsReady: true,
  });

  assert.equal(notificationsApi.scheduled.length, 0);
  assert.deepEqual(notificationsApi.cancelled, []);
  const status = JSON.parse(store.kv.getString('notif.status.v2.server-a'));
  assert.equal(status.permissionGranted, false);
  assert.equal(status.scheduledCount, 0);
  assert.equal(status.lastRefresh?.weekly, undefined);
});

test('permission denied disable retains cleanup evidence when cancel is unconfirmed', async () => {
  const store = createStorage();
  const notificationsApi = createNotificationsApi();
  notificationsApi.setPermissionGranted(false);
  notificationsApi.scheduled.push({ id: 'tracked-weekly', request: { trigger: {} } });
  notificationsApi.rejectCancelFor('tracked-weekly');
  store.kv.setString(
    'notif.scheduledIds.v1.server-a',
    JSON.stringify({ weekly: ['tracked-weekly'] }),
  );
  const reconciler = createReconciler(store, notificationsApi);
  const token = beginReconciliation('scheduled', 0, 'server-a');

  await reconciler.reconcileScheduledNotifications({
    token,
    scope: 'server-a',
    settings: baseSettings({ weekly: false }),
    billsReady: false,
  });

  const state = reconciler.readCategoryScheduleState('server-a', 'weekly');
  assert.deepEqual(state.cleanup, ['tracked-weekly']);
  assert.deepEqual(state.canonical, []);
  const status = JSON.parse(store.kv.getString('notif.status.v2.server-a'));
  assert.equal(status.permissionGranted, false);
});

test('legacy finance-owned OS schedules migrate under denied permission', async () => {
  const store = createStorage();
  const notificationsApi = createNotificationsApi();
  notificationsApi.setPermissionGranted(false);
  notificationsApi.scheduled.push({
    id: 'legacy-finance-1',
    request: {
      content: {
        data: { route: '/review', category: 'weekly', scope: 'server-a' },
      },
    },
  });
  const reconciler = createReconciler(store, notificationsApi);
  const token = beginReconciliation('scheduled', 0, 'server-a');

  assert.equal(await reconciler.migrateLegacyScheduledNotifications(token), true);
  assert.deepEqual(notificationsApi.cancelled, ['legacy-finance-1']);
  assert.equal(store.kv.getBool('notif.legacyScheduleMigration.v1', false), true);
});

test('legacy migration defers marker when cancel fails under denied permission', async () => {
  const store = createStorage();
  const notificationsApi = createNotificationsApi();
  notificationsApi.setPermissionGranted(false);
  notificationsApi.scheduled.push({
    id: 'legacy-finance-1',
    request: {
      content: {
        data: { route: '/review', category: 'weekly', scope: 'server-a' },
      },
    },
  });
  notificationsApi.rejectCancelFor('legacy-finance-1');
  const reconciler = createReconciler(store, notificationsApi);
  const token = beginReconciliation('scheduled', 0, 'server-a');

  assert.equal(await reconciler.migrateLegacyScheduledNotifications(token), false);
  assert.equal(store.kv.getBool('notif.legacyScheduleMigration.v1', false), false);

  notificationsApi.clearCancelFaults();
  assert.equal(await reconciler.migrateLegacyScheduledNotifications(token), true);
  assert.deepEqual(notificationsApi.cancelled, ['legacy-finance-1']);
  assert.equal(store.kv.getBool('notif.legacyScheduleMigration.v1', false), true);
});

test('scheduled reconcile skips scheduling when legacy enumeration fails then succeeds without duplicates', async () => {
  const store = createStorage();
  const notificationsApi = createNotificationsApi();
  notificationsApi.scheduled.push({
    id: 'legacy-finance-1',
    request: {
      content: {
        data: { route: '/review', category: 'weekly', scope: 'server-a' },
      },
    },
  });
  notificationsApi.setEnumFails(true);
  const reconciler = createReconciler(store, notificationsApi);
  const token = beginReconciliation('scheduled', 0, 'server-a');

  await reconciler.reconcileScheduledNotifications({
    token,
    scope: 'server-a',
    settings: baseSettings({ weekly: true }),
    billsReady: false,
  });

  assert.equal(notificationsApi.scheduled.some((entry) => entry.id.startsWith('scheduled-')), false);
  assert.equal(store.kv.getBool('notif.legacyScheduleMigration.v1', false), false);
  assert.equal(notificationsApi.scheduled.some((entry) => entry.id === 'legacy-finance-1'), true);

  notificationsApi.setEnumFails(false);
  const retryToken = beginReconciliation('scheduled', 0, 'server-a');
  await reconciler.reconcileScheduledNotifications({
    token: retryToken,
    scope: 'server-a',
    settings: baseSettings({ weekly: true }),
    billsReady: false,
  });

  assert.equal(store.kv.getBool('notif.legacyScheduleMigration.v1', false), true);
  assert.deepEqual(notificationsApi.cancelled, ['legacy-finance-1']);
  assert.equal(notificationsApi.scheduled.filter((entry) => entry.id.startsWith('scheduled-')).length, 1);
  assert.equal(notificationsApi.scheduled.length, 1);
});

test('scheduled reconcile skips scheduling when legacy cancel fails then succeeds without duplicates', async () => {
  const store = createStorage();
  const notificationsApi = createNotificationsApi();
  notificationsApi.scheduled.push({
    id: 'legacy-finance-1',
    request: {
      content: {
        data: { route: '/review', category: 'weekly', scope: 'server-a' },
      },
    },
  });
  notificationsApi.rejectCancelFor('legacy-finance-1');
  const reconciler = createReconciler(store, notificationsApi);
  const token = beginReconciliation('scheduled', 0, 'server-a');

  await reconciler.reconcileScheduledNotifications({
    token,
    scope: 'server-a',
    settings: baseSettings({ weekly: true }),
    billsReady: false,
  });

  assert.equal(notificationsApi.scheduled.some((entry) => entry.id.startsWith('scheduled-')), false);
  assert.equal(store.kv.getBool('notif.legacyScheduleMigration.v1', false), false);
  assert.equal(notificationsApi.scheduled.some((entry) => entry.id === 'legacy-finance-1'), true);

  notificationsApi.clearCancelFaults();
  const retryToken = beginReconciliation('scheduled', 0, 'server-a');
  await reconciler.reconcileScheduledNotifications({
    token: retryToken,
    scope: 'server-a',
    settings: baseSettings({ weekly: true }),
    billsReady: false,
  });

  assert.equal(store.kv.getBool('notif.legacyScheduleMigration.v1', false), true);
  assert.deepEqual(notificationsApi.cancelled, ['legacy-finance-1']);
  assert.equal(notificationsApi.scheduled.filter((entry) => entry.id.startsWith('scheduled-')).length, 1);
  assert.equal(notificationsApi.scheduled.length, 1);
});

test('legacy finance-owned OS schedules migrate once then stay idempotent', async () => {
  const store = createStorage();
  const notificationsApi = createNotificationsApi();
  notificationsApi.scheduled.push(
    {
      id: 'legacy-finance-1',
      request: {
        content: {
          data: { route: '/bills', category: 'bills', scope: 'server-a' },
        },
      },
    },
    {
      id: 'other-app-1',
      request: {
        content: {
          data: { route: '/calendar', category: 'calendar', scope: 'server-a' },
        },
      },
    },
  );
  const reconciler = createReconciler(store, notificationsApi);
  const token = beginReconciliation('scheduled', 0, 'server-a');

  assert.equal(await reconciler.migrateLegacyScheduledNotifications(token), true);
  assert.deepEqual(notificationsApi.cancelled, ['legacy-finance-1']);
  assert.equal(store.kv.getBool('notif.legacyScheduleMigration.v1', false), true);

  notificationsApi.cancelled.length = 0;
  notificationsApi.scheduled.push({
    id: 'legacy-finance-2',
    request: {
      content: {
        data: { route: '/review', category: 'weekly', scope: 'server-b' },
      },
    },
  });

  assert.equal(await reconciler.migrateLegacyScheduledNotifications(token), true);
  assert.deepEqual(notificationsApi.cancelled, []);
  assert.equal(store.kv.getBool('notif.legacyScheduleMigration.v1', false), true);
});

test('scheduled reconcile writes scoped notification status round-trip', async () => {
  const store = createStorage();
  const notificationsApi = createNotificationsApi();
  const reconciler = createReconciler(store, notificationsApi);
  const token = beginReconciliation('scheduled', 0, 'server-a');

  await reconciler.reconcileScheduledNotifications({
    token,
    scope: 'server-a',
    settings: baseSettings({ weekly: true }),
    billsReady: false,
  });

  const raw = store.kv.getString('notif.status.v2.server-a');
  assert.ok(raw);
  const status = JSON.parse(raw);
  assert.equal(status.permissionGranted, true);
  assert.equal(status.scheduledCount, 1);
  assert.ok(status.lastRefresh.weekly);
  assert.equal(reconciler.readNotificationStatus('server-a').scheduledCount, 1);
});

test('notification status stays isolated per profile scope', async () => {
  const store = createStorage();
  const notificationsApi = createNotificationsApi();
  const reconciler = createReconciler(store, notificationsApi);

  const tokenA = beginReconciliation('scheduled', 0, 'server-a');
  await reconciler.reconcileScheduledNotifications({
    token: tokenA,
    scope: 'server-a',
    settings: baseSettings({ weekly: true }),
    billsReady: false,
  });

  const tokenB = beginReconciliation('scheduled', 0, 'server-b');
  await reconciler.reconcileScheduledNotifications({
    token: tokenB,
    scope: 'server-b',
    settings: baseSettings({ weekly: true }),
    billsReady: false,
  });

  const statusA = reconciler.readNotificationStatus('server-a');
  const statusB = reconciler.readNotificationStatus('server-b');
  assert.ok(statusA.lastRefresh.weekly);
  assert.ok(statusB.lastRefresh.weekly);
  assert.notEqual(
    store.kv.getString('notif.status.v2.server-a'),
    store.kv.getString('notif.status.v2.server-b'),
  );
  assert.equal(store.kv.getString('notif.status.v2.server-a') != null, true);
  assert.equal(store.kv.getString('notif.status.v2.server-b') != null, true);
  assert.equal(store.kv.getString('notif.status.v2'), null);
});

test('profile purge suspends scope before post-purge reconcile can recreate OS/KV/status', async () => {
  const store = createStorage();
  const notificationsApi = createNotificationsApi();
  const scheduleDelay = deferred();
  notificationsApi.setScheduleDelay(scheduleDelay);
  const reconciler = createReconciler(store, notificationsApi);
  const scope = 'server-a';

  const runner = createNotificationReconciliationOwnerRunner({
    generation: getProfileGeneration(),
    reconcileScheduled: (input) => reconciler.reconcileScheduledNotifications(input),
    reconcileEvent: () => Promise.resolve(),
  });

  const inFlight = runner.startScheduled({
    scope,
    settings: baseSettings({ weekly: true }),
    billsReady: false,
  });
  assert.ok(inFlight.token);

  runner.purgeProfile(scope);
  scheduleDelay.resolve(undefined);
  await inFlight.run.catch(() => {});

  const postPurge = runner.startScheduled({
    scope,
    settings: baseSettings({ weekly: true }),
    billsReady: false,
  });
  assert.equal(postPurge.suppressed, true);
  await postPurge.run;

  assert.equal(notificationsApi.scheduled.length, 0);
  assert.equal(store.kv.getString(`notif.scheduledIds.v1.${scope}`), null);
  assert.equal(store.kv.getString(`notif.status.v2.${scope}`), null);
  assert.equal(isNotificationScopeSuspended(scope), true);

  activateNotificationScope(scope, getProfileGeneration());
  const reconnected = runner.startScheduled({
    scope,
    settings: baseSettings({ weekly: true }),
    billsReady: false,
  });
  await reconnected.run;
  assert.equal(notificationsApi.scheduled.length, 1);
  assert.ok(store.kv.getString(`notif.scheduledIds.v1.${scope}`));
});

test('weekly rollback restores tracked IDs after cancellation without requiring a live token', async () => {
  const store = createStorage();
  const notificationsApi = createNotificationsApi();
  notificationsApi.scheduled.push({ id: 'old-weekly', request: { trigger: {} } });
  const reconciler = createReconciler(store, notificationsApi);
  store.kv.setString(
    'notif.scheduledIds.v1.server-a',
    JSON.stringify({ weekly: ['old-weekly'] }),
  );

  const token = beginReconciliation('scheduled', 0, 'server-a');
  const originalSchedule = notificationsApi.scheduleNotificationAsync.bind(notificationsApi);
  notificationsApi.scheduleNotificationAsync = async (request) => {
    const id = await originalSchedule(request);
    cancelReconciliation(token);
    return id;
  };

  await assert.rejects(
    reconciler.reconcileScheduledNotifications({
      token,
      scope: 'server-a',
      settings: baseSettings({ weekly: true }),
      billsReady: false,
    }),
    (error) => error.code === 'NOTIFICATION_RECONCILIATION_STALE',
  );

  assert.equal(notificationsApi.cancelled.filter((id) => id.startsWith('scheduled-')).length, 1);
  assert.ok(!notificationsApi.cancelled.includes('old-weekly'));
  assert.deepEqual(JSON.parse(store.kv.getString('notif.scheduledIds.v1.server-a')), { weekly: ['old-weekly'] });
  assert.deepEqual(osLiveIdsFromApi(notificationsApi), ['old-weekly']);
  assertOsMatchesKvTrackedLive(reconciler, 'server-a', 'weekly', notificationsApi);
});

test('rollback CAS does not clobber a newer lane weekly write', async () => {
  const store = createStorage();
  const notificationsApi = createNotificationsApi();
  const reconciler = createReconciler(store, notificationsApi);
  store.kv.setString(
    'notif.scheduledIds.v1.server-a',
    JSON.stringify({ weekly: ['old-weekly'] }),
  );

  const staleToken = beginReconciliation('scheduled', 0, 'server-a');
  const originalSchedule = notificationsApi.scheduleNotificationAsync.bind(notificationsApi);
  let scheduleCount = 0;
  notificationsApi.scheduleNotificationAsync = async (request) => {
    scheduleCount += 1;
    const id = await originalSchedule(request);
    if (scheduleCount === 1) {
      cancelReconciliation(staleToken);
      bumpProfileGeneration();
      const freshToken = beginReconciliation('scheduled', getProfileGeneration(), 'server-a');
      await reconciler.reconcileScheduledNotifications({
        token: freshToken,
        scope: 'server-a',
        settings: baseSettings({ weekly: true }),
        billsReady: false,
      });
    }
    return id;
  };

  await assert.rejects(
    reconciler.reconcileScheduledNotifications({
      token: staleToken,
      scope: 'server-a',
      settings: baseSettings({ weekly: true }),
      billsReady: false,
    }),
    (error) => error.code === 'NOTIFICATION_RECONCILIATION_STALE',
  );

  assert.deepEqual(reconciler.readCommittedScheduledIds('server-a', 'weekly'), ['scheduled-2']);
});

test('bill rollback CAS restores previous tracked IDs after cancellation', async () => {
  const store = createStorage();
  const notificationsApi = createNotificationsApi();
  notificationsApi.scheduled.push(
    { id: 'tracked-bill-1', request: { trigger: {} } },
    { id: 'tracked-bill-2', request: { trigger: {} } },
  );
  const reconciler = createReconciler(store, notificationsApi);
  store.kv.setString(
    'notif.scheduledIds.v1.server-a',
    JSON.stringify({ bills: ['tracked-bill-1', 'tracked-bill-2'] }),
  );

  const token = beginReconciliation('scheduled', 0, 'server-a');
  let scheduleCount = 0;
  const originalSchedule = notificationsApi.scheduleNotificationAsync.bind(notificationsApi);
  notificationsApi.scheduleNotificationAsync = async (request) => {
    scheduleCount += 1;
    const id = await originalSchedule(request);
    if (scheduleCount === 1) cancelReconciliation(token);
    return id;
  };

  await assert.rejects(
    reconciler.reconcileScheduledNotifications({
      token,
      scope: 'server-a',
      settings: baseSettings({ bills: true }),
      bills: [bill('2026-07-20')],
      billsReady: true,
    }),
    (error) => error.code === 'NOTIFICATION_RECONCILIATION_STALE',
  );

  assert.equal(notificationsApi.cancelled.filter((id) => id.startsWith('scheduled-')).length, 1);
  assert.ok(!notificationsApi.cancelled.includes('tracked-bill-1'));
  assert.ok(!notificationsApi.cancelled.includes('tracked-bill-2'));
  assert.deepEqual(
    JSON.parse(store.kv.getString('notif.scheduledIds.v1.server-a')),
    { bills: ['tracked-bill-1', 'tracked-bill-2'] },
  );
  assertOsMatchesKvTrackedLive(reconciler, 'server-a', 'bills', notificationsApi);
});

test('F2 repro: staged pending abort never cancels prior canonical OS IDs', async () => {
  const store = createStorage();
  const notificationsApi = createNotificationsApi();
  notificationsApi.scheduled.push({ id: 'old-weekly', request: { trigger: {} } });
  const reconciler = createReconciler(store, notificationsApi);
  store.kv.setString(
    'notif.scheduledIds.v1.server-a',
    JSON.stringify({ weekly: ['old-weekly'] }),
  );

  const token = beginReconciliation('scheduled', 0, 'server-a');
  let sawPendingStage = false;
  const stagingReconciler = createReconciler(store, notificationsApi, {
    onStageEvent: (event, context) => {
      if (event !== 'afterStageWrite') return;
      assert.deepEqual(context.state.canonical, ['old-weekly']);
      assert.equal(context.state.pending.length, 1);
      sawPendingStage = true;
      cancelReconciliation(token);
    },
  });

  await assert.rejects(
    stagingReconciler.reconcileScheduledNotifications({
      token,
      scope: 'server-a',
      settings: baseSettings({ weekly: true }),
      billsReady: false,
    }),
    (error) => error.code === 'NOTIFICATION_RECONCILIATION_STALE',
  );

  assert.equal(sawPendingStage, true);
  assert.equal(notificationsApi.cancelled.filter((id) => id.startsWith('scheduled-')).length, 1);
  assert.ok(!notificationsApi.cancelled.includes('old-weekly'));
  assert.deepEqual(osLiveIdsFromApi(notificationsApi), ['old-weekly']);
  assert.deepEqual(stagingReconciler.readCommittedScheduledIds('server-a', 'weekly'), ['old-weekly']);
  assertOsMatchesKvTrackedLive(stagingReconciler, 'server-a', 'weekly', notificationsApi);
});

test('restart converge clears orphaned pending and retiring without duplicate OS IDs', async () => {
  const store = createStorage();
  const notificationsApi = createNotificationsApi();
  notificationsApi.scheduled.push(
    { id: 'canonical-old', request: { trigger: {} } },
    { id: 'pending-orphan', request: { trigger: {} } },
    { id: 'retiring-dead', request: { trigger: {} } },
  );
  const reconciler = createReconciler(store, notificationsApi);
  store.kv.setString(
    'notif.scheduledIds.v1.server-a',
    JSON.stringify({
      weekly: {
        canonical: ['canonical-old'],
        pending: ['pending-orphan'],
        retiring: ['retiring-dead'],
        laneToken: null,
      },
    }),
  );

  await reconciler.convergeCategorySchedules('server-a', 'weekly');
  assert.deepEqual(notificationsApi.cancelled.sort(), ['pending-orphan', 'retiring-dead'].sort());
  assert.deepEqual(osLiveIdsFromApi(notificationsApi), ['canonical-old']);
  assert.deepEqual(reconciler.readCommittedScheduledIds('server-a', 'weekly'), ['canonical-old']);
  assertOsMatchesKvTrackedLive(reconciler, 'server-a', 'weekly', notificationsApi);
});

const STAGE_FAULT_EVENTS = [
  'afterSchedule',
  'afterStageWrite',
  'afterCanonicalCommit',
  'afterOldCancel',
  'duringCleanup',
];

for (const faultEvent of STAGE_FAULT_EVENTS) {
  for (const category of ['weekly', 'bills']) {
    test(`stage fault ${faultEvent} keeps ${category} OS/KV live-set aligned through abort and converge`, async () => {
      const store = createStorage();
      const notificationsApi = createNotificationsApi();
      notificationsApi.scheduled.push(
        { id: 'prev-1', request: { trigger: {} } },
        ...(category === 'bills' ? [{ id: 'prev-2', request: { trigger: {} } }] : []),
      );
      const previous = category === 'weekly' ? ['prev-1'] : ['prev-1', 'prev-2'];
      store.kv.setString(
        'notif.scheduledIds.v1.server-a',
        JSON.stringify({ [category]: previous }),
      );

      let faulted = false;
      let activeToken = null;
      const reconciler = createReconciler(store, notificationsApi, {
        onStageEvent: async (event) => {
          if (faulted || event !== faultEvent) return;
          faulted = true;
          cancelReconciliation(activeToken);
        },
      });

      activeToken = beginReconciliation('scheduled', 0, 'server-a');
      const token = activeToken;
      const bills = category === 'bills'
        ? [bill('2026-07-20'), bill('2026-07-21')]
        : undefined;

      await assert.rejects(
        reconciler.reconcileScheduledNotifications({
          token,
          scope: 'server-a',
          settings: baseSettings({
            weekly: category === 'weekly',
            bills: category === 'bills',
          }),
          bills,
          billsReady: category === 'bills',
        }),
        (error) => error.code === 'NOTIFICATION_RECONCILIATION_STALE',
      );

      assert.equal(faulted, true);
      assertOsMatchesKvTrackedLive(reconciler, 'server-a', category, notificationsApi);

      const postAbortCanonical = reconciler.readCommittedScheduledIds('server-a', category);
      if (faultEvent === 'afterSchedule' || faultEvent === 'afterStageWrite') {
        assert.deepEqual(postAbortCanonical, previous);
      } else {
        assert.notDeepEqual(postAbortCanonical, previous);
      }

      await reconciler.convergeCategorySchedules('server-a', category);
      assertOsMatchesKvTrackedLive(reconciler, 'server-a', category, notificationsApi);

      const restartToken = beginReconciliation('scheduled', 0, 'server-a');
      await reconciler.reconcileScheduledNotifications({
        token: restartToken,
        scope: 'server-a',
        settings: baseSettings({
          weekly: category === 'weekly',
          bills: category === 'bills',
        }),
        bills,
        billsReady: category === 'bills',
      });
      assertOsMatchesKvTrackedLive(reconciler, 'server-a', category, notificationsApi);
      assert.ok(reconciler.readCommittedScheduledIds('server-a', category).length > 0);
    });
  }
}

test('event present marker prevents duplicate delivery after cancellation', async () => {
  const store = createStorage();
  const notificationsApi = createNotificationsApi();
  const reconciler = createReconciler(store, notificationsApi);
  store.kv.setString('notif.lastSeenTxnIds.v3.server-a', JSON.stringify(['txn-old']));

  const first = beginReconciliation('event', 0, 'server-a');
  let scheduleCount = 0;
  const originalSchedule = notificationsApi.scheduleNotificationAsync.bind(notificationsApi);
  notificationsApi.scheduleNotificationAsync = async (request) => {
    scheduleCount += 1;
    const id = await originalSchedule(request);
    if (scheduleCount === 1 && request.trigger == null) cancelReconciliation(first);
    return id;
  };

  await assert.rejects(
    reconciler.reconcileEventNotifications({
      token: first,
      scope: 'server-a',
      settings: baseSettings({ largeCharge: true }),
      transactions: [{ id: 'txn-1', amount: -500, payee: 'Store' }],
    }),
    (error) => error.code === 'NOTIFICATION_RECONCILIATION_STALE',
  );

  assert.equal(store.kv.getBool('notif.delivery.v1.server-a.largeCharge.txn-1', false), true);

  notificationsApi.scheduleNotificationAsync = originalSchedule;
  const retry = beginReconciliation('event', 0, 'server-a');
  await reconciler.reconcileEventNotifications({
    token: retry,
    scope: 'server-a',
    settings: baseSettings({ largeCharge: true }),
    transactions: [{ id: 'txn-1', amount: -500, payee: 'Store' }],
  });

  const immediate = notificationsApi.scheduled.filter((entry) => entry.request.trigger == null);
  assert.equal(immediate.length, 1);
});

test('present rejection rolls back delivery marker when still owned', async () => {
  const store = createStorage();
  const notificationsApi = createNotificationsApi();
  notificationsApi.setRejectImmediatePresent(true);
  const reconciler = createReconciler(store, notificationsApi);
  store.kv.setString('notif.lastSeenTxnIds.v3.server-a', JSON.stringify(['txn-old']));

  const token = beginReconciliation('event', 0, 'server-a');
  await assert.rejects(
    reconciler.reconcileEventNotifications({
      token,
      scope: 'server-a',
      settings: baseSettings({ largeCharge: true }),
      transactions: [{ id: 'txn-1', amount: -500, payee: 'Store' }],
    }),
    (error) => error.message === 'present failed',
  );

  assert.equal(store.kv.getBool('notif.delivery.v1.server-a.largeCharge.txn-1', false), false);
});

test('permission mid-await cancellation skips post-permission scheduled work', async () => {
  const store = createStorage();
  const notificationsApi = createNotificationsApi();
  const permissionDelay = deferred();
  notificationsApi.setPermissionDelay(permissionDelay);
  const reconciler = createReconciler(store, notificationsApi);
  const token = beginReconciliation('scheduled', 0, 'server-a');

  const pending = reconciler.reconcileScheduledNotifications({
    token,
    scope: 'server-a',
    settings: baseSettings({ weekly: true }),
    billsReady: false,
  });
  cancelReconciliation(token);
  permissionDelay.resolve(undefined);
  await pending.catch(() => {});

  assert.equal(notificationsApi.scheduled.length, 0);
  assert.equal(store.kv.getString('notif.status.v2.server-a'), null);
});

test('purge dismisses delivered finance notifications for the scoped profile only', async () => {
  const store = createStorage();
  const notificationsApi = createNotificationsApi();
  const reconciler = createReconciler(store, notificationsApi);
  notificationsApi.presented.push(
    {
      request: {
        identifier: 'del-a',
        content: { data: { route: '/bills', category: 'bills', scope: 'server-a' } },
      },
    },
    {
      request: {
        identifier: 'del-b',
        content: { data: { route: '/bills', category: 'bills', scope: 'server-b' } },
      },
    },
  );

  await reconciler.purgeNotificationProfileState('server-a');
  assert.deepEqual(notificationsApi.cancelled, []);
  assert.equal(notificationsApi.presented.length, 1);
  assert.equal(notificationsApi.presented[0].request.identifier, 'del-b');
});

test('persisted purge suspension survives module reset and blocks old scope', () => {
  const scope = 'server-a';
  purgeProfileGeneration(scope);
  assert.equal(suspensionStore.kv.getString(`${SUSPENSION_KEY_PREFIX}${scope}`), '0');

  simulateNotificationScopeSuspensionModuleReset();
  assert.equal(isNotificationScopeSuspended(scope), true);
  assert.throws(
    () => beginReconciliation('scheduled', getProfileGeneration(), scope),
    (error) => error.code === 'NOTIFICATION_RECONCILIATION_STALE',
  );
});

test('startup profile load does not clear persisted purge suspension', () => {
  const scope = 'server-a';
  purgeProfileGeneration(scope);
  simulateNotificationScopeSuspensionModuleReset();

  assert.equal(isNotificationScopeSuspended(scope), true);
  assert.equal(readPersistedSuspensionGeneration(scope), 0);
});

test('explicit setConfig activation clears only matching scope at current generation', () => {
  purgeProfileGeneration('server-a');
  purgeProfileGeneration('server-b');
  simulateNotificationScopeSuspensionModuleReset();

  activateNotificationScope('server-a', getProfileGeneration());
  assert.equal(isNotificationScopeSuspended('server-a'), false);
  assert.equal(isNotificationScopeSuspended('server-b'), true);
  beginReconciliation('scheduled', getProfileGeneration(), 'server-a');
});

test('completed purge does not reactivate old scope without explicit activation', async () => {
  const store = createStorage();
  const notificationsApi = createNotificationsApi();
  const reconciler = createReconciler(store, notificationsApi);
  const scope = 'server-a';
  store.kv.setString(
    'notif.scheduledIds.v1.server-a',
    JSON.stringify({ weekly: ['tracked-weekly'] }),
  );
  notificationsApi.scheduled.push({ id: 'tracked-weekly', request: { trigger: {} } });

  purgeProfileGeneration(scope);
  await reconciler.purgeNotificationProfileState(scope);
  simulateNotificationScopeSuspensionModuleReset();

  const runner = createNotificationReconciliationOwnerRunner({
    generation: getProfileGeneration(),
    reconcileScheduled: (input) => reconciler.reconcileScheduledNotifications(input),
    reconcileEvent: () => Promise.resolve(),
  });
  const blocked = runner.startScheduled({
    scope,
    settings: baseSettings({ weekly: true }),
    billsReady: false,
  });
  assert.equal(blocked.suppressed, true);
  await blocked.run;
  assert.equal(notificationsApi.scheduled.length, 0);
});

test('purge crash before config clear cannot repopulate schedules on restart admission block', async () => {
  const store = createStorage();
  const notificationsApi = createNotificationsApi();
  const reconciler = createReconciler(store, notificationsApi);
  const scope = 'server-a';
  store.kv.setString(
    'notif.scheduledIds.v1.server-a',
    JSON.stringify({ weekly: ['tracked-weekly'] }),
  );
  notificationsApi.scheduled.push({ id: 'tracked-weekly', request: { trigger: {} } });

  purgeProfileGeneration(scope);
  simulateNotificationScopeSuspensionModuleReset();

  const runner = createNotificationReconciliationOwnerRunner({
    generation: getProfileGeneration(),
    reconcileScheduled: (input) => reconciler.reconcileScheduledNotifications(input),
    reconcileEvent: (input) => reconciler.reconcileEventNotifications(input),
  });
  const blocked = runner.startScheduled({
    scope,
    settings: baseSettings({ weekly: true }),
    billsReady: false,
  });
  assert.equal(blocked.suppressed, true);
  await blocked.run;

  const blockedEvent = runner.startEvent({
    scope,
    settings: baseSettings({ largeCharge: true }),
    transactions: [{ id: 'txn-1', amount: -500, payee: 'Store' }],
  });
  assert.equal(blockedEvent.suppressed, true);
  await blockedEvent.run;
  assert.equal(notificationsApi.scheduled.length, 1);
});

test('confirmed cancel retains retiring IDs when OS cancel is rejected', async () => {
  const store = createStorage();
  const notificationsApi = createNotificationsApi();
  notificationsApi.scheduled.push({ id: 'old-weekly', request: { trigger: {} } });
  store.kv.setString(
    'notif.scheduledIds.v1.server-a',
    JSON.stringify({ weekly: ['old-weekly'] }),
  );
  notificationsApi.rejectCancelFor('old-weekly');
  const reconciler = createReconciler(store, notificationsApi);

  const token = beginReconciliation('scheduled', 0, 'server-a');
  await reconciler.reconcileScheduledNotifications({
    token,
    scope: 'server-a',
    settings: baseSettings({ weekly: true }),
    billsReady: false,
  });

  const state = reconciler.readCategoryScheduleState('server-a', 'weekly');
  assert.equal(state.canonical.length, 1);
  assert.notEqual(state.canonical[0], 'old-weekly');
  assert.deepEqual(state.retiring, ['old-weekly']);
  assertOsMatchesKvTrackedLive(reconciler, 'server-a', 'weekly', notificationsApi);

  notificationsApi.clearCancelFaults();
  await reconciler.convergeCategorySchedules('server-a', 'weekly');
  assert.deepEqual(reconciler.readCategoryScheduleState('server-a', 'weekly').retiring, []);
  assertOsMatchesKvTrackedLive(reconciler, 'server-a', 'weekly', notificationsApi);
});

test('converge retains pending orphan when cancel cannot be confirmed', async () => {
  const store = createStorage();
  const notificationsApi = createNotificationsApi();
  notificationsApi.scheduled.push(
    { id: 'canonical-old', request: { trigger: {} } },
    { id: 'pending-orphan', request: { trigger: {} } },
  );
  const reconciler = createReconciler(store, notificationsApi);
  store.kv.setString(
    'notif.scheduledIds.v1.server-a',
    JSON.stringify({
      weekly: {
        canonical: ['canonical-old'],
        pending: ['pending-orphan'],
        retiring: [],
        cleanup: [],
        laneToken: null,
      },
    }),
  );

  notificationsApi.rejectCancelFor('pending-orphan');
  await reconciler.convergeCategorySchedules('server-a', 'weekly');
  const state = reconciler.readCategoryScheduleState('server-a', 'weekly');
  assert.deepEqual(state.pending, ['pending-orphan']);
  assert.deepEqual(state.canonical, ['canonical-old']);
  assertOsMatchesKvTrackedLive(reconciler, 'server-a', 'weekly', notificationsApi);

  notificationsApi.clearCancelFaults();
  await reconciler.convergeCategorySchedules('server-a', 'weekly');
  assert.deepEqual(reconciler.readCommittedScheduledIds('server-a', 'weekly'), ['canonical-old']);
  assertOsMatchesKvTrackedLive(reconciler, 'server-a', 'weekly', notificationsApi);
});

test('restart converge retries retained retiring IDs after partial replacement cleanup failure', async () => {
  const store = createStorage();
  const notificationsApi = createNotificationsApi();
  notificationsApi.scheduled.push({ id: 'old-weekly', request: { trigger: {} } });
  store.kv.setString(
    'notif.scheduledIds.v1.server-a',
    JSON.stringify({ weekly: ['old-weekly'] }),
  );
  notificationsApi.rejectCancelFor('old-weekly');
  const reconciler = createReconciler(store, notificationsApi);

  const first = beginReconciliation('scheduled', 0, 'server-a');
  await reconciler.reconcileScheduledNotifications({
    token: first,
    scope: 'server-a',
    settings: baseSettings({ weekly: true }),
    billsReady: false,
  });
  assert.deepEqual(reconciler.readCategoryScheduleState('server-a', 'weekly').retiring, ['old-weekly']);

  notificationsApi.clearCancelFaults();
  await reconciler.convergeCategorySchedules('server-a', 'weekly');

  const restart = beginReconciliation('scheduled', 0, 'server-a');
  await reconciler.reconcileScheduledNotifications({
    token: restart,
    scope: 'server-a',
    settings: baseSettings({ weekly: true }),
    billsReady: false,
  });
  assert.deepEqual(reconciler.readCategoryScheduleState('server-a', 'weekly').retiring, []);
  assertOsMatchesKvTrackedLive(reconciler, 'server-a', 'weekly', notificationsApi);
});

test('profile purge retains tombstoned cleanup evidence when OS cancel is unconfirmed', async () => {
  const store = createStorage();
  const notificationsApi = createNotificationsApi();
  notificationsApi.scheduled.push({ id: 'tracked-weekly', request: { trigger: {} } });
  store.kv.setString(
    'notif.scheduledIds.v1.server-a',
    JSON.stringify({ weekly: ['tracked-weekly'] }),
  );
  notificationsApi.rejectCancelFor('tracked-weekly');
  const reconciler = createReconciler(store, notificationsApi);

  purgeProfileGeneration('server-a');
  await reconciler.purgeNotificationProfileState('server-a');

  const raw = JSON.parse(store.kv.getString('notif.scheduledIds.v1.server-a'));
  assert.equal(raw.weekly.purgeTombstone, true);
  assert.deepEqual(raw.weekly.cleanup, ['tracked-weekly']);
  assert.deepEqual(raw.weekly.canonical, []);
  assertOsMatchesKvTrackedLive(reconciler, 'server-a', 'weekly', notificationsApi);

  notificationsApi.clearCancelFaults();
  await reconciler.purgeNotificationProfileState('server-a');
  assert.equal(store.kv.getString('notif.scheduledIds.v1.server-a'), null);
  assert.deepEqual(osLiveIdsFromApi(notificationsApi), []);
});

test('enumeration failure during converge retains evidence for retry', async () => {
  const store = createStorage();
  const notificationsApi = createNotificationsApi();
  notificationsApi.scheduled.push({ id: 'retiring-dead', request: { trigger: {} } });
  const reconciler = createReconciler(store, notificationsApi);
  store.kv.setString(
    'notif.scheduledIds.v1.server-a',
    JSON.stringify({
      weekly: {
        canonical: [],
        pending: [],
        retiring: ['retiring-dead'],
        cleanup: [],
        laneToken: null,
      },
    }),
  );

  notificationsApi.setEnumFails(true);
  await reconciler.convergeCategorySchedules('server-a', 'weekly');
  assert.deepEqual(reconciler.readCategoryScheduleState('server-a', 'weekly').retiring, ['retiring-dead']);
  assertKvEvidenceCoversOsLive(reconciler, 'server-a', 'weekly', notificationsApi);

  notificationsApi.setEnumFails(false);
  await reconciler.convergeCategorySchedules('server-a', 'weekly');
  assert.deepEqual(reconciler.readCommittedScheduledIds('server-a', 'weekly'), []);
  assertOsMatchesKvTrackedLive(reconciler, 'server-a', 'weekly', notificationsApi);
});
