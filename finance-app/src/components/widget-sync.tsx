import { useEffect } from 'react';
import { Platform } from 'react-native';
import { useAccounts, useBills, useManualAssets, useToday, useTrends } from '@/api/hooks/finance.hooks';
import { getFinanceCapabilities } from '@/lib/capabilities';
import { computeFallbackNetWorth, hasServerMetric, resolveMoneyMetric } from '@/lib/account-metrics';
import { clearFinanceWidget, pushFinanceWidget } from '@/lib/widgets';
import { useServerConfig } from '@/state/server';
import { useFinanceToday } from '@/lib/date-only';
import { dueLabel, fmtMoney, fmtPos } from '@/theme/colors';

// Invisible: pushes a fresh snapshot to the home-screen widget whenever the app
// is open with current data. Mounted once inside the authenticated tab navigator.
export function WidgetSync() {
  const financeToday = useFinanceToday();
  const capabilities = getFinanceCapabilities();
  const { demo } = useServerConfig();
  const accounts = useAccounts({ enabled: capabilities.widgets && !demo });
  const today = useToday();
  const bills = useBills(undefined, { enabled: capabilities.widgets && !demo });
  const trends = useTrends(12, { enabled: capabilities.widgets && !demo });
  const manual = useManualAssets({ enabled: capabilities.widgets && !demo });

  useEffect(() => () => {
    if (capabilities.widgets) clearFinanceWidget();
  }, [capabilities.widgets]);

  useEffect(() => {
    if (!capabilities.widgets || Platform.OS !== 'ios') return;
    if (demo) {
      clearFinanceWidget();
      return;
    }
    const accts = accounts.data;
    if (!accts) return;
    const serverMetric = today.data?.metrics?.netWorth;
    if (hasServerMetric(serverMetric) && serverMetric?.complete === false) return;

    const fallbackNetWorth = computeFallbackNetWorth(accts, manual.data);
    const resolvedNetWorth = resolveMoneyMetric(serverMetric, fallbackNetWorth);
    if (resolvedNetWorth.unavailable) return;

    const netWorth = resolvedNetWorth.authoritative && resolvedNetWorth.value != null
      ? resolvedNetWorth.value
      : (resolvedNetWorth.value ?? fallbackNetWorth);

    const months = (trends.data?.months ?? []).filter((m) => m.netWorth != null);
    let change = '';
    let changeUp = true;
    if (months.length >= 2 && months[months.length - 2].netWorth != null) {
      const prevNW = months[months.length - 2].netWorth as number;
      const diff = netWorth - prevNW;
      changeUp = diff >= 0;
      change = `${diff >= 0 ? '+' : '-'}${fmtPos(diff)} this mo`;
    }

    const nextBill = (bills.data?.bills ?? []).find((b) => !b.paid);
    pushFinanceWidget({
      netWorth: fmtMoney(netWorth),
      change,
      changeUp,
      billPayee: nextBill ? nextBill.payee : 'All caught up',
      billAmount: nextBill ? fmtPos(nextBill.amount) : '',
      billDue: nextBill ? dueLabel(nextBill.dueDate, financeToday) : 'No bills due',
    });
  }, [accounts.data, bills.data, capabilities.widgets, demo, financeToday, manual.data, today.data, trends.data]);

  return null;
}
