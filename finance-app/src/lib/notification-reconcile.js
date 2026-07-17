'use strict';

const FINANCE_CATEGORIES = new Set([
  'bills',
  'largeCharge',
  'newSub',
  'weekly',
  'lowBalance',
  'repayments',
]);

const NOTIF_KEYS = {
  scheduledIds: 'notif.scheduledIds.v1',
  /** Device-global: legacy OS schedules existed before tracked IDs and are not profile-specific. */
  legacyMigration: 'notif.legacyScheduleMigration.v1',
  /** Per-profile: user-visible refresh metadata in settings/diagnostics. */
  status: 'notif.status.v2',
  lastSeenTxn: 'notif.lastSeenTxnIds.v3',
  subSnapshot: 'notif.subSnapshot.v2',
  lowBalSnapshot: 'notif.lowBalSnapshot.v2',
  repaySnapshot: 'notif.repaySnapshot.v2',
  billSameDayPrefix: 'notif.billSameDay.v2.',
  legacyBillSameDayPrefix: 'notif.billSameDay.',
  deliveryPrefix: 'notif.delivery.v1.',
};

const { createCategoryScheduleReplacer } = require('./notification-scheduled-replace');
const { createConfirmedScheduledCanceller } = require('./notification-scheduled-cancel');
const {
  allTrackedIds,
  readCategoryState,
  readCommittedCategoryIds,
  writeCategoryState,
} = require('./notification-scheduled-stage');

const NOTIFICATION_ROUTES = {
  bills: '/bills',
  largeCharge: '/(tabs)/transactions',
  newSub: '/subscriptions',
  weekly: '/review',
  lowBalance: '/networth',
  repayments: '/reimbursement',
};

function parseNotificationRoute(data) {
  if (!data || typeof data !== 'object') return null;
  const route = data.route;
  const category = data.category;
  const scope = data.scope;
  if (typeof route !== 'string' || typeof category !== 'string' || typeof scope !== 'string') {
    return null;
  }
  if (!FINANCE_CATEGORIES.has(category)) return null;
  return { route, category, scope };
}

function isFinanceScheduledNotification(notification) {
  const data = notification?.content?.data
    ?? notification?.request?.content?.data
    ?? notification?.request?.trigger?.payload;
  return parseNotificationRoute(data) != null;
}

function notificationIdentifier(notification) {
  return notification?.identifier ?? notification?.request?.identifier ?? null;
}

function scopedKey(key, scope) {
  return `${key}.${scope}`;
}

/**
 * @param {{
 *   notifications: Record<string, any>;
 *   kv: Record<string, any>;
 *   storage: Record<string, any>;
 *   assertReconciliationCurrent: (token: any) => void;
 *   withReconciliationGuard: (token: any, fn: () => any) => Promise<any>;
 *   classifyBillReminder: (bill: any, now?: number) => any;
 *   buildBillNotificationContent: (bill: any, kind: string, privacy: string) => { title: string; body: string };
 *   buildLargeChargeNotificationContent: (top: any, extra: number, privacy: string) => { title: string; body: string };
 *   buildLowBalanceNotificationContent: (account: any, extra: number, privacy: string) => { title: string; body: string };
 *   buildRepaymentNotificationContent: (suggestion: any, extra: number, privacy: string) => { title: string; body: string };
 *   buildSubscriptionNotificationContent: (names: string[], privacy: string) => { title: string; body: string };
 *   isCashAccount: (account: any) => boolean;
 * }} deps
 */
