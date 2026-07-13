import { useMemo, useSyncExternalStore } from 'react';
import * as Notifications from 'expo-notifications';
import { Account, Bill, RecurringItem, RepaymentSuggestion, Transaction } from '@/api/generated/types';
import { kv, storage } from '@/lib/storage';
import { fmtPos } from '@/theme/colors';

// On-device (local) notifications only — no server push, no APNs entitlement.
// Scheduled reminders (bills, weekly digest) are re-laid-out whenever the app
// opens with fresh data; event alerts (large charge, new subscription) fire
// immediately when newly-detected since the last run.

export const NOTIF = {
  bills: 'notif.bills',
  largeCharge: 'notif.largeCharge',
  newSub: 'notif.newSub',
  weekly: 'notif.weekly',
  lowBalance: 'notif.lowBalance',
  repayments: 'notif.repayments',
  threshold: 'notif.threshold',
  lowBalanceThreshold: 'notif.lowBalanceThreshold',
  privacy: 'notif.privacy',
  status: 'notif.status.v1',
  repaySnapshot: 'notif.repaySnapshot.v2',
  lastSeenTxn: 'notif.lastSeenTxnIds.v3',
  subSnapshot: 'notif.subSnapshot.v2',
  lowBalSnapshot: 'notif.lowBalSnapshot.v2',
} as const;

export type NotificationPrivacy = 'private' | 'detailed';
export type NotificationCategory = 'bills' | 'largeCharge' | 'newSub' | 'weekly' | 'lowBalance' | 'repayments';

export const NOTIFICATION_ROUTES = {
  bills: '/bills',
  largeCharge: '/(tabs)/transactions',
  newSub: '/subscriptions',
  weekly: '/review',
  lowBalance: '/networth',
  repayments: '/reimbursement',
} as const;

export interface NotificationRoutePayload {
  route: string;
  category: NotificationCategory;
  scope: string;
}

let settingsRevision = 0;
const settingsListeners = new Set<() => void>();
const subscribeSettings = (listener: () => void) => {
  settingsListeners.add(listener);
  return () => settingsListeners.delete(listener);
};
const settingsSnapshot = () => settingsRevision;
export function notifyNotifSettingsChanged() {
  settingsRevision += 1;
  settingsListeners.forEach((listener) => listener());
}
export function useNotifSettings(): NotifSettings {
  const revision = useSyncExternalStore(subscribeSettings, settingsSnapshot, settingsSnapshot);
  return useMemo(() => {
    void revision;
    return getNotifSettings();
  }, [revision]);
}
const scopedKey = (key: string, scope: string) => `${key}.${scope}`;

export const DEFAULT_THRESHOLD = 200;
export const DEFAULT_LOW_BALANCE = 100;

export interface NotifSettings {
  bills: boolean;
  largeCharge: boolean;
  newSub: boolean;
  weekly: boolean;
  lowBalance: boolean;
  repayments: boolean;
  threshold: number;
  lowBalanceThreshold: number;
  privacy: NotificationPrivacy;
}

export interface NotificationStatus {
  permissionGranted: boolean | null;
  scheduledCount: number;
  lastRefresh: Partial<Record<NotificationCategory, string>>;
}

export function getNotificationPrivacy(): NotificationPrivacy {
  const raw = kv.getString(NOTIF.privacy);
  return raw === 'detailed' ? 'detailed' : 'private';
}

export function setNotificationPrivacy(mode: NotificationPrivacy): void {
  kv.setString(NOTIF.privacy, mode);
  notifyNotifSettingsChanged();
}

export function getNotifSettings(): NotifSettings {
  return {
    bills: kv.getBool(NOTIF.bills, false),
    largeCharge: kv.getBool(NOTIF.largeCharge, false),
    newSub: kv.getBool(NOTIF.newSub, false),
    weekly: kv.getBool(NOTIF.weekly, false),
    lowBalance: kv.getBool(NOTIF.lowBalance, false),
    repayments: kv.getBool(NOTIF.repayments, false),
    threshold: kv.getNum(NOTIF.threshold, DEFAULT_THRESHOLD),
    lowBalanceThreshold: kv.getNum(NOTIF.lowBalanceThreshold, DEFAULT_LOW_BALANCE),
    privacy: getNotificationPrivacy(),
  };
}

