import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import type { UseMutationResult } from '@tanstack/react-query';
import type { FinanceError } from '@/api/client/requests';
import { mapClientValidationOutcome, mapMutationApiError } from '@/lib/mutation-form-errors';
import type { MappedMutationOutcome } from '@/lib/mutation-form-errors';
import { nextMutationActivationSeq } from '@/lib/mutation-activation-sequence';
import { hapticClientValidationRejected } from '@/lib/haptics';
import { runStaleRefetch, staleConflictNotice } from '@/lib/mutation-refetch';
import {
  awaitMutationErrorReconciliation,
  startMutationErrorReconciliation,
} from '@/lib/mutation-error-reconciliation';
import { safeMutationCallback } from '@/lib/mutation-safe-callback';
import { useMutationAdmissionLifecycle } from '@/hooks/useMutationAdmissionLifecycle';
import { useMutationHookIdentity } from '@/hooks/useMutationHookIdentity';
import type { MutationDispatchToken } from '@/hooks/useMutationHookIdentity';
import type { MutationAdmissionRef } from '@/hooks/useMutationScreenAdmission';

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
  admissionRef?: MutationAdmissionRef;
}

export interface UseMutationScreenResult {
  outcome: MappedMutationOutcome | null;
  summary: string | null;
  announce: string;
  isLocked: boolean;
  activitySeq: number;
  activeKey: string | null;
  bind: <TVariables>(options: MutationScreenActionOptions<TVariables>) => MutationScreenAction<TVariables>;
  retry: () => void;
  clear: () => void;
  refetchStale: () => Promise<void>;
  reportClientValidation: (summary: string, fieldErrors?: Record<string, string>, fieldOrder?: string[]) => void;
}