function createNotificationReconciler(deps) {
  const {
    notifications,
    kv,
    storage,
    assertReconciliationCurrent,
    withReconciliationGuard,
    classifyBillReminder,
    buildBillNotificationContent,
    buildLargeChargeNotificationContent,
    buildLowBalanceNotificationContent,
    buildRepaymentNotificationContent,
    buildSubscriptionNotificationContent,
    isCashAccount,
    onStageEvent,
  } = deps;

  function readTrackedScheduledIds(scope) {
    const raw = kv.getString(scopedKey(NOTIF_KEYS.scheduledIds, scope));
    if (!raw) return {};
    try {
      return JSON.parse(raw);
    } catch {
      return {};
    }
  }

  function writeTrackedScheduledIds(scope, next) {
    kv.setString(scopedKey(NOTIF_KEYS.scheduledIds, scope), JSON.stringify(next));
  }

  const confirmedCanceller = createConfirmedScheduledCanceller({
    cancelScheduledNotificationAsync: (id) => notifications.cancelScheduledNotificationAsync(id),
    getAllScheduledNotificationsAsync: () => notifications.getAllScheduledNotificationsAsync(),
  });

  const categoryReplacer = createCategoryScheduleReplacer({
    readTracked: readTrackedScheduledIds,
    writeTracked: writeTrackedScheduledIds,
    confirmCancelScheduledIds: (ids) => confirmedCanceller.confirmCancelScheduledIds(ids),
    scheduleNotificationAsync: (request) => notifications.scheduleNotificationAsync(request),
    assertReconciliationCurrent,
    onStageEvent,
  });

  function readCategoryScheduleState(scope, category) {
    return readCategoryState(readTrackedScheduledIds(scope), category);
  }

  function readCommittedScheduledIds(scope, category) {
    return readCommittedCategoryIds(readTrackedScheduledIds(scope), category);
  }

  async function readPermissionGranted(token) {
    assertReconciliationCurrent(token);
    const result = await notifications.getPermissionsAsync();
    assertReconciliationCurrent(token);
    return !!result.granted;
  }

  async function cancelTrackedCategory(token, scope, category) {
    assertReconciliationCurrent(token);
    const tracked = readTrackedScheduledIds(scope);
    const state = readCategoryState(tracked, category);
    const ids = allTrackedIds(state);
    if (!ids.length) return;

    const { retained } = await confirmedCanceller.confirmCancelScheduledIds(ids);
    assertReconciliationCurrent(token);

    if (retained.length) {
      writeCategoryState(tracked, category, {
        canonical: [],
        pending: [],
        retiring: [],
        cleanup: [...new Set([...state.cleanup, ...retained])],
        laneToken: null,
        purgeTombstone: false,
      });
    } else {
      delete tracked[category];
    }
    writeTrackedScheduledIds(scope, tracked);
  }

  async function migrateLegacyScheduledNotifications(token) {
    if (kv.getBool(NOTIF_KEYS.legacyMigration, false)) return;
    assertReconciliationCurrent(token);

    let scheduled;
    try {
      scheduled = await notifications.getAllScheduledNotificationsAsync();
    } catch {
      return;
    }
    assertReconciliationCurrent(token);

    const ownedIds = [];
    for (const notification of scheduled) {
      if (!isFinanceScheduledNotification(notification)) continue;
      const id = notificationIdentifier(notification);
      if (id) ownedIds.push(id);
    }

    for (const id of ownedIds) {
      assertReconciliationCurrent(token);
      try {
        await notifications.cancelScheduledNotificationAsync(id);
      } catch {
        return;
      }
    }

    assertReconciliationCurrent(token);
    kv.setBool(NOTIF_KEYS.legacyMigration, true);
  }

  async function refreshNotificationStatus(token, scope) {
    assertReconciliationCurrent(token);
    const status = readNotificationStatus(scope);
    status.permissionGranted = await readPermissionGranted(token);
    try {
      const scheduled = await notifications.getAllScheduledNotificationsAsync();
      assertReconciliationCurrent(token);
      status.scheduledCount = scheduled.length;
    } catch {
      status.scheduledCount = 0;
    }
    writeNotificationStatus(token, scope, status);
    return status;
  }

  async function scheduleWeeklyNotification(token, scope, settings) {
    const result = await categoryReplacer.replaceCategorySchedules(token, scope, 'weekly', async ({ scheduleOne }) => {
      const identifier = await scheduleOne({
        content: {
          title: 'Your weekly money check-in',
          body: 'Open DarkFinances to review this week.',
          data: { route: NOTIFICATION_ROUTES.weekly, category: 'weekly', scope },
        },
        trigger: {
          type: notifications.SchedulableTriggerInputTypes.WEEKLY,
          weekday: 1,
          hour: 9,
          minute: 0,
        },
      });
      return [identifier];
    });
    void result;
    recordRefresh(token, scope, 'weekly');
  }

  async function scheduleBillNotifications(token, scope, settings, bills, financeToday) {
    const result = await categoryReplacer.replaceCategorySchedules(token, scope, 'bills', async ({ scheduleOne }) => {
      const scheduledIds = [];
      const seen = new Set();
      let count = 0;
      for (const billItem of bills) {
        if (count >= 20) break;
        const dedupe = `${billItem.key}-${billItem.dueDate}`;
        if (seen.has(dedupe)) continue;
        seen.add(dedupe);
        const plan = classifyBillReminder(billItem, Date.now(), scope, financeToday);
        if (!plan || plan.kind === 'overdue') continue;
        if (plan.sameDayKey && kv.getBool(plan.sameDayKey, false)) continue;
        const content = buildBillNotificationContent(billItem, plan.kind, settings.privacy);
        const identifier = await scheduleOne({
          content: {
            ...content,
            data: { route: NOTIFICATION_ROUTES.bills, category: 'bills', scope },
          },
          trigger: {
            type: notifications.SchedulableTriggerInputTypes.DATE,
            date: plan.triggerDate,
          },
        });
        assertReconciliationCurrent(token);
        if (plan.sameDayKey) kv.setBool(plan.sameDayKey, true);
        scheduledIds.push(identifier);
        count += 1;
      }
      return scheduledIds;
    });
    void result;
    recordRefresh(token, scope, 'bills');
  }

  function migrateLegacyBillSameDayKeys(scope) {
    for (const key of storage.getAllKeys()) {
      if (key.startsWith(NOTIF_KEYS.billSameDayPrefix)) continue;
      if (!key.startsWith(NOTIF_KEYS.legacyBillSameDayPrefix)) continue;
      storage.remove(key);
    }
    void scope;
  }

  function readNotificationStatus(scope) {
    const raw = kv.getString(scopedKey(NOTIF_KEYS.status, scope));
    if (!raw) return { permissionGranted: null, scheduledCount: 0, lastRefresh: {} };
    try {
      return JSON.parse(raw);
    } catch {
      return { permissionGranted: null, scheduledCount: 0, lastRefresh: {} };
    }
  }

  function writeNotificationStatus(token, scope, status) {
    assertReconciliationCurrent(token);
    kv.setString(scopedKey(NOTIF_KEYS.status, scope), JSON.stringify(status));
  }

  function recordRefresh(token, scope, category) {
    assertReconciliationCurrent(token);
    const status = readNotificationStatus(scope);
    status.lastRefresh[category] = new Date().toISOString();
    writeNotificationStatus(token, scope, status);
  }

  function deliveryMarkerKey(scope, category, deliveryKey) {
    return `${NOTIF_KEYS.deliveryPrefix}${scope}.${category}.${deliveryKey}`;
  }

  /**
   * Event delivery marker is persisted before OS present (trigger=null).
   * Tradeoff: a crash after present but before baseline update cannot re-fire the alert,
   * prioritizing at-most-once delivery over at-least-once. Definite present failure before
   * OS acceptance rolls the marker back; post-present cancellation retains the marker.
   */
  async function presentOnce(token, scope, category, deliveryKey, title, body, route) {
    const markerKey = deliveryMarkerKey(scope, category, deliveryKey);
    if (kv.getBool(markerKey, false)) {
      assertReconciliationCurrent(token);
      return false;
    }

    assertReconciliationCurrent(token);
    kv.setBool(markerKey, true);

    let presented = false;
    try {
      await notifications.scheduleNotificationAsync({
        content: { title, body, data: { ...route } },
        trigger: null,
      });
      presented = true;
      assertReconciliationCurrent(token);
      return true;
    } catch (error) {
      if (!presented && kv.getBool(markerKey, false)) {
        kv.setBool(markerKey, false);
      }
      throw error;
    }
  }

  async function reconcileScheduledNotifications(input) {
    const { token, scope, settings, bills, billsReady, financeToday } = input;
    assertReconciliationCurrent(token);

    await withReconciliationGuard(token, () => migrateLegacyScheduledNotifications(token));
    migrateLegacyBillSameDayKeys(scope);

    const permissionGranted = await readPermissionGranted(token);

    if (!settings.weekly) {
      await withReconciliationGuard(token, () => cancelTrackedCategory(token, scope, 'weekly'));
    } else if (permissionGranted) {
      await withReconciliationGuard(token, () => scheduleWeeklyNotification(token, scope, settings));
    }

    if (!settings.bills) {
      await withReconciliationGuard(token, () => cancelTrackedCategory(token, scope, 'bills'));
    } else if (billsReady && Array.isArray(bills) && permissionGranted) {
      await withReconciliationGuard(token, () => scheduleBillNotifications(token, scope, settings, bills, financeToday));
    }

    await withReconciliationGuard(token, () => refreshNotificationStatus(token, scope));
  }

  async function checkLargeCharges(token, scope, settings, txns) {
    if (!settings.largeCharge || !txns.length) return;
    assertReconciliationCurrent(token);
    const key = scopedKey(NOTIF_KEYS.lastSeenTxn, scope);
    const raw = kv.getString(key);
    if (!raw) {
      kv.setString(key, JSON.stringify(txns.map((transaction) => transaction.id)));
      recordRefresh(token, scope, 'largeCharge');
      return;
    }
    let seen = [];
    try { seen = JSON.parse(raw); } catch { seen = []; }
    const seenSet = new Set(seen);
    const fresh = txns.filter(
      (t) => !seenSet.has(t.id) && t.amount < 0 && Math.abs(t.amount) >= settings.threshold,
    );
    if (fresh.length) {
      const deliveryKey = fresh.map((transaction) => transaction.id).sort().join(',');
      const top = fresh.reduce((a, b) => (Math.abs(b.amount) > Math.abs(a.amount) ? b : a));
      const content = buildLargeChargeNotificationContent(top, fresh.length - 1, settings.privacy);
      await presentOnce(
        token,
        scope,
        'largeCharge',
        deliveryKey,
        content.title,
        content.body,
        { route: NOTIFICATION_ROUTES.largeCharge, category: 'largeCharge', scope },
      );
    }
    assertReconciliationCurrent(token);
    kv.setString(
      key,
      JSON.stringify([...new Set([...txns.map((transaction) => transaction.id), ...seen])].slice(0, 2000)),
    );
    recordRefresh(token, scope, 'largeCharge');
  }

  async function checkLowBalances(token, scope, settings, accounts) {
    if (!settings.lowBalance || !accounts.length) return;
    assertReconciliationCurrent(token);
    const limit = settings.lowBalanceThreshold;
    const low = accounts.filter((a) => isCashAccount(a) && a.balance < limit);
    const lowIds = low.map((a) => a.id);
    const key = scopedKey(NOTIF_KEYS.lowBalSnapshot, scope);
    const raw = kv.getString(key);
    if (raw == null) {
      kv.setString(key, JSON.stringify(lowIds));
      recordRefresh(token, scope, 'lowBalance');
      return;
    }
    let prev = [];
    try { prev = JSON.parse(raw); } catch { prev = []; }
    const fresh = low.filter((a) => !prev.includes(a.id));
    if (fresh.length) {
      const deliveryKey = fresh.map((account) => account.id).sort().join(',');
      const worst = fresh.reduce((a, b) => (b.balance < a.balance ? b : a));
      const content = buildLowBalanceNotificationContent(worst, fresh.length - 1, settings.privacy);
      await presentOnce(
        token,
        scope,
        'lowBalance',
        deliveryKey,
        content.title,
        content.body,
        { route: NOTIFICATION_ROUTES.lowBalance, category: 'lowBalance', scope },
      );
    }
    assertReconciliationCurrent(token);
    kv.setString(key, JSON.stringify(lowIds));
    recordRefresh(token, scope, 'lowBalance');
  }

  async function checkNewSubscriptions(token, scope, settings, items) {
    if (!settings.newSub) return;
    assertReconciliationCurrent(token);
    const activeKeys = items.filter((i) => i.status === 'active').map((i) => i.key);
    const key = scopedKey(NOTIF_KEYS.subSnapshot, scope);
    const raw = kv.getString(key);
    if (!raw) {
      kv.setString(key, JSON.stringify(activeKeys));
      recordRefresh(token, scope, 'newSub');
      return;
    }
    let prev = [];
    try { prev = JSON.parse(raw); } catch { prev = []; }
    const fresh = activeKeys.filter((k) => !prev.includes(k));
    if (fresh.length) {
      const deliveryKey = fresh.sort().join(',');
      const names = items.filter((i) => fresh.includes(i.key)).map((i) => i.payee);
      const content = buildSubscriptionNotificationContent(names, settings.privacy);
      await presentOnce(
        token,
        scope,
        'newSub',
        deliveryKey,
        content.title,
        content.body,
        { route: NOTIFICATION_ROUTES.newSub, category: 'newSub', scope },
      );
    }
    assertReconciliationCurrent(token);
    kv.setString(key, JSON.stringify(activeKeys));
    recordRefresh(token, scope, 'newSub');
  }

  async function checkRepaymentSuggestions(token, scope, settings, suggestions) {
    if (!settings.repayments) return;
    assertReconciliationCurrent(token);
    const ids = suggestions.map((s) => s.inflow.id);
    const key = scopedKey(NOTIF_KEYS.repaySnapshot, scope);
    const raw = kv.getString(key);
    if (raw == null) {
      kv.setString(key, JSON.stringify(ids));
      recordRefresh(token, scope, 'repayments');
      return;
    }
    let prev = [];
    try { prev = JSON.parse(raw); } catch { prev = []; }
    const fresh = suggestions.filter((s) => !prev.includes(s.inflow.id));
    if (fresh.length) {
      const deliveryKey = fresh.map((suggestion) => suggestion.inflow.id).sort().join(',');
      const content = buildRepaymentNotificationContent(fresh[0], fresh.length - 1, settings.privacy);
      await presentOnce(
        token,
        scope,
        'repayments',
        deliveryKey,
        content.title,
        content.body,
        { route: NOTIFICATION_ROUTES.repayments, category: 'repayments', scope },
      );
    }
    assertReconciliationCurrent(token);
    kv.setString(key, JSON.stringify(ids));
    recordRefresh(token, scope, 'repayments');
  }

  async function reconcileEventNotifications(input) {
    const {
      token,
      scope,
      settings,
      transactions,
      accounts,
      recurring,
      repayments,
    } = input;
    assertReconciliationCurrent(token);
    if (!(await readPermissionGranted(token))) return;

    if (settings.largeCharge && transactions) {
      await withReconciliationGuard(token, () => checkLargeCharges(token, scope, settings, transactions));
    }
    if (settings.lowBalance && accounts) {
      await withReconciliationGuard(token, () => checkLowBalances(token, scope, settings, accounts));
    }
    if (settings.newSub && recurring) {
      await withReconciliationGuard(token, () => checkNewSubscriptions(token, scope, settings, recurring));
    }
    if (settings.repayments && repayments) {
      await withReconciliationGuard(token, () => checkRepaymentSuggestions(token, scope, settings, repayments));
    }
  }

  function clearNotificationRoutingState() {
    try {
      notifications.clearLastNotificationResponse();
    } catch {
      /* best effort */
    }
  }

  async function dismissDeliveredNotificationsForScope(scope) {
    const presented = await notifications.getPresentedNotificationsAsync();
    for (const notification of presented) {
      const payload = parseNotificationRoute(notification.request.content.data);
      if (!payload) continue;
      if (!scope || payload.scope === scope) {
        await notifications.dismissNotificationAsync(notification.request.identifier);
      }
    }
  }

  function hasScheduledPurgeTombstone(tracked) {
    for (const category of ['bills', 'weekly']) {
      const state = readCategoryState(tracked, category);
      if (state.purgeTombstone && allTrackedIds(state).length > 0) return true;
    }
    return false;
  }

  function clearScopedNotificationBaselines(scope) {
    if (!scope) {
      for (const key of storage.getAllKeys()) {
        if (key.startsWith(NOTIF_KEYS.legacyBillSameDayPrefix) && !key.startsWith(NOTIF_KEYS.billSameDayPrefix)) {
          storage.remove(key);
        }
      }
      return;
    }
    const scopedSuffix = `.${scope}`;
    for (const key of storage.getAllKeys()) {
      if (key.endsWith(scopedSuffix) && key.startsWith(NOTIF_KEYS.scheduledIds)) {
        if (hasScheduledPurgeTombstone(readTrackedScheduledIds(scope))) continue;
        storage.remove(key);
        continue;
      }
      if (key.endsWith(scopedSuffix) && (
        key.startsWith(NOTIF_KEYS.lastSeenTxn)
        || key.startsWith(NOTIF_KEYS.subSnapshot)
        || key.startsWith(NOTIF_KEYS.lowBalSnapshot)
        || key.startsWith(NOTIF_KEYS.repaySnapshot)
        || key.startsWith(NOTIF_KEYS.status)
      )) {
        storage.remove(key);
        continue;
      }
      if (key.startsWith(`${NOTIF_KEYS.billSameDayPrefix}${scope}.`)) {
        storage.remove(key);
        continue;
      }
      if (key.startsWith(`${NOTIF_KEYS.deliveryPrefix}${scope}.`)) {
        storage.remove(key);
      }
    }
  }

  async function purgeCategoryEvidence(scope, tracked, category) {
    const state = readCategoryState(tracked, category);
    const ids = allTrackedIds(state);
    if (!ids.length) {
      delete tracked[category];
      return;
    }

    const { retained } = await confirmedCanceller.confirmCancelScheduledIds(ids);
    if (retained.length) {
      writeCategoryState(tracked, category, {
        canonical: [],
        pending: [],
        retiring: [],
        cleanup: [...new Set(retained)],
        laneToken: null,
        purgeTombstone: true,
      });
      return;
    }
    delete tracked[category];
  }

  async function purgeNotificationProfileState(scope) {
    if (scope) {
      const tracked = readTrackedScheduledIds(scope);
      await purgeCategoryEvidence(scope, tracked, 'bills');
      await purgeCategoryEvidence(scope, tracked, 'weekly');
      if (Object.keys(tracked).length) writeTrackedScheduledIds(scope, tracked);
      else writeTrackedScheduledIds(scope, {});
    } else {
      for (const key of storage.getAllKeys()) {
        if (!key.startsWith(`${NOTIF_KEYS.scheduledIds}.`)) continue;
        const scoped = key.slice(`${NOTIF_KEYS.scheduledIds}.`.length);
        const tracked = readTrackedScheduledIds(scoped);
        await purgeCategoryEvidence(scoped, tracked, 'bills');
        await purgeCategoryEvidence(scoped, tracked, 'weekly');
        if (Object.keys(tracked).length) writeTrackedScheduledIds(scoped, tracked);
        else writeTrackedScheduledIds(scoped, {});
      }
    }
    await dismissDeliveredNotificationsForScope(scope);
    clearNotificationRoutingState();
    clearScopedNotificationBaselines(scope);
  }

  return {
    reconcileScheduledNotifications,
    reconcileEventNotifications,
    purgeNotificationProfileState,
    clearNotificationRoutingState,
    dismissDeliveredNotificationsForScope,
    migrateLegacyScheduledNotifications,
    parseNotificationRoute,
    readTrackedScheduledIds,
    readNotificationStatus,
    readCategoryScheduleState,
    readCommittedScheduledIds,
    convergeCategorySchedules: (scope, category) => categoryReplacer.convergeCategory(scope, category),
  };
}

module.exports = {
  FINANCE_CATEGORIES,
  NOTIFICATION_ROUTES,
  createNotificationReconciler,
  isFinanceScheduledNotification,
  parseNotificationRoute,
};
