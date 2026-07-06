import * as Notifications from 'expo-notifications';
import { Account, Bill, RecurringItem, RepaymentSuggestion, Transaction } from '@/api/generated/types';
import { kv } from '@/lib/storage';
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
  repaySnapshot: 'notif.repaySnapshot.v2',
  // v2: reset baselines once — demo-mode toggling polluted the v1 snapshots and
  // could fire spurious "new subscription"/large-charge alerts. v2 re-seeds
  // silently from real data on the first non-demo run.
  lastSeenTxn: 'notif.lastSeenTxn.v2',
  subSnapshot: 'notif.subSnapshot.v2',
  lowBalSnapshot: 'notif.lowBalSnapshot.v2',
} as const;

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
  };
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

async function present(title: string, body: string) {
  await Notifications.scheduleNotificationAsync({ content: { title, body }, trigger: null });
}

const cap = (s: string) => (s ? s.charAt(0).toUpperCase() + s.slice(1) : s);

// Re-lay-out all *scheduled* notifications (bills + weekly digest). Cleanly
// cancels everything scheduled and rebuilds, so it's safe to call on every load.
export async function rescheduleScheduled(bills: Bill[], settings: NotifSettings) {
  if (!(await hasPermission())) return;
  await Notifications.cancelAllScheduledNotificationsAsync();

  if (settings.bills) {
    const seen = new Set<string>();
    let n = 0;
    for (const b of bills) {
      if (n >= 20) break;
      const id = `${b.key}-${b.dueDate}`;
      if (seen.has(id)) continue;
      seen.add(id);
      const [y, m, d] = b.dueDate.split('-').map(Number);
      const remind = new Date(y, m - 1, d - 1, 9, 0, 0); // 9am the day before
      if (remind.getTime() <= Date.now()) continue;
      await Notifications.scheduleNotificationAsync({
        content: { title: `${cap(b.payee)} bill due tomorrow`, body: `${fmtPos(b.amount)} · ${b.category}` },
        trigger: { type: Notifications.SchedulableTriggerInputTypes.DATE, date: remind },
      });
      n++;
    }
  }

  if (settings.weekly) {
    await Notifications.scheduleNotificationAsync({
      content: { title: 'Your weekly money check-in', body: 'Open DarkFinances to review this week.' },
      trigger: { type: Notifications.SchedulableTriggerInputTypes.WEEKLY, weekday: 1, hour: 9, minute: 0 },
    });
  }
}

// Fire an immediate alert for any new large charge since the last run.
export async function checkLargeCharges(txns: Transaction[], settings: NotifSettings) {
  if (!settings.largeCharge || !(await hasPermission()) || !txns.length) return;
  const newest = txns.reduce((mx, t) => (t.date > mx ? t.date : mx), '0000-00-00');
  const lastSeen = kv.getString(NOTIF.lastSeenTxn);
  if (!lastSeen) {
    kv.setString(NOTIF.lastSeenTxn, newest); // baseline; don't fire on historical data
    return;
  }
  const fresh = txns.filter((t) => t.date > lastSeen && t.amount < 0 && Math.abs(t.amount) >= settings.threshold);
  if (fresh.length) {
    const top = fresh.reduce((a, b) => (Math.abs(b.amount) > Math.abs(a.amount) ? b : a));
    const extra = fresh.length > 1 ? ` (+${fresh.length - 1} more)` : '';
    await present('Large charge detected', `${fmtPos(Math.abs(top.amount))} at ${top.payee || 'unknown'}${extra}`);
  }
  if (newest > lastSeen) kv.setString(NOTIF.lastSeenTxn, newest);
}

// Alert when an on-budget cash account newly drops below the threshold. A
// snapshot of already-low account ids prevents re-alerting on every app open
// until the balance recovers above the limit.
export async function checkLowBalances(accounts: Account[], settings: NotifSettings) {
  if (!settings.lowBalance || !(await hasPermission()) || !accounts.length) return;
  const limit = settings.lowBalanceThreshold;
  const low = accounts.filter((a) => !a.offbudget && a.balance >= 0 && a.balance < limit);
  const lowIds = low.map((a) => a.id);
  const raw = kv.getString(NOTIF.lowBalSnapshot);
  if (raw == null) {
    kv.setString(NOTIF.lowBalSnapshot, JSON.stringify(lowIds)); // baseline; don't fire on first run
    return;
  }
  let prev: string[] = [];
  try { prev = JSON.parse(raw); } catch { prev = []; }
  const fresh = low.filter((a) => !prev.includes(a.id));
  if (fresh.length) {
    const worst = fresh.reduce((a, b) => (b.balance < a.balance ? b : a));
    const extra = fresh.length > 1 ? ` (+${fresh.length - 1} more)` : '';
    await present('Low balance', `${worst.name} is at ${fmtPos(worst.balance)}${extra}`);
  }
  kv.setString(NOTIF.lowBalSnapshot, JSON.stringify(lowIds));
}

// Alert when a new repayment suggestion appears (an incoming payment that likely
// settles what someone owes). Snapshots suggested inflow ids so each is announced once.
export async function checkRepaymentSuggestions(suggestions: RepaymentSuggestion[], settings: NotifSettings) {
  if (!settings.repayments || !(await hasPermission())) return;
  const ids = suggestions.map((s) => s.inflow.id);
  const raw = kv.getString(NOTIF.repaySnapshot);
  if (raw == null) {
    kv.setString(NOTIF.repaySnapshot, JSON.stringify(ids)); // baseline; don't fire on first run
    return;
  }
  let prev: string[] = [];
  try { prev = JSON.parse(raw); } catch { prev = []; }
  const fresh = suggestions.filter((s) => !prev.includes(s.inflow.id));
  if (fresh.length) {
    const top = fresh[0];
    const extra = fresh.length > 1 ? ` (+${fresh.length - 1} more)` : '';
    await present('Repayment to review', `${fmtPos(top.inflow.amount)} from ${cap(top.person)} may settle what they owe${extra}`);
  }
  kv.setString(NOTIF.repaySnapshot, JSON.stringify(ids));
}

// Fire an immediate alert when a previously-unseen active subscription appears.
export async function checkNewSubscriptions(items: RecurringItem[], settings: NotifSettings) {
  if (!settings.newSub || !(await hasPermission())) return;
  const activeKeys = items.filter((i) => i.status === 'active').map((i) => i.key);
  const raw = kv.getString(NOTIF.subSnapshot);
  if (!raw) {
    kv.setString(NOTIF.subSnapshot, JSON.stringify(activeKeys));
    return;
  }
  let prev: string[] = [];
  try { prev = JSON.parse(raw); } catch { prev = []; }
  const fresh = activeKeys.filter((k) => !prev.includes(k));
  if (fresh.length) {
    const names = items.filter((i) => fresh.includes(i.key)).map((i) => cap(i.payee));
    const extra = names.length > 1 ? ` (+${names.length - 1} more)` : '';
    await present('New subscription detected', `${names[0]}${extra}`);
  }
  kv.setString(NOTIF.subSnapshot, JSON.stringify(activeKeys));
}
