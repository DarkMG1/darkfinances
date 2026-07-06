import { useEffect } from 'react';
import { useAccounts, useBills, useRecurring, useRepaymentSuggestions, useTransactions } from '@/api/hooks/finance.hooks';
import { checkLargeCharges, checkLowBalances, checkNewSubscriptions, checkRepaymentSuggestions, getNotifSettings, rescheduleScheduled } from '@/lib/notifications';
import { useServerConfig } from '@/state/server';

function startOfPrevMonth(): string {
  const n = new Date();
  const d = new Date(n.getFullYear(), n.getMonth() - 1, 1);
  return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-01`;
}

// Invisible: re-lays out local notifications whenever the app is open with
// fresh data. Mounted once inside the authenticated tab navigator.
// In demo mode it stays fully inert — synthetic data must never fire alerts or
// touch the real-data baselines (snapshots/last-seen).
export function NotificationScheduler() {
  const { demo } = useServerConfig();
  const accounts = useAccounts();
  const bills = useBills();
  const recurring = useRecurring();
  const repayments = useRepaymentSuggestions();
  const txns = useTransactions({ start: startOfPrevMonth() });

  useEffect(() => {
    if (demo) return;
    if (bills.data) rescheduleScheduled(bills.data.bills, getNotifSettings());
  }, [bills.data, demo]);

  useEffect(() => {
    if (demo) return;
    if (txns.data) checkLargeCharges(txns.data, getNotifSettings());
  }, [txns.data, demo]);

  useEffect(() => {
    if (demo) return;
    if (recurring.data) checkNewSubscriptions(recurring.data.items, getNotifSettings());
  }, [recurring.data, demo]);

  useEffect(() => {
    if (demo) return;
    if (accounts.data) checkLowBalances(accounts.data, getNotifSettings());
  }, [accounts.data, demo]);

  useEffect(() => {
    if (demo) return;
    if (repayments.data) checkRepaymentSuggestions(repayments.data.suggestions, getNotifSettings());
  }, [repayments.data, demo]);

  return null;
}
