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
}: UseMutationActionOptions<TVariables>): UseMutationActionResult<TVariables> {
  const [outcome, setOutcome] = useState<MappedMutationOutcome | null>(null);
  const [announce, setAnnounce] = useState('');
  const lastVars = useRef<TVariables | null>(null);
  const lastSuccess = useRef<((data: unknown) => void) | undefined>(undefined);

  const lastRollback = useRef<(() => void) | undefined>(undefined);

  const isLocked = mutation.isPending;

  const run = useCallback((variables: TVariables, options?: { onSuccess?: (data: unknown) => void; onSettled?: () => void; rollback?: () => void }) => {
    if (isLocked) return;
    lastVars.current = variables;
    lastSuccess.current = options?.onSuccess;
    lastRollback.current = options?.rollback;
    setOutcome(null);
    mutation.mutate(variables, {
      onSuccess: (data) => {
        setOutcome(null);
        setAnnounce(`${mutationLabel} succeeded.`);
        options?.onSuccess?.(data);
        onSuccess?.();
      },
      onError: async (error) => {
        lastRollback.current?.();
        const mapped = mapMutationApiError(error, { fieldPathOverrides, mutationLabel });
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
        options?.onSettled?.();
      },
    });
  }, [fieldPathOverrides, isLocked, mutation, mutationLabel, onRefetch, onSuccess]);

  const retry = useCallback(() => {
    if (isLocked || lastVars.current == null) return;
    run(lastVars.current, { onSuccess: lastSuccess.current, rollback: lastRollback.current });
  }, [isLocked, run]);

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
