import { useEffect, useSyncExternalStore } from 'react';
import { AppState } from 'react-native';
import { financeToday } from '@/lib/date-only';

const financeMonth = (): string => financeToday().slice(0, 7);

// A single "which month am I browsing" value shared across the Spending and
// Budgets screens, so stepping months in one is reflected in the other. Kept as
// a concrete YYYY-MM; each screen maps its own current month to `undefined` for
// the warmed caches.
let lastCurrent = financeMonth();
let selected = lastCurrent;
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

function syncMonthRollover() {
  const current = financeMonth();
  if (current === lastCurrent) return;
  const followedCurrent = selected === lastCurrent;
  lastCurrent = current;
  if (followedCurrent) setSelectedMonth(current);
}

export function useSelectedMonth(): [string, (m: string) => void] {
  useEffect(() => {
    syncMonthRollover();
    const timer = setInterval(syncMonthRollover, 60_000);
    const appState = AppState.addEventListener('change', (state) => {
      if (state === 'active') syncMonthRollover();
    });
    return () => {
      clearInterval(timer);
      appState.remove();
    };
  }, []);
  const month = useSyncExternalStore(
    subscribe,
    () => selected,
    () => selected
  );
  return [month, setSelectedMonth];
}

export const currentMonthKey = (): string => financeMonth();