export function useMutationScreen(options: UseMutationScreenOptions = {}): UseMutationScreenResult {
  const admissionRef = options.admissionRef;
  const {
    identityKey,
    pendingLockRef,
    captureDispatchToken,
    isDispatchTokenCurrent,
    setDispatchPending,
  } = useMutationHookIdentity({ pendingLockKind: 'counter' });
  const pendingLockCountRef = pendingLockRef as React.MutableRefObject<number>;
  const { acquireAdmission, releaseAdmissionForLease } = useMutationAdmissionLifecycle(admissionRef, identityKey);

  const [outcome, setOutcome] = useState<MappedMutationOutcome | null>(null);
  const [announce, setAnnounce] = useState('');
  const [activeKey, setActiveKey] = useState<string | null>(null);
  const [pendingKeys, setPendingKeys] = useState<Set<string>>(() => new Set());
  const [activitySeq, setActivitySeq] = useState(0);

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

  const bumpActivity = useCallback(() => {
    const seq = nextMutationActivationSeq();
    setActivitySeq(seq);
    return seq;
  }, []);

  useEffect(() => {
    // Profile identity reset clears stale screen mutation UI and pending key locks.
    // eslint-disable-next-line react-hooks/set-state-in-effect -- intentional reset on identity change
    setOutcome(null);
    setAnnounce('');
    setActiveKey(null);
    setPendingKeys(new Set());
    for (const entry of registryRef.current.values()) {
      entry.lastVars = null;
      entry.lastSuccess = undefined;
      entry.lastSettled = undefined;
      entry.lastError = undefined;
      entry.rollback = undefined;
    }
  }, [identityKey]);

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
    token: MutationDispatchToken,
  ) => {
    if (!isDispatchTokenCurrent(token)) return;
    safeMutationCallback(entry.lastError, error);
    safeMutationCallback(entry.rollback);
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
      if (!isDispatchTokenCurrent(token)) return;
      if (ok && (mapped.kind === 'conflict_stale' || mapped.kind === 'conflict_saga' || mapped.kind === 'conflict_ownership')) {
        setOutcome({ ...mapped, summary: staleConflictNotice(mapped.summary) });
      }
    }
  }, [isDispatchTokenCurrent, options]);

  const dispatch = useCallback((
    key: string,
    variables: unknown,
    runOptions?: MutationScreenRunOptions,
  ) => {
    const entry = registryRef.current.get(key);
    if (!entry || pendingLockCountRef.current > 0) return;
    const lease = acquireAdmission();
    if (lease == null) return;

    const token = captureDispatchToken();
    pendingLockCountRef.current += 1;
    setDispatchPending(true);
    bumpActivity();
    entry.lastVars = variables;
    entry.lastSuccess = runOptions?.onSuccess;
    entry.lastSettled = runOptions?.onSettled;
    entry.lastError = runOptions?.onError;
    entry.rollback = runOptions?.rollback;
    setActiveKey(key);
    setOutcome(null);
    setAnnounce('');
    markPending(key, true);

    try {
      let errorReconciliation: Promise<void> | null = null;
      entry.mutation.mutate(variables, {
        onSuccess: (data) => {
          if (!isDispatchTokenCurrent(token)) return;
          entry.lastVars = null;
          entry.lastSuccess = undefined;
          entry.lastSettled = undefined;
          entry.lastError = undefined;
          entry.rollback = undefined;
          setOutcome(null);
          setAnnounce(`${entry.label} succeeded.`);
          setActiveKey(null);
          safeMutationCallback(runOptions?.onSuccess, data);
        },
        onError: (error) => {
          errorReconciliation = startMutationErrorReconciliation(() => handleError(key, error, entry, token));
        },
        onSettled: async () => {
          await awaitMutationErrorReconciliation(errorReconciliation);
          releaseAdmissionForLease(lease);
          if (!isDispatchTokenCurrent(token)) return;
          pendingLockCountRef.current = Math.max(0, pendingLockCountRef.current - 1);
          markPending(key, false);
          if (pendingLockCountRef.current === 0) {
            setDispatchPending(false);
          }
          safeMutationCallback(runOptions?.onSettled);
        },
      });
    } catch (error) {
      releaseAdmissionForLease(lease);
      pendingLockCountRef.current = Math.max(0, pendingLockCountRef.current - 1);
      markPending(key, false);
      if (pendingLockCountRef.current === 0) {
        setDispatchPending(false);
      }
      throw error;
    }
  }, [acquireAdmission, bumpActivity, captureDispatchToken, handleError, isDispatchTokenCurrent, markPending, pendingLockCountRef, releaseAdmissionForLease, setDispatchPending]);

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
      isPending: pendingKeys.has(actionOptions.key),
    };
  }, [dispatch, pendingKeys]);

  const isLocked = pendingKeys.size > 0;

  const retry = useCallback(() => {
    if (isLocked || !activeKey) return;
    const entry = registryRef.current.get(activeKey);
    if (entry?.lastVars == null) return;
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
    setActiveKey(null);
    for (const entry of registryRef.current.values()) {
      entry.lastVars = null;
      entry.lastSuccess = undefined;
      entry.lastSettled = undefined;
      entry.lastError = undefined;
      entry.rollback = undefined;
    }
  }, []);

  const refetchStale = useCallback(async () => {
    const ok = await runStaleRefetch(options.onRefetchStale);
    if (ok) clear();
  }, [clear, options]);

  const reportClientValidation = useCallback((summary: string, fieldErrors: Record<string, string> = {}, fieldOrder: string[] = []) => {
    bumpActivity();
    const mapped = mapClientValidationOutcome(fieldErrors, fieldOrder);
    setActiveKey(null);
    setOutcome({ ...mapped, summary });
    setAnnounce(summary);
    hapticClientValidationRejected();
  }, [bumpActivity]);

  return useMemo(() => ({
    outcome,
    summary: outcome?.summary ?? null,
    announce,
    isLocked,
    activitySeq,
    activeKey,
    bind,
    retry,
    clear,
    refetchStale,
    reportClientValidation,
  }), [activeKey, activitySeq, announce, bind, clear, isLocked, outcome, refetchStale, reportClientValidation, retry]);
}
