import React, { createContext, useCallback, useContext, useEffect, useMemo, useSyncExternalStore } from 'react';
import { AppState } from 'react-native';
import { usePing } from '@/api/hooks/finance.hooks';
import { subscribeFinanceDateAppState } from '@/lib/finance-date-app-state';
import {
  applyEditableFinanceDateSync,
  createEditableFinanceDateState,
  getFinanceDateStore,
} from '@/lib/finance-date-store';

type FinanceDateSnapshot = {
  timeZone: string;
  today: string;
  revision: number;
};

type FinanceDateContextValue = FinanceDateSnapshot & {
  setTimeZone: (zone: string) => void;
};

const FinanceDateContext = createContext<FinanceDateContextValue | null>(null);

export function FinanceDateProvider({ children }: { children: React.ReactNode }) {
  const store = getFinanceDateStore();
  const ping = usePing();

  useEffect(() => {
    if (ping.data?.financeTimeZone) store.setTimeZone(ping.data.financeTimeZone);
  }, [ping.data?.financeTimeZone, store]);

  useEffect(() => {
    const id = setInterval(() => store.tick(), 60_000);
    return () => clearInterval(id);
  }, [store]);

  useEffect(() => subscribeFinanceDateAppState(store, AppState), [store]);

  useEffect(() => {
    store.tick();
  }, [store]);

  const snapshot = useSyncExternalStore(
    useCallback((listener) => store.subscribe(listener), [store]),
    () => store.getSnapshot(),
    () => store.getSnapshot(),
  );

  const value = useMemo<FinanceDateContextValue>(() => ({
    ...snapshot,
    setTimeZone: (zone: string) => store.setTimeZone(zone),
  }), [snapshot, store]);

  return <FinanceDateContext.Provider value={value}>{children}</FinanceDateContext.Provider>;
}

export function useFinanceDate(): FinanceDateContextValue {
  const ctx = useContext(FinanceDateContext);
  if (!ctx) throw new Error('useFinanceDate must be used within FinanceDateProvider');
  return ctx;
}

export function useFinanceToday(): string {
  return useFinanceDate().today;
}

export function useEditableFinanceDate(initial?: string) {
  const snapshot = useFinanceDate();
  const [state, setState] = React.useState(() => createEditableFinanceDateState(initial ?? snapshot.today));

  const synced = applyEditableFinanceDateSync(state, snapshot);
  if (!Object.is(synced, state)) {
    setState(synced);
  }

  const setEditableValue = useCallback((next: string) => {
    setState((prev) => ({ ...prev, value: next, dirty: true }));
  }, []);

  const resetToToday = useCallback(() => {
    setState({ value: snapshot.today, dirty: false, baseline: snapshot.today });
  }, [snapshot.today]);

  return { value: state.value, setValue: setEditableValue, dirty: state.dirty, resetToToday, today: snapshot.today };
}
