import { useSyncExternalStore } from 'react';

const monthKey = (d: Date): string => `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}`;

// A single "which month am I browsing" value shared across the Spending and
// Budgets screens, so stepping months in one is reflected in the other. Kept as
// a concrete YYYY-MM; each screen maps its own current month to `undefined` for
// the warmed caches.
let selected = monthKey(new Date());
const listeners = new Set<() => void>();

export function setSelectedMonth(month: string): void {
  if (month === selected) return;
  selected = month;
  listeners.forEach((l) => l());
}

function subscribe(cb: () => void): () => void {
  listeners.add(cb);
  return () => {
    listeners.delete(cb);
  };
}

export function useSelectedMonth(): [string, (m: string) => void] {
  const month = useSyncExternalStore(
    subscribe,
    () => selected,
    () => selected
  );
  return [month, setSelectedMonth];
}

export const currentMonthKey = (): string => monthKey(new Date());
