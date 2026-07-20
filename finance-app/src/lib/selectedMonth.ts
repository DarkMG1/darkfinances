import { useEffect, useSyncExternalStore } from 'react';
import { getFinanceDateStore } from '@/lib/finance-date-store';
import { useFinanceToday } from '@/lib/date-only';

let lastCurrent = getFinanceDateStore().getSnapshot().today.slice(0, 7);
let selected = lastCurrent;
const listeners = new Set<() => void>();

export function setSelectedMonth(month: string): void {
  if (month === selected) return;
  selected = month;
  listeners.forEach((l) => l());
}

function subscribeSelected(cb: () => void): () => void {
  listeners.add(cb);
  return () => {
    listeners.delete(cb);
  };
}

function syncMonthRollover(current: string) {
  if (current === lastCurrent) return;
  const followedCurrent = selected === lastCurrent;
  lastCurrent = current;
  if (followedCurrent) setSelectedMonth(current);
}

export function useCurrentMonthKey(): string {
  return useFinanceToday().slice(0, 7);
}

export function useSelectedMonth(): [string, (m: string) => void] {
  const current = useCurrentMonthKey();

  useEffect(() => {
    syncMonthRollover(current);
  }, [current]);

  const month = useSyncExternalStore(
    subscribeSelected,
    () => selected,
    () => selected,
  );
  return [month, setSelectedMonth];
}

/** @deprecated Prefer `useCurrentMonthKey()` in React components. */
export const currentMonthKey = (): string => getFinanceDateStore().getSnapshot().today.slice(0, 7);
