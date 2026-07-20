import { useCallback, useEffect, useRef, useState } from 'react';
import type { UseMutationResult } from '@tanstack/react-query';
import type { FinanceError } from '@/api/client/requests';
import { mapMutationApiError } from '@/lib/mutation-form-errors';
import type { MappedMutationOutcome } from '@/lib/mutation-form-errors';
import { nextMutationActivationSeq } from '@/lib/mutation-activation-sequence';
import { runStaleRefetch, staleConflictNotice } from '@/lib/mutation-refetch';
import {
  awaitMutationErrorReconciliation,
  startMutationErrorReconciliation,
} from '@/lib/mutation-error-reconciliation';
import { safeMutationCallback } from '@/lib/mutation-safe-callback';
import { useMutationAdmissionLifecycle } from '@/hooks/useMutationAdmissionLifecycle';
import { useMutationHookIdentity } from '@/hooks/useMutationHookIdentity';
import type { MutationAdmissionRef } from '@/hooks/useMutationScreenAdmission';

export interface UseMutationActionOptions<TVariables> {
  mutation: UseMutationResult<unknown, FinanceError, TVariables>;
  mutationLabel?: string;
  onSuccess?: () => void;
  onRefetch?: () => void | Promise<unknown>;
  onActivate?: () => void;
  fieldPathOverrides?: Record<string, string>;
  fieldOrder?: string[];
  admissionRef?: MutationAdmissionRef;
}

export interface UseMutationActionResult<TVariables> {
  outcome: MappedMutationOutcome | null;
  summary: string | null;
  isLocked: boolean;
  activitySeq: number;
  announce: string;
  run: (variables: TVariables, options?: { onSuccess?: (data: unknown) => void; onSettled?: () => void; rollback?: () => void }) => void;
  retry: () => void;
  clear: () => void;
}

export function useMutationAction<TVariables>({
  mutation,
  mutationLabel = 'Update',
  onSuccess,
  onRefetch,
  onActivate,
  fieldPathOverrides,
  fieldOrder,
  admissionRef,
}: UseMutationActionOptions<TVariables>): UseMutationActionResult<TVariables> {
  const identity = useMutationHookIdentity();
  const {
    identityKey,
    dispatchPending,
    setDispatchPending,
    captureDispatchToken,
    isDispatchTokenCurrent,
  } = identity;
  const pendingLockRef = identity.pendingLockRef as React.MutableRefObject<boolean>;
  const { acquireAdmission, releaseAdmissionForLease } = useMutationAdmissionLifecycle(admissionRef, identityKey);

  const [outcome, setOutcome] = useState<MappedMutationOutcome | null>(null);
  const [announce, setAnnounce] = useState('');
  const [activitySeq, setActivitySeq] = useState(0);
  const lastVars = useRef<TVariables | null>(null);
  const lastSuccess = useRef<((data: unknown) => void) | undefined>(undefined);
  const lastRollback = useRef<(() => void) | undefined>(undefined);
  const lastSettled = useRef<(() => void) | undefined>(undefined);

  const bumpActivity = useCallback(() => {
    const seq = nextMutationActivationSeq();
    setActivitySeq(seq);
    return seq;
  }, []);

  useEffect(() => {
    // Profile/form identity reset clears stale action UI.
    // eslint-disable-next-line react-hooks/set-state-in-effect -- intentional reset on identity change
    setOutcome(null);
    setAnnounce('');
    lastVars.current = null;
    lastSuccess.current = undefined;
    lastRollback.current = undefined;
    lastSettled.current = undefined;
  }, [identityKey]);

  const isLocked = dispatchPending;

  const clear = useCallback(() => {
    setOutcome(null);
    setAnnounce('');
    lastVars.current = null;
    lastSuccess.current = undefined;
    lastRollback.current = undefined;
    lastSettled.current = undefined;
  }, []);

  const run = useCallback((variables: TVariables, options?: { onSuccess?: (data: unknown) => void; onSettled?: () => void; rollback?: () => void }) => {
    if (pendingLockRef.current) return;
    const lease = acquireAdmission();
    if (lease == null) return;
    const token = captureDispatchToken();
    pendingLockRef.current = true;
    setDispatchPending(true);
    bumpActivity();
    safeMutationCallback(onActivate);
    lastVars.current = variables;
    lastSuccess.current = options?.onSuccess;
    lastRollback.current = options?.rollback;
    lastSettled.current = options?.onSettled;
    setOutcome(null);
    let errorReconciliation: Promise<void> | null = null;
    try {
      mutation.mutate(variables, {
        onSuccess: (data) => {
          if (!isDispatchTokenCurrent(token)) return;
          lastVars.current = null;
          lastSuccess.current = undefined;
          lastRollback.current = undefined;
          lastSettled.current = undefined;
          setOutcome(null);
          setAnnounce(`${mutationLabel} succeeded.`);
          safeMutationCallback(options?.onSuccess, data);
          safeMutationCallback(onSuccess);
        },
        onError: (error) => {
          errorReconciliation = startMutationErrorReconciliation(async () => {
            if (!isDispatchTokenCurrent(token)) return;
            safeMutationCallback(lastRollback.current);
            const mapped = mapMutationApiError(error, { fieldPathOverrides, fieldOrder, mutationLabel });
            setOutcome(mapped);
            setAnnounce(mapped.announce);
            if (mapped.requiresRefetch) {
              const ok = await runStaleRefetch(onRefetch);
              if (!isDispatchTokenCurrent(token)) return;
              if (ok && (mapped.kind === 'conflict_stale' || mapped.kind === 'conflict_saga' || mapped.kind === 'conflict_ownership')) {
                setOutcome({ ...mapped, summary: staleConflictNotice(mapped.summary) });
              }
            }
          });
        },
        onSettled: async () => {
          await awaitMutationErrorReconciliation(errorReconciliation);
          releaseAdmissionForLease(lease);
          if (!isDispatchTokenCurrent(token)) return;
          pendingLockRef.current = false;
          setDispatchPending(false);
          safeMutationCallback(options?.onSettled);
        },
      });
    } catch (error) {
      releaseAdmissionForLease(lease);
      pendingLockRef.current = false;
      setDispatchPending(false);
      throw error;
    }
  }, [
    acquireAdmission,
    bumpActivity,
    captureDispatchToken,
    fieldOrder,
    fieldPathOverrides,
    isDispatchTokenCurrent,
    mutation,
    mutationLabel,
    onActivate,
    onRefetch,
    onSuccess,
    pendingLockRef,
    releaseAdmissionForLease,
    setDispatchPending,
  ]);

  const retry = useCallback(() => {
    if (pendingLockRef.current || lastVars.current == null) return;
    run(lastVars.current, {
      onSuccess: lastSuccess.current,
      rollback: lastRollback.current,
      onSettled: lastSettled.current,
    });
  }, [pendingLockRef, run]);

  return {
    outcome,
    summary: outcome?.summary ?? null,
    isLocked,
    activitySeq,
    announce,
    run,
    retry,
    clear,
  };
}
