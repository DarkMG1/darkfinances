import { useCallback, useRef, useState } from 'react';
import type { UseMutationResult } from '@tanstack/react-query';
import type { FinanceError } from '@/api/client/requests';
import { mapMutationApiError } from '@/lib/mutation-form-errors';
import type { MappedMutationOutcome } from '@/lib/mutation-form-errors';
import { runStaleRefetch, staleConflictNotice } from '@/lib/mutation-refetch';

export interface UseMutationActionOptions<TVariables> {
  mutation: UseMutationResult<unknown, FinanceError, TVariables>;
  mutationLabel?: string;
  onSuccess?: () => void;
  onRefetch?: () => void | Promise<unknown>;
  fieldPathOverrides?: Record<string, string>;
  fieldOrder?: string[];
}

export interface UseMutationActionResult<TVariables> {
  outcome: MappedMutationOutcome | null;
  summary: string | null;
  isLocked: boolean;
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
  fieldPathOverrides,
  fieldOrder,
}: UseMutationActionOptions<TVariables>): UseMutationActionResult<TVariables> {
  const [outcome, setOutcome] = useState<MappedMutationOutcome | null>(null);
  const [announce, setAnnounce] = useState('');
  const [dispatchPending, setDispatchPending] = useState(false);
  const lastVars = useRef<TVariables | null>(null);
  const lastSuccess = useRef<((data: unknown) => void) | undefined>(undefined);
  const lastRollback = useRef<(() => void) | undefined>(undefined);
  /** Synchronous guard before React Query marks the mutation pending. */
  const pendingLockRef = useRef(false);

  const isLocked = mutation.isPending || dispatchPending;

  const run = useCallback((variables: TVariables, options?: { onSuccess?: (data: unknown) => void; onSettled?: () => void; rollback?: () => void }) => {
    if (pendingLockRef.current || mutation.isPending) return;
    pendingLockRef.current = true;
    setDispatchPending(true);
    lastVars.current = variables;
    lastSuccess.current = options?.onSuccess;
    lastRollback.current = options?.rollback;
    setOutcome(null);
    mutation.mutate(variables, {
      onSuccess: (data) => {
        lastVars.current = null;
        lastSuccess.current = undefined;
        lastRollback.current = undefined;
        setOutcome(null);
        setAnnounce(`${mutationLabel} succeeded.`);
        options?.onSuccess?.(data);
        onSuccess?.();
      },
      onError: async (error) => {
        lastRollback.current?.();
        const mapped = mapMutationApiError(error, { fieldPathOverrides, fieldOrder, mutationLabel });
        setOutcome(mapped);
        setAnnounce(mapped.announce);
        if (mapped.requiresRefetch) {
          const ok = await runStaleRefetch(onRefetch);
          if (ok && (mapped.kind === 'conflict_stale' || mapped.kind === 'conflict_saga' || mapped.kind === 'conflict_ownership')) {
            setOutcome({ ...mapped, summary: staleConflictNotice(mapped.summary) });
          }
        }
      },
      onSettled: () => {
        pendingLockRef.current = false;
        setDispatchPending(false);
        options?.onSettled?.();
      },
    });
  }, [fieldOrder, fieldPathOverrides, mutation, mutationLabel, onRefetch, onSuccess]);

  const retry = useCallback(() => {
    if (pendingLockRef.current || mutation.isPending || lastVars.current == null) return;
    run(lastVars.current, { onSuccess: lastSuccess.current, rollback: lastRollback.current });
  }, [mutation.isPending, run]);

  const clear = useCallback(() => {
    setOutcome(null);
    setAnnounce('');
  }, []);

  return {
    outcome,
    summary: outcome?.summary ?? null,
    isLocked,
    announce,
    run,
    retry,
    clear,
  };
}
