import { useEffect } from 'react';
import { useAccounts, useBills, useRecurring, useRepaymentSuggestions, useTransactions } from '@/api/hooks/finance.hooks';
import { checkLargeCharges, checkLowBalances, checkNewSubscriptions, checkRepaymentSuggestions, rescheduleScheduled, useNotifSettings } from '@/lib/notifications';
import { financeToday, previousMonth } from '@/lib/date-only';
import { useServerConfig } from '@/state/server';

function startOfPrevMonth(): string {
  return `${previousMonth(financeToday().slice(0, 7))}-01`;
}

// Invisible: re-lays out local notifications whenever the app is open with
// fresh data. Mounted once inside the authenticated tab navigator.
// In demo mode it stays fully inert — synthetic data must never fire alerts or
// touch the real-data baselines (snapshots/last-seen).
export function NotificationScheduler() {
  const { demo, scope } = useServerConfig();
  const settings = useNotifSettings();
  const accounts = useAccounts();
  const bills = useBills();
  const recurring = useRecurring();
  const repayments = useRepaymentSuggestions();
  const txns = useTransactions({ start: startOfPrevMonth() });

  useEffect(() => {
    if (demo) return;
    if (bills.data) void rescheduleScheduled(bills.data.bills, settings).catch(() => {});
  }, [bills.data, demo, settings]);

  useEffect(() => {
    if (demo) return;
    if (txns.data) void checkLargeCharges(txns.data, settings, scope).catch(() => {});
  }, [txns.data, demo, scope, settings]);

  useEffect(() => {
    if (demo) return;
    if (recurring.data) void checkNewSubscriptions(recurring.data.items, settings, scope).catch(() => {});
  }, [recurring.data, demo, scope, settings]);

  useEffect(() => {
    if (demo) return;
    if (accounts.data) void checkLowBalances(accounts.data, settings, scope).catch(() => {});
  }, [accounts.data, demo, scope, settings]);

  useEffect(() => {
    if (demo) return;
    if (repayments.data) void checkRepaymentSuggestions(repayments.data.suggestions, settings, scope).catch(() => {});
  }, [repayments.data, demo, scope, settings]);

  return null;
}