function readStatus(): NotificationStatus {
  const raw = kv.getString(NOTIF.status);
  if (!raw) return { permissionGranted: null, scheduledCount: 0, lastRefresh: {} };
  try {
    return JSON.parse(raw) as NotificationStatus;
  } catch {
    return { permissionGranted: null, scheduledCount: 0, lastRefresh: {} };
  }
}

function writeStatus(next: NotificationStatus): void {
  kv.setString(NOTIF.status, JSON.stringify(next));
}

export function recordNotificationRefresh(category: NotificationCategory, scheduledCount?: number): void {
  const status = readStatus();
  status.lastRefresh[category] = new Date().toISOString();
  if (scheduledCount != null) status.scheduledCount = scheduledCount;
  writeStatus(status);
}

export async function refreshNotificationStatus(): Promise<NotificationStatus> {
  const status = readStatus();
  status.permissionGranted = await hasPermission();
  try {
    status.scheduledCount = (await Notifications.getAllScheduledNotificationsAsync()).length;
  } catch {
    status.scheduledCount = 0;
  }
  writeStatus(status);
  return status;
}

export function getNotificationStatus(): NotificationStatus {
  return readStatus();
}

Notifications.setNotificationHandler({
  handleNotification: async () => ({
    shouldShowBanner: true,
    shouldShowList: true,
    shouldPlaySound: false,
    shouldSetBadge: false,
  }),
});

export async function hasPermission(): Promise<boolean> {
  return (await Notifications.getPermissionsAsync()).granted;
}

export async function ensurePermission(): Promise<boolean> {
  if (await hasPermission()) return true;
  return (await Notifications.requestPermissionsAsync()).granted;
}

export async function clearFinanceNotifications(scope?: string): Promise<void> {
  await Notifications.cancelAllScheduledNotificationsAsync();
  const prefixes = [
    NOTIF.lastSeenTxn,
    NOTIF.subSnapshot,
    NOTIF.lowBalSnapshot,
    NOTIF.repaySnapshot,
    'notif.billSameDay.',
  ];
  for (const key of storage.getAllKeys()) {
    if (!prefixes.some((prefix) => key.startsWith(prefix))) continue;
    if (!scope || key.endsWith(`.${scope}`) || key.startsWith('notif.billSameDay.')) storage.remove(key);
  }
}

export function resetNotificationBaseline(category: NotificationCategory, scope: string): void {
  const keyByCategory: Partial<Record<NotificationCategory, string>> = {
    largeCharge: scopedKey(NOTIF.lastSeenTxn, scope),
    newSub: scopedKey(NOTIF.subSnapshot, scope),
    lowBalance: scopedKey(NOTIF.lowBalSnapshot, scope),
    repayments: scopedKey(NOTIF.repaySnapshot, scope),
  };
  const key = keyByCategory[category];
  if (key) kv.setString(key, null);
  if (category === 'bills') {
    for (const storageKey of storage.getAllKeys()) {
      if (storageKey.startsWith('notif.billSameDay.')) storage.remove(storageKey);
    }
  }
}

export function isCashAccount(account: Account): boolean {
  return !account.offbudget && !account.hidden && account.role === 'operating_cash';
}

export function buildBillNotificationContent(
  bill: Bill,
  dueToday: boolean,
  privacy: NotificationPrivacy,
): { title: string; body: string } {
  if (privacy === 'private') {
    return {
      title: dueToday ? 'Bill due today' : 'Bill due tomorrow',
      body: 'Open DarkFinances to review upcoming bills.',
    };
  }
  return {
    title: `${cap(bill.payee)} bill due ${dueToday ? 'today' : 'tomorrow'}`,
    body: `${fmtPos(bill.amount)} · ${bill.category}`,
  };
}

export function buildLargeChargeNotificationContent(
  top: Transaction,
  extraCount: number,
  privacy: NotificationPrivacy,
): { title: string; body: string } {
  if (privacy === 'private') {
    return {
      title: 'Large charge detected',
      body: extraCount > 0 ? 'Open DarkFinances to review recent activity.' : 'Open DarkFinances to review recent activity.',
    };
  }
  const extra = extraCount > 0 ? ` (+${extraCount} more)` : '';
  return {
    title: 'Large charge detected',
    body: `${fmtPos(Math.abs(top.amount))} at ${top.payee || 'unknown'}${extra}`,
  };
}

export function buildLowBalanceNotificationContent(
  account: Account,
  extraCount: number,
  privacy: NotificationPrivacy,
): { title: string; body: string } {
  if (privacy === 'private') {
    return {
      title: 'Low cash balance',
      body: 'Open DarkFinances to review account balances.',
    };
  }
  const extra = extraCount > 0 ? ` (+${extraCount} more)` : '';
  return {
    title: 'Low balance',
    body: `${account.name} is at ${fmtPos(account.balance)}${extra}`,
  };
}

