import { useCallback, useMemo, useRef, useState } from 'react';
import type { UseMutationResult } from '@tanstack/react-query';
import type { FinanceError } from '@/api/client/requests';
import { mapClientValidationOutcome, mapMutationApiError } from '@/lib/mutation-form-errors';
import type { MappedMutationOutcome } from '@/lib/mutation-form-errors';
import { runStaleRefetch, staleConflictNotice } from '@/lib/mutation-refetch';

export type RefetchStaleData = () => void | boolean | Promise<boolean | void | unknown>;

export interface MutationScreenActionOptions<TVariables> {
  key: string;
  mutation: UseMutationResult<unknown, FinanceError, TVariables>;
  mutationLabel?: string;
  fieldPathOverrides?: Record<string, string>;
  fieldOrder?: string[];
}

export interface MutationScreenRunOptions {
  onSuccess?: (data: unknown) => void;
  onSettled?: () => void;
  onError?: (error: FinanceError) => void;
  /** Roll back optimistic UI when the mutation fails. */
  rollback?: () => void;
}

export interface MutationScreenAction<TVariables> {
  run: (variables: TVariables, options?: MutationScreenRunOptions) => void;
  isPending: boolean;
}

export interface UseMutationScreenOptions {
  onRefetchStale?: RefetchStaleData;
}

export interface UseMutationScreenResult {
  outcome: MappedMutationOutcome | null;
  summary: string | null;
  announce: string;
  isLocked: boolean;
  activeKey: string | null;
  bind: <TVariables>(options: MutationScreenActionOptions<TVariables>) => MutationScreenAction<TVariables>;
  retry: () => void;
  clear: () => void;
  refetchStale: () => Promise<void>;
  reportClientValidation: (summary: string, fieldErrors?: Record<string, string>, fieldOrder?: string[]) => void;
}

export function useMutationScreen(options: UseMutationScreenOptions = {}): UseMutationScreenResult {
  const [outcome, setOutcome] = useState<MappedMutationOutcome | null>(null);
  const [announce, setAnnounce] = useState('');
  const [activeKey, setActiveKey] = useState<string | null>(null);
  const [pendingKeys, setPendingKeys] = useState<Set<string>>(() => new Set());

  /** Synchronous guard — React pending state updates are too late for double-tap prevention. */
  const pendingLockRef = useRef(0);

  const registryRef = useRef(new Map<string, {
    mutation: UseMutationResult<unknown, FinanceError, unknown>;
    label: string;
    lastVars: unknown | null;
    lastSuccess?: (data: unknown) => void;
    lastSettled?: () => void;
    lastError?: (error: FinanceError) => void;
    rollback?: () => void;
    fieldPathOverrides?: Record<string, string>;
    fieldOrder?: string[];
  }>());

  const markPending = useCallback((key: string, pending: boolean) => {
    setPendingKeys((prev) => {
      const next = new Set(prev);
      if (pending) next.add(key);
      else next.delete(key);
      return next;
    });
  }, []);

  const handleError = useCallback(async (
    key: string,
    error: FinanceError,
    entry: NonNullable<ReturnType<typeof registryRef.current.get>>,
  ) => {
    entry.lastError?.(error);
    entry.rollback?.();
    const mapped = mapMutationApiError(error, {
      mutationLabel: entry.label,
      fieldPathOverrides: entry.fieldPathOverrides,
      fieldOrder: entry.fieldOrder,
    });
    setActiveKey(key);
    setOutcome(mapped);
    setAnnounce(mapped.announce);
    if (mapped.requiresRefetch) {
      const ok = await runStaleRefetch(options.onRefetchStale);
      if (ok && (mapped.kind === 'conflict_stale' || mapped.kind === 'conflict_saga' || mapped.kind === 'conflict_ownership')) {
        setOutcome({ ...mapped, summary: staleConflictNotice(mapped.summary) });
      }
    }
  }, [options]);

  const dispatch = useCallback((
    key: string,
    variables: unknown,
    runOptions?: MutationScreenRunOptions,
  ) => {
    const entry = registryRef.current.get(key);
    if (!entry || pendingLockRef.current > 0) return;

    pendingLockRef.current += 1;
    entry.lastVars = variables;
    entry.lastSuccess = runOptions?.onSuccess;
    entry.lastSettled = runOptions?.onSettled;
    entry.lastError = runOptions?.onError;
    entry.rollback = runOptions?.rollback;
    setActiveKey(key);
    setOutcome(null);
    setAnnounce('');
    markPending(key, true);

    entry.mutation.mutate(variables, {
      onSuccess: (data) => {
        setOutcome(null);
        setAnnounce(`${entry.label} succeeded.`);
        runOptions?.onSuccess?.(data);
      },
      onError: (error) => {
        void handleError(key, error, entry);
      },
      onSettled: () => {
        pendingLockRef.current = Math.max(0, pendingLockRef.current - 1);
        markPending(key, false);
        runOptions?.onSettled?.();
      },
    });
  }, [handleError, markPending]);

  const bind = useCallback(<TVariables,>(actionOptions: MutationScreenActionOptions<TVariables>): MutationScreenAction<TVariables> => {
    const existing = registryRef.current.get(actionOptions.key);
    const entry = existing ?? {
      mutation: actionOptions.mutation as UseMutationResult<unknown, FinanceError, unknown>,
      label: actionOptions.mutationLabel ?? 'Update',
      lastVars: null as unknown,
      fieldPathOverrides: actionOptions.fieldPathOverrides,
      fieldOrder: actionOptions.fieldOrder,
    };
    entry.mutation = actionOptions.mutation as UseMutationResult<unknown, FinanceError, unknown>;
    entry.label = actionOptions.mutationLabel ?? 'Update';
    entry.fieldPathOverrides = actionOptions.fieldPathOverrides;
    entry.fieldOrder = actionOptions.fieldOrder;
    registryRef.current.set(actionOptions.key, entry);
    return {
      run: (variables, runOptions) => dispatch(actionOptions.key, variables, runOptions),
      isPending: actionOptions.mutation.isPending,
    };
  }, [dispatch]);

  const isLocked = pendingKeys.size > 0;

  const retry = useCallback(() => {
    if (isLocked || !activeKey) return;
    const entry = registryRef.current.get(activeKey);
    if (!entry?.lastVars) return;
    dispatch(activeKey, entry.lastVars, {
      onSuccess: entry.lastSuccess,
      onSettled: entry.lastSettled,
      onError: entry.lastError,
      rollback: entry.rollback,
    });
  }, [activeKey, dispatch, isLocked]);

  const clear = useCallback(() => {
    setOutcome(null);
    setAnnounce('');
  }, []);

  const refetchStale = useCallback(async () => {
    const ok = await runStaleRefetch(options.onRefetchStale);
    if (ok) clear();
  }, [clear, options]);

  const reportClientValidation = useCallback((summary: string, fieldErrors: Record<string, string> = {}, fieldOrder: string[] = []) => {
    const mapped = mapClientValidationOutcome(fieldErrors, fieldOrder);
    setActiveKey(null);
    setOutcome({ ...mapped, summary });
    setAnnounce(summary);
  }, []);

  return useMemo(() => ({
    outcome,
    summary: outcome?.summary ?? null,
    announce,
    isLocked,
    activeKey,
    bind,
    retry,
    clear,
    refetchStale,
    reportClientValidation,
  }), [activeKey, announce, bind, clear, isLocked, outcome, refetchStale, reportClientValidation, retry]);
}
