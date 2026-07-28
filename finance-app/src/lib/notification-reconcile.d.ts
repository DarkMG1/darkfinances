import type { CategoryScheduleState } from '@/lib/notification-scheduled-stage';
import type { NotificationReconciliationToken } from '@/lib/notification-reconciliation';

export interface NotificationReconcilerSettings {
  bills: boolean;
  largeCharge: boolean;
  newSub: boolean;
  weekly: boolean;
  lowBalance: boolean;
  repayments: boolean;
  threshold: number;
  lowBalanceThreshold: number;
  privacy: string;
}

export interface NotificationReconcilerDeps {
  notifications: Record<string, unknown>;
  kv: Record<string, unknown>;
  storage: Record<string, unknown>;
  assertReconciliationCurrent: (token: NotificationReconciliationToken) => void;
  withReconciliationGuard: <T>(token: NotificationReconciliationToken, fn: () => Promise<T> | T) => Promise<T>;
  classifyBillReminder: (bill: unknown, now?: number, scope?: string, financeToday?: string) => unknown;
  buildBillNotificationContent: (bill: unknown, kind: string, privacy: string) => { title: string; body: string };
  buildLargeChargeNotificationContent: (top: unknown, extra: number, privacy: string) => { title: string; body: string };
  buildLowBalanceNotificationContent: (account: unknown, extra: number, privacy: string) => { title: string; body: string };
  buildRepaymentNotificationContent: (suggestion: unknown, extra: number, privacy: string) => { title: string; body: string };
  buildSubscriptionNotificationContent: (names: string[], privacy: string) => { title: string; body: string };
  isCashAccount: (account: unknown) => boolean;
  onStageEvent?: (event: string, context: Record<string, unknown>) => void | Promise<void>;
  /** Wall-clock source for bill reminder classification; defaults to Date.now. */
  nowMs?: () => number;
}

export interface ScheduledNotificationReconcileInput {
  token: NotificationReconciliationToken;
  scope: string;
  settings: NotificationReconcilerSettings;
  bills?: unknown[];
  billsReady?: boolean;
  financeToday?: string;
}

export interface EventNotificationReconcileInput {
  token: NotificationReconciliationToken;
  scope: string;
  settings: NotificationReconcilerSettings;
  transactions?: unknown[];
  accounts?: unknown[];
  recurring?: unknown[];
  repayments?: unknown[];
}

export const NOTIFICATION_ROUTES: {
  readonly bills: '/bills';
  readonly largeCharge: '/(tabs)/transactions';
  readonly newSub: '/subscriptions';
  readonly weekly: '/review';
  readonly lowBalance: '/networth';
  readonly repayments: '/reimbursement';
};

export type NotificationCategory = keyof typeof NOTIFICATION_ROUTES;

export type NotificationRoute = typeof NOTIFICATION_ROUTES[NotificationCategory];

export interface NotificationRoutePayload {
  route: NotificationRoute;
  category: NotificationCategory;
  scope: string;
}

export interface NotificationReconciler {
  reconcileScheduledNotifications: (input: ScheduledNotificationReconcileInput) => Promise<void>;
  reconcileEventNotifications: (input: EventNotificationReconcileInput) => Promise<void>;
  purgeNotificationProfileState: (scope?: string) => Promise<void>;
  clearNotificationRoutingState: () => void;
  dismissDeliveredNotificationsForScope: (scope?: string) => Promise<void>;
  migrateLegacyScheduledNotifications: (token: NotificationReconciliationToken) => Promise<boolean>;
  parseNotificationRoute: (data: unknown) => NotificationRoutePayload | null;
  readTrackedScheduledIds: (scope: string) => Record<string, unknown>;
  readCategoryScheduleState: (scope: string, category: NotificationCategory) => CategoryScheduleState;
  readCommittedScheduledIds: (scope: string, category: NotificationCategory) => string[];
  convergeCategorySchedules: (scope: string, category: NotificationCategory) => Promise<CategoryScheduleState>;
  readNotificationStatus: (scope: string) => {
    permissionGranted: boolean | null;
    scheduledCount: number;
    lastRefresh: Partial<Record<NotificationCategory, string>>;
  };
}

export function createNotificationReconciler(deps: NotificationReconcilerDeps): NotificationReconciler;

export function parseNotificationRoute(data: unknown): NotificationRoutePayload | null;

export function isFinanceScheduledNotification(notification: unknown): boolean;