export function buildRepaymentNotificationContent(
  suggestion: RepaymentSuggestion,
  extraCount: number,
  privacy: NotificationPrivacy,
): { title: string; body: string } {
  if (privacy === 'private') {
    return {
      title: 'Repayment to review',
      body: 'Open DarkFinances to review incoming payments.',
    };
  }
  const extra = extraCount > 0 ? ` (+${extraCount} more)` : '';
  return {
    title: 'Repayment to review',
    body: `${fmtPos(suggestion.inflow.amount)} from ${cap(suggestion.person)} may settle what they owe${extra}`,
  };
}

export function buildSubscriptionNotificationContent(
  names: string[],
  privacy: NotificationPrivacy,
): { title: string; body: string } {
  if (privacy === 'private') {
    return {
      title: 'New subscription detected',
      body: 'Open DarkFinances to review recurring charges.',
    };
  }
  const extra = names.length > 1 ? ` (+${names.length - 1} more)` : '';
  return {
    title: 'New subscription detected',
    body: `${names[0]}${extra}`,
  };
}

async function present(
  title: string,
  body: string,
  route: NotificationRoutePayload,
) {
  await Notifications.scheduleNotificationAsync({
    content: {
      title,
      body,
      data: { ...route },
    },
    trigger: null,
  });
}

const cap = (s: string) => (s ? s.charAt(0).toUpperCase() + s.slice(1) : s);

export async function rescheduleScheduled(bills: Bill[], settings: NotifSettings, scope = 'default') {
  if (!(await hasPermission())) return;
  await Notifications.cancelAllScheduledNotificationsAsync();

  if (settings.bills) {
    const seen = new Set<string>();
    let n = 0;
    for (const b of bills) {
      if (n >= 20) break;
      if (b.paid) continue;
      const id = `${b.key}-${b.dueDate}`;
      if (seen.has(id)) continue;
      seen.add(id);
      const [y, m, d] = b.dueDate.split('-').map(Number);
      let remind = new Date(y, m - 1, d - 1, 9, 0, 0);
      const dueEnd = new Date(y, m - 1, d, 23, 59, 59);
      if (dueEnd.getTime() < Date.now()) continue;
      const dueToday = remind.getTime() <= Date.now();
      let sameDayKey: string | null = null;
      if (dueToday) {
        sameDayKey = `notif.billSameDay.${id}`;
        if (kv.getBool(sameDayKey, false)) continue;
        remind = new Date(Date.now() + 5_000);
      }
      const content = buildBillNotificationContent(b, dueToday, settings.privacy);
      await Notifications.scheduleNotificationAsync({
        content: {
          ...content,
          data: { route: NOTIFICATION_ROUTES.bills, category: 'bills', scope } satisfies NotificationRoutePayload,
        },
        trigger: { type: Notifications.SchedulableTriggerInputTypes.DATE, date: remind },
      });
      if (sameDayKey) kv.setBool(sameDayKey, true);
      n++;
    }
    recordNotificationRefresh('bills');
  }

  if (settings.weekly) {
    await Notifications.scheduleNotificationAsync({
      content: {
        title: 'Your weekly money check-in',
        body: 'Open DarkFinances to review this week.',
        data: { route: NOTIFICATION_ROUTES.weekly, category: 'weekly', scope } satisfies NotificationRoutePayload,
      },
      trigger: { type: Notifications.SchedulableTriggerInputTypes.WEEKLY, weekday: 1, hour: 9, minute: 0 },
    });
    recordNotificationRefresh('weekly');
  }

  await refreshNotificationStatus();
}

export async function checkLargeCharges(txns: Transaction[], settings: NotifSettings, scope = 'default') {
  if (!settings.largeCharge || !(await hasPermission()) || !txns.length) return;
  const key = scopedKey(NOTIF.lastSeenTxn, scope);
  const raw = kv.getString(key);
  if (!raw) {
    kv.setString(key, JSON.stringify(txns.map((transaction) => transaction.id)));
    recordNotificationRefresh('largeCharge');
    return;
  }
  let seen: string[] = [];
  try { seen = JSON.parse(raw); } catch { seen = []; }
  const seenSet = new Set(seen);
  const fresh = txns.filter((t) => !seenSet.has(t.id) && t.amount < 0 && Math.abs(t.amount) >= settings.threshold);
  if (fresh.length) {
    const top = fresh.reduce((a, b) => (Math.abs(b.amount) > Math.abs(a.amount) ? b : a));
    const content = buildLargeChargeNotificationContent(top, fresh.length - 1, settings.privacy);
    await present(content.title, content.body, { route: NOTIFICATION_ROUTES.largeCharge, category: 'largeCharge', scope });
  }
  kv.setString(key, JSON.stringify([...new Set([...txns.map((transaction) => transaction.id), ...seen])].slice(0, 2000)));
  recordNotificationRefresh('largeCharge');
}

