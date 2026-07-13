import { useEffect } from 'react';
import { useAccounts, useBills, useRecurring, useRepaymentSuggestions, useTransactions } from '@/api/hooks/finance.hooks';
import {
  checkLargeCharges,
  checkLowBalances,
  checkNewSubscriptions,
  checkRepaymentSuggestions,
  NotifSettings,
  rescheduleScheduled,
  resetNotificationBaseline,
  useNotifSettings,
} from '@/lib/notifications';
import { financeToday, previousMonth } from '@/lib/date-only';
import { useServerConfig } from '@/state/server';

function startOfPrevMonth(): string {
  return `${previousMonth(financeToday().slice(0, 7))}-01`;
}

function BillScheduler({ settings, scope }: { settings: NotifSettings; scope: string }) {
  const bills = useBills();
  useEffect(() => {
    if (bills.data) void rescheduleScheduled(bills.data.bills, settings, scope).catch(() => {});
  }, [bills.data, scope, settings]);
  return null;
}

function LargeChargeWatcher({ settings, scope }: { settings: NotifSettings; scope: string }) {
  const txns = useTransactions({ start: startOfPrevMonth() });
  useEffect(() => {
    if (txns.data) void checkLargeCharges(txns.data, settings, scope).catch(() => {});
  }, [scope, settings, txns.data]);
  return null;
}

function LowBalanceWatcher({ settings, scope }: { settings: NotifSettings; scope: string }) {
  const accounts = useAccounts();
  useEffect(() => {
    if (accounts.data) void checkLowBalances(accounts.data, settings, scope).catch(() => {});
  }, [accounts.data, scope, settings]);
  return null;
}

function SubscriptionWatcher({ settings, scope }: { settings: NotifSettings; scope: string }) {
  const recurring = useRecurring();
  useEffect(() => {
    if (recurring.data) void checkNewSubscriptions(recurring.data.items, settings, scope).catch(() => {});
  }, [recurring.data, scope, settings]);
  return null;
}

function RepaymentWatcher({ settings, scope }: { settings: NotifSettings; scope: string }) {
  const repayments = useRepaymentSuggestions();
  useEffect(() => {
    if (repayments.data) void checkRepaymentSuggestions(repayments.data.suggestions, settings, scope).catch(() => {});
  }, [repayments.data, scope, settings]);
  return null;
}

// Invisible: re-lays out local notifications whenever the app is open with
// fresh data. Mounted once inside the authenticated tab navigator.
// In demo mode it stays fully inert — synthetic data must never fire alerts or
// touch the real-data baselines (snapshots/last-seen).
export function NotificationScheduler() {
  const { demo, scope } = useServerConfig();
  const settings = useNotifSettings();

  if (demo) return null;

  return (
    <>
      {settings.bills ? <BillScheduler settings={settings} scope={scope} /> : null}
      {settings.largeCharge ? <LargeChargeWatcher settings={settings} scope={scope} /> : null}
      {settings.lowBalance ? <LowBalanceWatcher settings={settings} scope={scope} /> : null}
      {settings.newSub ? <SubscriptionWatcher settings={settings} scope={scope} /> : null}
      {settings.repayments ? <RepaymentWatcher settings={settings} scope={scope} /> : null}
    </>
  );
}

export { resetNotificationBaseline };
