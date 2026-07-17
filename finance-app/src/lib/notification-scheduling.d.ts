export type BillReminderKind = 'dayBefore' | 'sameDayLate' | 'overdue';

export function billSameDayKey(scope: string, billKey: string, dueDate: string): string;

export function legacyBillSameDayKey(billKey: string, dueDate: string): string;

export function classifyBillReminder(
  bill: { key: string; dueDate: string; paid?: boolean },
  now?: number,
  scope?: string,
  financeTodayAnchor?: string,
): {
  kind: BillReminderKind;
  triggerDate: Date | null;
  sameDayKey: string | null;
} | null;