export async function checkLowBalances(accounts: Account[], settings: NotifSettings, scope = 'default') {
  if (!settings.lowBalance || !(await hasPermission()) || !accounts.length) return;
  const limit = settings.lowBalanceThreshold;
  const low = accounts.filter((a) => isCashAccount(a) && a.balance < limit);
  const lowIds = low.map((a) => a.id);
  const key = scopedKey(NOTIF.lowBalSnapshot, scope);
  const raw = kv.getString(key);
  if (raw == null) {
    kv.setString(key, JSON.stringify(lowIds));
    recordNotificationRefresh('lowBalance');
    return;
  }
  let prev: string[] = [];
  try { prev = JSON.parse(raw); } catch { prev = []; }
  const fresh = low.filter((a) => !prev.includes(a.id));
  if (fresh.length) {
    const worst = fresh.reduce((a, b) => (b.balance < a.balance ? b : a));
    const content = buildLowBalanceNotificationContent(worst, fresh.length - 1, settings.privacy);
    await present(content.title, content.body, { route: NOTIFICATION_ROUTES.lowBalance, category: 'lowBalance', scope });
  }
  kv.setString(key, JSON.stringify(lowIds));
  recordNotificationRefresh('lowBalance');
}

export async function checkRepaymentSuggestions(suggestions: RepaymentSuggestion[], settings: NotifSettings, scope = 'default') {
  if (!settings.repayments || !(await hasPermission())) return;
  const ids = suggestions.map((s) => s.inflow.id);
  const key = scopedKey(NOTIF.repaySnapshot, scope);
  const raw = kv.getString(key);
  if (raw == null) {
    kv.setString(key, JSON.stringify(ids));
    recordNotificationRefresh('repayments');
    return;
  }
  let prev: string[] = [];
  try { prev = JSON.parse(raw); } catch { prev = []; }
  const fresh = suggestions.filter((s) => !prev.includes(s.inflow.id));
  if (fresh.length) {
    const content = buildRepaymentNotificationContent(fresh[0], fresh.length - 1, settings.privacy);
    await present(content.title, content.body, { route: NOTIFICATION_ROUTES.repayments, category: 'repayments', scope });
  }
  kv.setString(key, JSON.stringify(ids));
  recordNotificationRefresh('repayments');
}

export async function checkNewSubscriptions(items: RecurringItem[], settings: NotifSettings, scope = 'default') {
  if (!settings.newSub || !(await hasPermission())) return;
  const activeKeys = items.filter((i) => i.status === 'active').map((i) => i.key);
  const key = scopedKey(NOTIF.subSnapshot, scope);
  const raw = kv.getString(key);
  if (!raw) {
    kv.setString(key, JSON.stringify(activeKeys));
    recordNotificationRefresh('newSub');
    return;
  }
  let prev: string[] = [];
  try { prev = JSON.parse(raw); } catch { prev = []; }
  const fresh = activeKeys.filter((k) => !prev.includes(k));
  if (fresh.length) {
    const names = items.filter((i) => fresh.includes(i.key)).map((i) => cap(i.payee));
    const content = buildSubscriptionNotificationContent(names, settings.privacy);
    await present(content.title, content.body, { route: NOTIFICATION_ROUTES.newSub, category: 'newSub', scope });
  }
  kv.setString(key, JSON.stringify(activeKeys));
  recordNotificationRefresh('newSub');
}

export function parseNotificationRoute(data: unknown): NotificationRoutePayload | null {
  if (!data || typeof data !== 'object') return null;
  const route = (data as NotificationRoutePayload).route;
  const category = (data as NotificationRoutePayload).category;
  const scope = (data as NotificationRoutePayload).scope;
  if (typeof route !== 'string' || typeof category !== 'string' || typeof scope !== 'string') return null;
  return { route, category: category as NotificationCategory, scope };
}
