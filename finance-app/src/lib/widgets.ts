export type WidgetPayload = {
  netWorth: string;
  change: string;
  changeUp: boolean;
  billPayee: string;
  billAmount: string;
  billDue: string;
};

export function clearFinanceWidget(): void {
  pushFinanceWidget({
    netWorth: '—',
    change: '',
    changeUp: true,
    billPayee: 'Open DarkFinances',
    billAmount: '',
    billDue: 'Connect to refresh',
  });
}

export function pushFinanceWidget(payload: WidgetPayload): void {
  try {
    // eslint-disable-next-line @typescript-eslint/no-require-imports
    const mod = require('../widgets/FinanceWidget') as typeof import('../widgets/FinanceWidget');
    mod.updateFinanceWidget(payload);
  } catch {
    /* widget native module unavailable on this build — ignore */
  }
}
