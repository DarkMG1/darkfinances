import { useCallback, useMemo, useState } from 'react';
import { kv } from '@/lib/storage';

export const DASHBOARD_WIDGETS = [
  { key: 'netWorth', label: 'Net Worth' },
  { key: 'safeToSpend', label: 'Safe to Spend' },
  { key: 'review', label: "Today's Review" },
  { key: 'actions', label: 'Quick Actions' },
  { key: 'monthlyStats', label: 'Monthly Stats' },
  { key: 'income', label: 'Next Income' },
  { key: 'subscriptions', label: 'Subscriptions' },
  { key: 'bills', label: 'Upcoming Bills' },
  { key: 'accounts', label: 'Accounts' },
] as const;

export type DashboardWidgetKey = (typeof DASHBOARD_WIDGETS)[number]['key'];
const keyFor = (key: DashboardWidgetKey) => `dashboard_widget_${key}`;

export function getDashboardWidgetVisible(key: DashboardWidgetKey) {
  return kv.getBool(keyFor(key), true);
}

export function setDashboardWidgetVisible(key: DashboardWidgetKey, visible: boolean) {
  kv.setBool(keyFor(key), visible);
}

export function useDashboardWidgets() {
  const [version, setVersion] = useState(0);
  const visible = useMemo(() => {
    const out = {} as Record<DashboardWidgetKey, boolean>;
    for (const w of DASHBOARD_WIDGETS) out[w.key] = getDashboardWidgetVisible(w.key);
    return out;
  }, [version]);
  const setVisible = useCallback((key: DashboardWidgetKey, next: boolean) => {
    setDashboardWidgetVisible(key, next);
    setVersion((v) => v + 1);
  }, []);
  return { visible, setVisible };
}
