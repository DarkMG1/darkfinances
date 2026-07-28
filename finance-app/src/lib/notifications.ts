import { useMemo, useSyncExternalStore } from 'react';
import * as Notifications from 'expo-notifications';
import { Account, Bill, RecurringItem, RepaymentSuggestion, Transaction } from '@/api/generated/types';
import { type NotificationReconciliationToken } from '@/lib/notification-reconciliation';
import { createNotificationReconciler, NOTIFICATION_ROUTES, type NotificationCategory, type NotificationReconcilerDeps } from '@/lib/notification-reconcile';
import { classifyBillReminder as classifyBillReminderCore } from '@/lib/notification-scheduling';
import { kv, storage } from '@/lib/storage';
import { fmtPos } from '@/theme/colors';
import {
  assertReconciliationCurrent,
  withReconciliationGuard,
} from '@/lib/notification-reconciliation';

// On-device (local) notifications only — no server push, no APNs entitlement.

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
  status: 'notif.status.v2',
  scheduledIds: 'notif.scheduledIds.v1',
  legacyMigration: 'notif.legacyScheduleMigration.v1',
  repaySnapshot: 'notif.repaySnapshot.v2',
  lastSeenTxn: 'notif.lastSeenTxnIds.v3',
  subSnapshot: 'notif.subSnapshot.v2',
  lowBalSnapshot: 'notif.lowBalSnapshot.v2',
} as const;

export type NotificationPrivacy = 'private' | 'detailed';
export type { NotificationCategory } from '@/lib/notification-reconcile';
export type BillReminderKind = 'dayBefore' | 'sameDayLate' | 'overdue';

export { NOTIFICATION_ROUTES };

export interface NotificationRoutePayload {
  route: (typeof NOTIFICATION_ROUTES)[NotificationCategory];
  category: NotificationCategory;
  scope: string;
}

export interface BillReminderPlan {
  kind: BillReminderKind;
  triggerDate: Date | null;
  sameDayKey: string | null;
}

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

export interface ScheduledNotificationReconcileInput {
  token: NotificationReconciliationToken;
  scope: string;
  settings: NotifSettings;
  bills?: Bill[];
  billsReady?: boolean;
  financeToday?: string;
}

export interface EventNotificationReconcileInput {
  token: NotificationReconciliationToken;
  scope: string;
  settings: NotifSettings;
  transactions?: Transaction[];
  accounts?: Account[];
  recurring?: RecurringItem[];
  repayments?: RepaymentSuggestion[];
}

export interface NotificationStatus {
  permissionGranted: boolean | null;
  scheduledCount: number;
  lastRefresh: Partial<Record<NotificationCategory, string>>;
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
const cap = (s: string) => (s ? s.charAt(0).toUpperCase() + s.slice(1) : s);

export const DEFAULT_THRESHOLD = 200;
export const DEFAULT_LOW_BALANCE = 100;

const notificationReconciler = createNotificationReconciler({
  notifications: Notifications,
  kv,
  storage,
  assertReconciliationCurrent,
  withReconciliationGuard,
  classifyBillReminder: classifyBillReminderCore,
  buildBillNotificationContent,
  buildLargeChargeNotificationContent,
  buildLowBalanceNotificationContent,
  buildRepaymentNotificationContent,
  buildSubscriptionNotificationContent,
  isCashAccount,
} as unknown as NotificationReconcilerDeps);

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

function readScopedStatus(scope: string): NotificationStatus {
  const raw = kv.getString(scopedKey(NOTIF.status, scope));
  if (!raw) return { permissionGranted: null, scheduledCount: 0, lastRefresh: {} };
  try {
    return JSON.parse(raw) as NotificationStatus;
  } catch {
    return { permissionGranted: null, scheduledCount: 0, lastRefresh: {} };
  }
}

export function getNotificationStatus(scope: string): NotificationStatus {
  return readScopedStatus(scope);
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

export function clearNotificationRoutingState(): void {
  notificationReconciler.clearNotificationRoutingState();
}

export async function dismissDeliveredNotificationsForScope(scope?: string): Promise<void> {
  await notificationReconciler.dismissDeliveredNotificationsForScope(scope);
}

export async function purgeNotificationProfileState(scope?: string): Promise<void> {
  await notificationReconciler.purgeNotificationProfileState(scope);
}

export async function clearFinanceNotifications(scope?: string): Promise<void> {
  await purgeNotificationProfileState(scope);
}

export async function reconcileScheduledNotifications(input: ScheduledNotificationReconcileInput): Promise<void> {
  await notificationReconciler.reconcileScheduledNotifications(input);
}

export async function reconcileEventNotifications(input: EventNotificationReconcileInput): Promise<void> {
  await notificationReconciler.reconcileEventNotifications(input);
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
      if (storageKey.startsWith(`notif.billSameDay.v2.${scope}.`)) storage.remove(storageKey);
    }
  }
}

export function isCashAccount(account: Account): boolean {
  return !account.offbudget && !account.hidden && account.role === 'operating_cash';
}

export function classifyBillReminder(
  bill: Bill,
  now = Date.now(),
  scope = 'default',
  financeToday?: string,
): BillReminderPlan | null {
  return classifyBillReminderCore(bill, now, scope, financeToday);
}

export function buildBillNotificationContent(
  bill: Bill,
  kind: BillReminderKind,
  privacy: NotificationPrivacy,
): { title: string; body: string } {
  if (privacy === 'private') {
    const title = kind === 'overdue'
      ? 'Bill overdue'
      : kind === 'sameDayLate'
        ? 'Bill due today'
        : 'Bill due tomorrow';
    return {
      title,
      body: 'Open DarkFinances to review upcoming bills.',
    };
  }
  const when = kind === 'overdue'
    ? 'overdue'
    : kind === 'sameDayLate'
      ? 'today'
      : 'tomorrow';
  return {
    title: `${cap(bill.payee)} bill due ${when}`,
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
      body: 'Open DarkFinances to review recent activity.',
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

export function parseNotificationRoute(data: unknown): NotificationRoutePayload | null {
  const payload = notificationReconciler.parseNotificationRoute(data);
  if (!payload) return null;
  return {
    route: payload.route,
    category: payload.category as NotificationCategory,
    scope: payload.scope,
  };
}

export { createNotificationReconciler } from '@/lib/notification-reconcile';
