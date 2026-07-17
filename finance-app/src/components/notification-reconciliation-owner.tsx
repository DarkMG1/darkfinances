import { useEffect, useMemo, useRef, useSyncExternalStore } from 'react';
import {
  useAccounts,
  useBills,
  useRecurring,
  useRepaymentSuggestions,
  useTransactions,
} from '@/api/hooks/finance.hooks';
import { getFinanceCapabilities } from '@/lib/capabilities';
import { previousMonth, useFinanceToday } from '@/lib/date-only';
import { isNotificationReconciliationActive } from '@/lib/notification-reconciliation-active';
import { recordFinanceOperationReconciliationError } from '@/lib/finance-operations';
import {
  beginReconciliation,
  cancelReconciliation,
  endReconciliation,
  getProfileGeneration,
  isExpectedReconciliationError,
  isNotificationScopeAdmissionAllowed,
  subscribeProfileGeneration,
} from '@/lib/notification-reconciliation';
import { reportUnexpectedReconciliationError } from '@/lib/notification-reconciliation-errors';
import {
  reconcileEventNotifications,
  reconcileScheduledNotifications,
  useNotifSettings,
} from '@/lib/notifications';
import { useServerConfig } from '@/state/server';

function handleReconciliationError(error: unknown) {
  if (isExpectedReconciliationError(error)) return;
  reportUnexpectedReconciliationError(error, recordFinanceOperationReconciliationError);
}

export function NotificationReconciliationOwner() {
  const capabilities = getFinanceCapabilities();
  const { configured, demo, scope } = useServerConfig();
  const notificationsActive = isNotificationReconciliationActive({
    configured,
    demo,
    notificationsCapable: capabilities.notifications,
  });
  const profileGeneration = useSyncExternalStore(
    subscribeProfileGeneration,
    getProfileGeneration,
    getProfileGeneration,
  );
  const settings = useNotifSettings();
  const financeToday = useFinanceToday();
  const transactionWindowStart = useMemo(
    () => `${previousMonth(financeToday.slice(0, 7))}-01`,
    [financeToday],
  );
  const activeScopeRef = useRef(scope);
  const scheduledTokenRef = useRef<ReturnType<typeof beginReconciliation> | null>(null);
  const eventTokenRef = useRef<ReturnType<typeof beginReconciliation> | null>(null);

  const bills = useBills(undefined, { enabled: notificationsActive && settings.bills });
  const txns = useTransactions(
    { start: transactionWindowStart },
    { enabled: notificationsActive && settings.largeCharge },
  );
  const accounts = useAccounts({ enabled: notificationsActive && settings.lowBalance });
  const recurring = useRecurring(undefined, { enabled: notificationsActive && settings.newSub });
  const repayments = useRepaymentSuggestions({
    enabled: notificationsActive && settings.repayments,
  });

  useEffect(() => {
    activeScopeRef.current = scope;
  }, [scope]);

  useEffect(() => {
    if (!notificationsActive) return;

    const scopeNow = activeScopeRef.current;
    if (!isNotificationScopeAdmissionAllowed(scopeNow)) return;

    const token = beginReconciliation('scheduled', profileGeneration, scopeNow);
    scheduledTokenRef.current = token;
    void reconcileScheduledNotifications({
      token,
      scope: activeScopeRef.current,
      settings,
      bills: bills.data?.bills,
      billsReady: bills.isSuccess && Array.isArray(bills.data?.bills),
      financeToday,
    }).catch(handleReconciliationError).finally(() => {
      endReconciliation(token);
      if (scheduledTokenRef.current === token) scheduledTokenRef.current = null;
    });

    return () => {
      if (scheduledTokenRef.current) cancelReconciliation(scheduledTokenRef.current);
    };
  }, [
    bills.data,
    bills.isSuccess,
    financeToday,
    notificationsActive,
    profileGeneration,
    scope,
    settings,
    settings.bills,
    settings.weekly,
    settings.privacy,
  ]);

  useEffect(() => {
    if (!notificationsActive) return;

    const scopeNow = activeScopeRef.current;
    if (!isNotificationScopeAdmissionAllowed(scopeNow)) return;

    const token = beginReconciliation('event', profileGeneration, scopeNow);
    eventTokenRef.current = token;
    void reconcileEventNotifications({
      token,
      scope: activeScopeRef.current,
      settings,
      transactions: txns.data,
      accounts: accounts.data,
      recurring: recurring.data?.items,
      repayments: repayments.data?.suggestions,
    }).catch(handleReconciliationError).finally(() => {
      endReconciliation(token);
      if (eventTokenRef.current === token) eventTokenRef.current = null;
    });

    return () => {
      if (eventTokenRef.current) cancelReconciliation(eventTokenRef.current);
    };
  }, [
    accounts.data,
    financeToday,
    notificationsActive,
    profileGeneration,
    recurring.data,
    repayments.data,
    scope,
    settings,
    settings.largeCharge,
    settings.lowBalance,
    settings.lowBalanceThreshold,
    settings.newSub,
    settings.repayments,
    settings.threshold,
    settings.privacy,
    transactionWindowStart,
    txns.data,
  ]);

  return null;
}
