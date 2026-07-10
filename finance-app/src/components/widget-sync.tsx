import { useEffect } from 'react';
import { Platform } from 'react-native';
import { useAccounts, useBills, useManualAssets, useTrends } from '@/api/hooks/finance.hooks';
import { useServerConfig } from '@/state/server';
import { dueLabel, fmtMoney, fmtPos } from '@/theme/colors';

type WidgetPayload = {
  netWorth: string;
  change: string;
  changeUp: boolean;
  billPayee: string;
  billAmount: string;
  billDue: string;
};

// Lazy + guarded: the expo-widgets native module only exists in a build made
// after adding the widget (rebuild + sideload). On any older build the require
// throws at load (createWidget touches native), so we swallow it and no-op.
function pushWidget(payload: WidgetPayload): void {
  try {
    // eslint-disable-next-line @typescript-eslint/no-require-imports
    const mod = require('../widgets/FinanceWidget') as typeof import('../widgets/FinanceWidget');
    mod.updateFinanceWidget(payload);
  } catch {
    /* widget native module unavailable on this build — ignore */
  }
}

function clearWidget(): void {
  pushWidget({
    netWorth: '—',
    change: '',
    changeUp: true,
    billPayee: 'Open DarkFinances',
    billAmount: '',
    billDue: 'Connect to refresh',
  });
}

// Invisible: pushes a fresh snapshot to the home-screen widget whenever the app
// is open with current data. Mounted once inside the authenticated tab navigator.
export function WidgetSync() {
  const { demo } = useServerConfig();
  const accounts = useAccounts();
  const bills = useBills();
  const trends = useTrends(12);
  const manual = useManualAssets();

  useEffect(() => () => clearWidget(), []);

  useEffect(() => {
    if (Platform.OS !== 'ios') return;
    if (demo) {
      clearWidget();
      return;
    }
    const accts = accounts.data;
    if (!accts) return;
    const visible = accts.filter((account) => !account.hidden);
    const syncedNetWorth = visible.reduce((sum, account) => sum + account.balance, 0);
    const netWorth = syncedNetWorth + (manual.data?.assets ?? 0) - (manual.data?.liabilities ?? 0);

    const months = trends.data?.months ?? [];
    let change = '';
    let changeUp = true;
    if (months.length >= 2) {
      const prevNW = months[months.length - 2].netWorth;
      const diff = syncedNetWorth - prevNW;
      changeUp = diff >= 0;
      change = `${diff >= 0 ? '+' : '-'}${fmtPos(diff)} this mo`;
    }

    const nextBill = (bills.data?.bills ?? []).find((b) => !b.paid);
    pushWidget({
      netWorth: fmtMoney(netWorth),
      change,
      changeUp,
      billPayee: nextBill ? nextBill.payee : 'All caught up',
      billAmount: nextBill ? fmtPos(nextBill.amount) : '',
      billDue: nextBill ? dueLabel(nextBill.dueDate) : 'No bills due',
    });
  }, [accounts.data, bills.data, demo, manual.data, trends.data]);

  return null;
}
