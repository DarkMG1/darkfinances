import { useEffect, useRef, useSyncExternalStore } from 'react';
import { Platform } from 'react-native';
import { useAccounts, useBills, useManualAssets, useToday, useTrends } from '@/api/hooks/finance.hooks';
import { getFinanceCapabilities } from '@/lib/capabilities';
import { resolveWidgetNetWorthDecision } from '@/lib/account-metrics';
import { clearFinanceWidget, pushFinanceWidget } from '@/lib/widgets';
import {
  getProfileGeneration,
  subscribeProfileGeneration,
} from '@/lib/notification-reconciliation';
import { useServerConfig } from '@/state/server';
import { useFinanceToday } from '@/lib/date-only';
import { dueLabel, fmtMoney, fmtPos } from '@/theme/colors';

// Invisible: pushes a fresh snapshot to the home-screen widget whenever the app
// is open with current data. Mounted once inside the authenticated tab navigator.
export function WidgetSync() {
  const financeToday = useFinanceToday();
  const capabilities = getFinanceCapabilities();
  const { demo, scope } = useServerConfig();
  const profileGeneration = useSyncExternalStore(
    subscribeProfileGeneration,
    getProfileGeneration,
    getProfileGeneration,
  );
  const accounts = useAccounts({ enabled: capabilities.widgets && !demo });
  const today = useToday();
  const bills = useBills(undefined, { enabled: capabilities.widgets && !demo });
  const trends = useTrends(12, { enabled: capabilities.widgets && !demo });
  const manual = useManualAssets({ enabled: capabilities.widgets && !demo });
  const widgetScopeRef = useRef<string | null>(null);
  const widgetGenerationRef = useRef<number | null>(null);

  useEffect(() => () => {
    if (capabilities.widgets) clearFinanceWidget();
  }, [capabilities.widgets]);

  useEffect(() => {
    if (!capabilities.widgets || Platform.OS !== 'ios') return;
    if (demo) {
      clearFinanceWidget();
      widgetScopeRef.current = scope;
      widgetGenerationRef.current = profileGeneration;
      return;
    }

    const months = (trends.data?.months ?? []).filter((m) => m.netWorth != null);
    const prevTrendNetWorth = months.length >= 2 ? months[months.length - 2].netWorth ?? null : null;
    const decision = resolveWidgetNetWorthDecision({
      todayLoading: today.isLoading,
      todaySettled: !today.isLoading && (today.isSuccess || today.isError),
      todayError: today.isError,
      profileGeneration,
      widgetProfileGeneration: widgetGenerationRef.current,
      scope,
      widgetScope: widgetScopeRef.current,
      serverMetric: today.data?.metrics?.netWorth,
      accounts: accounts.data ?? null,
      manual: manual.data,
      prevTrendNetWorth,
    });

    if (decision.action === 'wait') return;

    if (decision.action === 'clear') {
      clearFinanceWidget();
      widgetScopeRef.current = scope;
      widgetGenerationRef.current = profileGeneration;
      return;
    }

    const changeDiff = decision.changeDiff;
    const change = changeDiff != null
      ? `${changeDiff >= 0 ? '+' : '-'}${fmtPos(Math.abs(changeDiff))} this mo`
      : '';
    const nextBill = (bills.data?.bills ?? []).find((b) => !b.paid);
    pushFinanceWidget({
      netWorth: fmtMoney(decision.netWorth!),
      change,
      changeUp: changeDiff == null ? true : changeDiff >= 0,
      billPayee: nextBill ? nextBill.payee : 'All caught up',
      billAmount: nextBill ? fmtPos(nextBill.amount) : '',
      billDue: nextBill ? dueLabel(nextBill.dueDate, financeToday) : 'No bills due',
    });
    widgetScopeRef.current = scope;
    widgetGenerationRef.current = profileGeneration;
  }, [
    accounts.data,
    bills.data,
    capabilities.widgets,
    demo,
    financeToday,
    manual.data,
    profileGeneration,
    scope,
    today.data,
    today.isError,
    today.isLoading,
    today.isSuccess,
    trends.data,
  ]);

  return null;
}
